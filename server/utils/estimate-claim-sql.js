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
    const row = await dbc('call_log').where({ id: callLogId }).first('metadata');
    if (!row) return null;
    const md = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    if (md?.estimator_draft_block?.reason) return String(md.estimator_draft_block.reason);
    if (md?.estimator_quarantine_pending?.reason) return String(md.estimator_quarantine_pending.reason);
    return null;
  } catch {
    // A lookup failure must not take the public page down; the
    // estimate-side markers remain the primary gate.
    return null;
  }
}

module.exports = {
  ESTIMATE_DELIVERY_CLAIM_TTL_MS,
  DELIVERY_CLAIM_NOT_LIVE_SQL,
  LINKAGE_INVALIDATION_ABSENT_SQL,
  INVALIDATION_PENDING_ABSENT_SQL,
  callSideBlockForEstimateData,
};
