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

module.exports = {
  ESTIMATE_DELIVERY_CLAIM_TTL_MS,
  DELIVERY_CLAIM_NOT_LIVE_SQL,
  LINKAGE_INVALIDATION_ABSENT_SQL,
  INVALIDATION_PENDING_ABSENT_SQL,
  callReprocessInFlight,
  callSideBlockForEstimateData,
};
