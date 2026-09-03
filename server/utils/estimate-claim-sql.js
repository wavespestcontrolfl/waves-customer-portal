/**
 * SQL mirrors of the delivery-claim / linkage-invalidation markers.
 *
 * Every whole-blob `estimate_data` write (proposal save, revise, public
 * select-tier / preferences / bond-term) must refuse to run while a marker
 * or a LIVE delivery claim is present — a blind rewrite erases them, after
 * which claim cleanup no-ops and wrong-lead content stays public and
 * sendable (PR #3304).
 *
 * Dependency-free on purpose: these fragments are imported by routes whose
 * tests mock the persistence layer, and a partial mock must never turn a
 * guard into `undefined`.
 */

// Keep in lockstep with ESTIMATE_DELIVERY_CLAIM_TTL_MS in
// services/admin-estimate-persistence.js (same env-free default).
const ESTIMATE_DELIVERY_CLAIM_TTL_MS = 10 * 60 * 1000;

// A claim blocks a write only while it is LIVE. Without the TTL arm, a
// process that died after stamping delivering_at — but before recording any
// invalidation — left the keys forever and permanently blocked edits.
const DELIVERY_CLAIM_NOT_LIVE_SQL = `(
  COALESCE(estimate_data->'estimatorEngine'->>'delivering_at', '') = ''
  OR (estimate_data->'estimatorEngine'->>'delivering_at') !~ '^[0-9]{4}-'
  OR (estimate_data->'estimatorEngine'->>'delivering_at')::timestamptz
       < NOW() - (INTERVAL '1 millisecond' * ${ESTIMATE_DELIVERY_CLAIM_TTL_MS})
)`;

const LINKAGE_INVALIDATION_ABSENT_SQL = "COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''";
// The clarify re-price hold (estimate-clarify-asks): a draft whose dollars
// or address are about to be corrected is not publishable — anchor OR
// grouped sibling (codex r1 P1 on #3804).
const REPRICE_PENDING_ABSENT_SQL = "COALESCE(estimate_data->'estimatorEngine'->>'reprice_pending_at', '') = ''";
const INVALIDATION_PENDING_ABSENT_SQL = "COALESCE(estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') = ''";

// The ONE in-flight verdict for a call's processing state — lives here
// (dependency-free) so both the persistence layer and this module's public
// money guard share it; admin-estimate-persistence re-exports it. A held
// claim token OR a queued retry lane counts: a retryable extraction_failed
// / pending / no_transcription row with a NULL token is NOT settled — the
// retry that will claim it can change the call's identity and linkage
// (pre-push P0, PR #3304 — the guard below treated the queue-to-claim
// window as settled and could disclose or charge during it).
const CALL_IN_FLIGHT_STATUSES = new Set(['processing', 'pending', 'no_transcription']);
const CALL_EXTRACTION_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.CALL_EXTRACTION_MAX_ATTEMPTS || '3', 10) || 3);
const CALL_EXTRACTION_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function callReprocessInFlight(callRow, nowMs = Date.now()) {
  if (callRow.processing_token != null) return true;
  const status = callRow.processing_status == null ? null : String(callRow.processing_status).toLowerCase();
  if (CALL_IN_FLIGHT_STATUSES.has(status)) return true;
  if (status === 'extraction_failed') {
    // Mirrors the sweep's own eligibility EXACTLY: attempts under the cap
    // AND inside the 7-day window. An exhausted or aged-out row is settled
    // — treating it as forever-retrying blocked send, accept, and decline
    // on its draft permanently.
    const attemptsLeft = (Number(callRow.extraction_attempts) || 0) < CALL_EXTRACTION_MAX_ATTEMPTS;
    const created = callRow.created_at ? Date.parse(callRow.created_at) : NaN;
    const withinWindow = !Number.isFinite(created) || (nowMs - created) < CALL_EXTRACTION_RETRY_WINDOW_MS;
    return attemptsLeft && withinWindow;
  }
  return false;
}

// Pass-identity fence for CALL-ORIGIN inserts (codex P1, PR #3304 —
// generation-rework GH round). Fence doctrine: token match = in-flight me;
// SAME generation = no newer claim since mine (survives this pass's own
// finalization). A composer carrying NEITHER identity (legacy entry
// points) has nothing to compare — it keeps its caller's existing
// behavior, so this returns owned. A MISSING call row is never owned:
// there is no provenance left to insert against. Callers must already
// hold the call row lock (and keep holding it through their insert) or
// the compare proves nothing.
async function callPassStillOwned(dbc, callLogId, { ownerProcToken = null, ownerProcGeneration = null } = {}) {
  if (!ownerProcToken && ownerProcGeneration == null) return true;
  const row = await dbc('call_log')
    .where({ id: callLogId })
    .first('processing_token', 'processing_generation');
  if (!row) return false;
  return (!!ownerProcToken && row.processing_token === ownerProcToken)
    || (ownerProcGeneration != null && row.processing_generation != null
      && Number(row.processing_generation) === Number(ownerProcGeneration));
}

// The DURABLE call-side verdict as seen from an ESTIMATE row: when a
// quarantine could not write its estimate-side marker, the block lives on
// the call, and the public surfaces — which only ever read the estimate —
// would keep serving a wrong-identity or rejected-call estimate through
// its bearer token until the scheduler drained the queue (codex P1, PR
// #3304 GH r9). Returns the blocking reason, or null. Cheap: one indexed
// lookup, and only for engine-drafted rows.
async function callSideBlockForEstimateData(dbc, data) {
  const callLogId = data?.estimatorEngine?.callLogId || null;
  if (!callLogId) return null;
  try {
    const row = await dbc('call_log').where({ id: callLogId })
      .first('metadata', 'processing_token', 'processing_status', 'extraction_attempts', 'created_at', 'twilio_call_sid');
    // A MISSING call row fails closed (codex P1, PR #3304 GH r10) — the
    // same verdict staleCallLinkageReason gives it: an engine draft whose
    // call is gone has no provenance left to validate.
    if (!row) return 'call_missing';
    const md = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    if (md?.estimator_draft_block?.reason) return String(md.estimator_draft_block.reason);
    if (md?.estimator_quarantine_pending?.reason) return String(md.estimator_quarantine_pending.reason);
    // An IN-FLIGHT call — a held claim token OR a queued retry lane — is
    // mid-decision: its block marker may be milliseconds (or one sweep)
    // away, and the marker read above ran before that write. The public
    // surfaces this guard protects must fail closed until the call
    // settles (local audit + pre-push P0s, PR #3304): the two markers
    // alone cover only verdicts that already persisted, and a NULL token
    // on a retryable row is a queue, not a settlement.
    if (callReprocessInFlight(row)) return 'call_reprocessing';
    // Live-linkage comparison for durably linked drafts (same P0): a
    // repoint whose estimate-side marker AND call-side marker both failed
    // to persist leaves only the linkage itself as evidence. Mirrors
    // staleCallLinkageReason's resolution order exactly — sid-owned lead
    // (created_at DESC) first, then the metadata stamp — so the two
    // guards can never disagree about the call's live owner.
    const linkedLeadId = data?.lead_id ? String(data.lead_id) : null;
    if (linkedLeadId && ['sid', 'stamp'].includes(data?.lead_linkage)) {
      let resolvedLeadId = null;
      if (row.twilio_call_sid) {
        const sidLead = await dbc('leads')
          .where({ twilio_call_sid: row.twilio_call_sid })
          .whereNull('deleted_at')
          .orderBy('created_at', 'desc')
          .first('id');
        if (sidLead) resolvedLeadId = String(sidLead.id);
      }
      if (!resolvedLeadId && md?.lead_id) {
        const stampLead = await dbc('leads')
          .where({ id: String(md.lead_id) })
          .whereNull('deleted_at')
          .first('id');
        if (stampLead) resolvedLeadId = String(stampLead.id);
      }
      if (resolvedLeadId !== linkedLeadId) return 'call_linkage_changed';
    }
    return null;
  } catch {
    // FAIL CLOSED (codex P1, PR #3304 GH r10): this lookup IS the fallback
    // guard for the case where the estimate-side marker could not be
    // written, so returning "no block" on a transient error would disclose
    // or mutate exactly the wrong-lead estimate it exists to protect.
    return 'call_verdict_unavailable';
  }
}

// ---------------------------------------------------------------------------
// Call-level UNIT-ANSWER fence (clarify write-back, PR C2 of the #3775
// split). When the caller texts back the apartment/unit a completed-call
// clarify ask requested, the reply handler stamps it on the call row —
// under that row's FOR UPDATE, in one transaction with the CRM writes —
// and EVERY call-origin draft creator reads it inside its own insert
// transaction while holding the same row lock (callRejectedForDrafting
// lockCallRow). A composer that built its context before the answer
// arrived therefore cannot insert a whole-building draft after the reply
// committed: it is blocked here and the unit re-run (which carries the
// answer) composes the replacement. The lock, not the phone dedupe lock,
// is what closes the window — creators hold the phone lock only around
// their insert, but the call row is locked by every creator in the same
// place (codex r5 P1 on #3785).
//
// Later composers (a force-reprocess weeks on) do not fight the fence:
// maybeDraftEstimateForCall ADOPTS a stamped answer into its context.
const CALL_UNIT_ANSWER_KEY = 'unit_answer';

async function stampCallUnitAnswer(dbc, callLogId, { unit, building = null, askDraftId = null } = {}) {
  if (!callLogId || !unit) return false;
  const payload = {
    unit: String(unit),
    building: building && building.street_line_1
      ? { street_line_1: building.street_line_1, city: building.city || null, postal_code: building.postal_code || null }
      : null,
    ask_draft_id: askDraftId ? String(askDraftId) : null,
    at: new Date().toISOString(),
  };
  const changed = await dbc('call_log')
    .where({ id: callLogId })
    .update({
      // Atomic JSONB path write: only this one key changes, so the
      // processor's claim/linkage stamps on the same column are never
      // overwritten by a stale blob.
      metadata: dbc.raw("jsonb_set(COALESCE(metadata, '{}'::jsonb), ?, ?::jsonb)", [`{${CALL_UNIT_ANSWER_KEY}}`, JSON.stringify(payload)]),
    });
  return Number(changed) > 0;
}

// The human verdict retires the fence: staff dismissing the
// missing_unit_number card (the whole building IS the service address, or
// the texted reply was wrong) removes the stamp, so creators stop adopting
// the rejected unit and the operator's building-level correction can lift
// a hold (codex r3 P1 on #3804). Same atomic one-key delete shape as the
// stamp.
async function clearCallUnitAnswer(dbc, callLogId) {
  if (!callLogId) return false;
  const changed = await dbc('call_log')
    .where({ id: callLogId })
    .whereRaw("COALESCE(metadata->>?, '') <> ''", [CALL_UNIT_ANSWER_KEY])
    .update({ metadata: dbc.raw("COALESCE(metadata, '{}'::jsonb) - ?", [CALL_UNIT_ANSWER_KEY]) });
  return Number(changed) > 0;
}

async function callUnitAnswer(dbc, callLogId) {
  if (!callLogId) return null;
  const row = await dbc('call_log').where({ id: callLogId }).first('metadata');
  if (!row) return null;
  let md = row.metadata;
  if (typeof md === 'string') { try { md = JSON.parse(md); } catch { md = null; } }
  const fence = md && typeof md === 'object' ? md[CALL_UNIT_ANSWER_KEY] : null;
  return fence && typeof fence === 'object' && fence.unit ? fence : null;
}

// The decision, pure, on the draft's FINAL address (what the row will
// persist — never a context flag, which proves nothing about the address
// the composer returned; codex r1 P1 on #3796). A draft passes when that
// address names exactly the fenced unit at the asked building, or is for a
// DIFFERENT building than the one the ask was about. At the asked
// building, a whole-building draft AND one naming a different unit (a
// stale or misheard extraction — exactly what the customer's answer
// corrects) are blocked; so is a draft with no address at all. A fence
// with no building applies to every unitless or differing draft.
// `adopted` = the fence the composer ADOPTED before this locked read (the
// engine reads it pre-transaction): the locked row must still carry that
// same answer (unit + stamp time), or the human retired it mid-run —
// Dismiss/Deny cleared the fence, or a newer reply replaced it — and a
// draft carrying the rejected unit must not insert (pre-push codex P1 on
// #3804, r8). 'unit_answer_retracted' exits as quietly as
// 'unit_answer_pending'; the next reprocess composes without it.
function unitAnswerFenceReason(fence, { address = null, adopted = null } = {}) {
  const { unitLineValueKey, dwellingUnitOnLine, splitUnitFirstLine } = require('./address-normalizer');
  if (adopted && adopted.unit) {
    if (!fence || !fence.unit) return 'unit_answer_retracted';
    if (unitLineValueKey(String(fence.unit)) !== unitLineValueKey(String(adopted.unit))) return 'unit_answer_retracted';
    if (adopted.at && String(fence.at || '') !== String(adopted.at)) return 'unit_answer_retracted';
  }
  if (!fence || !fence.unit) return null;
  const fencedKey = unitLineValueKey(String(fence.unit));
  const line = String(address || '').trim();
  if (!line) return 'unit_answer_pending';
  const b = fence.building;
  if (b && b.street_line_1) {
    const { sameStreetAddress } = require('../services/estimator-engine/address-compare');
    const buildingLine = [b.street_line_1, b.city, b.postal_code ? `FL ${b.postal_code}` : null].filter(Boolean).join(', ');
    // Compared on the STREET: a structural unit-first line ("Bldg 9, 123
    // Main St, …") is not another building (codex r5 P1 on #3796).
    if (!sameStreetAddress(splitUnitFirstLine(line)?.rest || line, buildingLine)) return null;
  }
  // The DWELLING unit in either supported position — the composer may
  // return the unit-first form the override deliberately preserves (codex
  // r4 P2); a structural component alone ("Bldg 9") is no answer.
  const lineUnit = dwellingUnitOnLine(line);
  if (lineUnit && unitLineValueKey(lineUnit) === fencedKey) return null;
  return 'unit_answer_pending';
}

// Read + decide, for the creators' in-lock check. Callers hold the call
// row lock through their insert (same contract as callPassStillOwned).
async function callUnitAnswerFence(dbc, callLogId, { address = null, adopted = null } = {}) {
  const fence = await callUnitAnswer(dbc, callLogId);
  return unitAnswerFenceReason(fence, { address, adopted });
}

// Whether an operator edit may LIFT a unit hold: only once the row's
// address carries the answered unit. A revision that changed pricing or
// services but kept the whole-building address has not incorporated the
// answer, and the hold stays (codex r1 P1 on #3804). No call or no fence =
// an ordinary re-price guard, lifted by the observing edit as before.
async function unitHoldSatisfied(dbc, callLogId, address) {
  if (!callLogId) return true;
  const fence = await callUnitAnswer(dbc, callLogId);
  return unitAnswerFenceReason(fence, { address }) === null;
}

module.exports = {
  ESTIMATE_DELIVERY_CLAIM_TTL_MS,
  CALL_EXTRACTION_RETRY_WINDOW_MS,
  DELIVERY_CLAIM_NOT_LIVE_SQL,
  LINKAGE_INVALIDATION_ABSENT_SQL,
  INVALIDATION_PENDING_ABSENT_SQL,
  REPRICE_PENDING_ABSENT_SQL,
  callReprocessInFlight,
  callPassStillOwned,
  callSideBlockForEstimateData,
  stampCallUnitAnswer,
  clearCallUnitAnswer,
  callUnitAnswer,
  unitAnswerFenceReason,
  callUnitAnswerFence,
  unitHoldSatisfied,
};
