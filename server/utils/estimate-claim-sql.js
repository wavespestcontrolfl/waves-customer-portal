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
// The quote intake's county-roll address block (public-quote addressUnverified)
// as a SQL predicate, reasserted on every atomic write that could otherwise
// overwrite the marker from a stale snapshot (codex #4667 r23 P1).
const ADDRESS_UNVERIFIED_ABSENT_SQL = "NOT COALESCE(estimate_data->'addressUnverified' = 'true'::jsonb, false)";
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

// Terminal, money-bearing estimate statuses — a customer has already
// accepted or declined, or the row expired. estimateOffCustomerSurface
// reads estimatorEngine.linkage_invalidated_at BEFORE the accepted/declined
// early-allow, so stamping it on one of these rows revokes the customer's
// PERMANENT access to an estimate they already acted on — correct for an
// identity-conflict or rejected-call verdict (the whole call's identity is
// in question, so an acceptance built on it is too), never correct for a
// mere agreed-price cleanup (codex #4815 r2 P0).
const TERMINAL_ESTIMATE_STATUSES = Object.freeze(['accepted', 'declined', 'expired']);

// Verdicts whose call-side estimator_draft_block is ROW-SCOPED (codex #4815
// r6 P0, structural): an agreed-price cleanup is a verdict about specific
// stale DRAFTS, not about the call's identity or workability. Its marker
// therefore (a) refuses NEW drafts for the call — until a re-qualifying
// pass explicitly supersedes it — and (b) blocks EXISTING estimates only
// when that row carries this same verdict's own per-row stamp (the exact
// rows invalidateDraftForCall marked, archived or deferred). An accepted /
// declined / expired row, a booking-linked assessment draft, or a fresh
// re-qualified draft is never one of those rows, so the call marker can no
// longer revoke its public token the way a call-wide verdict does. Every
// other reason (identity conflict, spam / voicemail / no-attribution) stays
// CALL-WIDE, exactly as before.
const ROW_SCOPED_DRAFT_BLOCK_REASONS = Object.freeze(['price_agreed_on_call']);

function isRowScopedDraftBlockReason(reason) {
  return ROW_SCOPED_DRAFT_BLOCK_REASONS.includes(String(reason || ''));
}

// THE one reading of the call-side draft-verdict markers
// (estimator_draft_block + every QUEUED verdict — the per-reason
// estimator_quarantine_queue and the legacy estimator_quarantine_pending,
// see quarantineQueueEntries below). Every
// reader — callSideBlockForEstimateData and staleCallLinkageReason for an
// EXISTING estimate, callRejectedForDrafting for a NEW draft — goes through
// here instead of interpreting the raw marker itself (codex #4815 r6 P0: the
// P0 appeared twice because three readers each applied the marker
// call-wide on their own). Returns { marker, reason } or null.
//   forNewDraft  — true when the caller (a draft creator's in-lock guard)
//                  is deciding whether a NEW draft may be inserted;
//   estimateData — otherwise, the judged EXISTING row's estimate_data.
//   estimateStatus — the judged EXISTING row's `status` column, when the
//                  caller has it (it is not part of estimate_data). Unknown
//                  (undefined) never proves a row terminal — fail closed.
//   supersededBelowGeneration — ignore a marker whose recorded writer
//                  generation is OLDER than this (see callRejectedForDrafting).
// The QUEUED marker (the invalidation itself has not landed yet, so the
// verdict's own per-row stamps do not exist) follows the SAME row scoping as
// the landed one, derived from the verdict's SCAN scope instead of its
// stamps (codex #4815 r7 P0): a queued ROW-SCOPED (agreed-price) entry keeps
// refusing new drafts and every existing row the landed invalidation WOULD
// mark — but never a terminal (accepted / declined / expired) or
// booking-linked row, which that invalidation's scope excludes
// (invalidateDraftForCall scope 'nonterminal_drafts') and so could never
// mark. Blocking those rows until the drainer ran made every accepted or
// booking-linked estimate for the call 404 on its permanent public token,
// indefinitely whenever the drain job was down. A queued CALL-WIDE entry
// (identity conflict, spam / voicemail / no-attribution) still blocks every
// row: its landed form marks terminal rows too.
// The assessment pre-draft exception's DURABLE provenance (codex #4815 r8
// P2): linkEstimateToBooking stamps scheduled_service_id only while the
// visit is still a live assessment — a booking that went terminal during
// the (minutes-long) composition skips the linkage, yet the fresh draft is
// still the exception's own quote (the promise was made on the CALL) and
// the price-agreed sweep stands down for it. Without a durable mark a later
// force-reprocess's agreed-price invalidation archived that unlinked
// exception with no replacement. maybePreDraftForBooking therefore stamps
// estimate_data.assessment_exception = { call_log_id, generation,
// scheduled_service_id, at } on every exception draft, linked or not, and
// every reader of the exclusion honors EITHER stamp.
function estimateEarnsAssessmentException(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return false;
  if (estimateData.scheduled_service_id != null) return true;
  const ex = estimateData.assessment_exception;
  return !!(ex && typeof ex === 'object' && ex.call_log_id);
}

// SQL mirror of estimateEarnsAssessmentException's NEGATION, for the
// invalidation scan (strictExistingDraftForCall excludeBookingLinked).
const ASSESSMENT_EXCEPTION_ABSENT_SQL = "((estimate_data ->> 'scheduled_service_id') IS NULL"
  + " AND COALESCE(estimate_data -> 'assessment_exception' ->> 'call_log_id', '') = '')";

function scopedVerdictExcludesRow(estimateData, estimateStatus) {
  if (estimateStatus != null
    && TERMINAL_ESTIMATE_STATUSES.includes(String(estimateStatus).toLowerCase())) return true;
  // The exact stamps the assessment pre-draft exception writes — the
  // scan's excludeBookingLinked predicate (ASSESSMENT_EXCEPTION_ABSENT_SQL),
  // mirrored.
  return estimateEarnsAssessmentException(estimateData);
}

// THE QUARANTINE QUEUE holds MULTIPLE pending verdicts, one per reason
// (codex #4815 r8 P1, structural). It used to be ONE key
// (estimator_quarantine_pending) rewritten wholesale by jsonb_set: an
// identity-conflict invalidation whose block write failed queued
// email_identity_conflict, and a later agreed-price invalidation that also
// had to queue REPLACED it — without ever revalidating it. Because the
// agreed-price verdict is row-scoped, accepted and booking-linked
// estimates then passed although the call-wide identity verdict was never
// disproved. Now:
//   - writers (markQuarantinePending) add or refresh ONLY their own
//     reason's entry in estimator_quarantine_queue — { <reason>: { reason,
//     at, generation } } — never touching another reason's;
//   - readers see EVERY entry (callDraftVerdict judges call-wide entries
//     first, so the strongest applicable verdict is the one reported);
//   - the drainer revalidates and retires each entry independently, and a
//     generation-matched clear (clearOwnQuarantinePending) removes only
//     its own reason + generation.
// The legacy single-entry key is still READ (and drained / cleared) as one
// more entry, so a row queued by an earlier deploy keeps failing closed
// until its verdict is resolved; nothing writes it any more.
const QUARANTINE_QUEUE_KEY = 'estimator_quarantine_queue';
const LEGACY_QUARANTINE_KEY = 'estimator_quarantine_pending';
// The queue map as a jsonb OBJECT (a missing or malformed value reads as
// empty, never as an error that would abort the caller's statement).
const QUARANTINE_QUEUE_MAP_SQL = `(CASE WHEN jsonb_typeof(metadata->'${QUARANTINE_QUEUE_KEY}') = 'object'
  THEN metadata->'${QUARANTINE_QUEUE_KEY}' ELSE '{}'::jsonb END)`;
// Adds / refreshes ONE reason's entry. Bindings: [reason, entryJson].
const QUARANTINE_QUEUE_APPEND_SQL = `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${QUARANTINE_QUEUE_KEY}}',
  ${QUARANTINE_QUEUE_MAP_SQL} || jsonb_build_object(?::text, ?::jsonb), true)`;

function quarantineQueueEntry(reason, generation = null) {
  return {
    reason: String(reason),
    at: new Date().toISOString(),
    ...(generation != null ? { generation: Number(generation) } : {}),
  };
}

// Every queued verdict on a call's metadata, CALL-WIDE entries first.
// `slot` names where the entry lives: 'legacy' for the old single key,
// otherwise the queue map's key (the reason).
function quarantineQueueEntries(md) {
  const entries = [];
  if (!md || typeof md !== 'object') return entries;
  const legacy = md[LEGACY_QUARANTINE_KEY];
  if (legacy && typeof legacy === 'object' && legacy.reason) {
    entries.push({ ...legacy, reason: String(legacy.reason), slot: 'legacy' });
  }
  const queue = md[QUARANTINE_QUEUE_KEY];
  if (queue && typeof queue === 'object' && !Array.isArray(queue)) {
    for (const [slot, entry] of Object.entries(queue)) {
      if (entry && typeof entry === 'object' && entry.reason) {
        entries.push({ ...entry, reason: String(entry.reason), slot });
      }
    }
  }
  // Stable: call-wide (0) before row-scoped (1).
  return entries
    .map((entry, i) => ({ entry, i, rank: isRowScopedDraftBlockReason(entry.reason) ? 1 : 0 }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map(({ entry }) => entry);
}

function callDraftVerdict(md, {
  forNewDraft = false, estimateData = null, estimateStatus = null, supersededBelowGeneration = null,
} = {}) {
  const current = (marker) => marker?.reason && (supersededBelowGeneration == null
    || marker.generation == null
    || Number(marker.generation) >= Number(supersededBelowGeneration));
  const block = md?.estimator_draft_block;
  if (current(block)) {
    const reason = String(block.reason);
    // A re-qualifying pass stamps superseded_at BEFORE the creators'
    // in-lock guard (codex #4815 r6 P1) so its fresh draft can land; the
    // rows the verdict already marked stay dead via their own per-row
    // stamps, which are all an existing row is judged by.
    const eng = estimateData?.estimatorEngine || {};
    const markedThisRow = eng.invalidation_pending_reason === reason
      || (!!eng.linkage_invalidated_at && eng.invalidation_reason === reason);
    const applies = !isRowScopedDraftBlockReason(reason)
      || (forNewDraft ? !block.superseded_at : markedThisRow);
    if (applies) return { marker: 'draft_block', reason };
  }
  // EVERY queued verdict is judged on its own scope (codex #4815 r8 P1) —
  // a row-scoped entry sparing a terminal / exception row never hides a
  // call-wide entry queued beside it.
  for (const queued of quarantineQueueEntries(md)) {
    if (!current(queued)) continue;
    const applies = forNewDraft
      || !isRowScopedDraftBlockReason(queued.reason)
      || !scopedVerdictExcludesRow(estimateData, estimateStatus);
    if (applies) return { marker: 'quarantine_pending', reason: queued.reason };
  }
  return null;
}

// The DURABLE call-side verdict as seen from an ESTIMATE row: when a
// quarantine could not write its estimate-side marker, the block lives on
// the call, and the public surfaces — which only ever read the estimate —
// would keep serving a wrong-identity or rejected-call estimate through
// its bearer token until the scheduler drained the queue (codex P1, PR
// #3304 GH r9). Returns the blocking reason, or null. Cheap: one indexed
// lookup, and only for engine-drafted rows.
// `estimateStatus` (codex #4815 r7 P0): the row's status column — lets a
// queued row-scoped verdict spare a terminal row (see callDraftVerdict).
// Omitted, the row is judged as possibly non-terminal (fail closed).
async function callSideBlockForEstimateData(dbc, data, { estimateStatus = null } = {}) {
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
    const verdict = callDraftVerdict(md, { estimateData: data, estimateStatus });
    if (verdict) return verdict.reason;
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
function adoptedAnswerRetracted(fence, adopted) {
  if (!adopted || !adopted.unit) return false;
  if (!fence || !fence.unit) return true;
  const { unitLineValueKey } = require('./address-normalizer');
  if (unitLineValueKey(String(fence.unit)) !== unitLineValueKey(String(adopted.unit))) return true;
  return Boolean(adopted.at) && String(fence.at || '') !== String(adopted.at);
}

function unitAnswerFenceReason(fence, { address = null, adopted = null } = {}) {
  const { unitLineValueKey, dwellingUnitOnLine, splitUnitFirstLine } = require('./address-normalizer');
  if (adoptedAnswerRetracted(fence, adopted)) return 'unit_answer_retracted';
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

// THE "off the customer surface" verdict every public predicate shares — a
// linkage marker (full or pending) OR a clarify re-price hold. One predicate,
// one call site per surface (view, SSR, accept-active, ask, extension
// eligibility, the pinned document render, the add-service request): a
// surface that checked the linkage markers but not the hold was how the
// extension request kept auto-granting a held row (codex r7 P0 on #3804),
// and a service-side predicate that checked neither was how a bundle
// inquiry kept running on a held row (codex r10 P0). Lives here, not in the
// route, so services judge a LOCKED row with the same verdict the route
// judges its pre-read with. The clarify module is required lazily — this
// file stays dependency-free at load (see the header).
function estimateOffCustomerSurface(estimate = {}) {
  let data = estimate?.estimate_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  // The quote intake's durable county-roll verdict (public-quote
  // addressUnverified): a house number the roll could not confirm keeps the
  // row off the customer surface — view, server page, accept, asks — even
  // after a generic unarchive or a withdrawal that failed to land (codex
  // #4667 r8 P1 ×2). Cleared only by a clean run refreshing the draft.
  if (data && typeof data === 'object' && data.addressUnverified === true) return true;
  const eng = data && typeof data === 'object' ? data.estimatorEngine : null;
  if (eng && (eng.linkage_invalidated_at || eng.invalidation_pending_at)) return true;
  return require('../services/estimate-clarify-asks').repricePendingActive(eng);
}

module.exports = {
  estimateOffCustomerSurface,
  ESTIMATE_DELIVERY_CLAIM_TTL_MS,
  CALL_EXTRACTION_RETRY_WINDOW_MS,
  DELIVERY_CLAIM_NOT_LIVE_SQL,
  LINKAGE_INVALIDATION_ABSENT_SQL,
  INVALIDATION_PENDING_ABSENT_SQL,
  REPRICE_PENDING_ABSENT_SQL,
  ADDRESS_UNVERIFIED_ABSENT_SQL,
  callReprocessInFlight,
  callPassStillOwned,
  callSideBlockForEstimateData,
  callDraftVerdict,
  quarantineQueueEntries,
  quarantineQueueEntry,
  QUARANTINE_QUEUE_KEY,
  LEGACY_QUARANTINE_KEY,
  QUARANTINE_QUEUE_MAP_SQL,
  QUARANTINE_QUEUE_APPEND_SQL,
  estimateEarnsAssessmentException,
  ASSESSMENT_EXCEPTION_ABSENT_SQL,
  isRowScopedDraftBlockReason,
  ROW_SCOPED_DRAFT_BLOCK_REASONS,
  TERMINAL_ESTIMATE_STATUSES,
  stampCallUnitAnswer,
  clearCallUnitAnswer,
  callUnitAnswer,
  unitAnswerFenceReason,
  callUnitAnswerFence,
  unitHoldSatisfied,
};
