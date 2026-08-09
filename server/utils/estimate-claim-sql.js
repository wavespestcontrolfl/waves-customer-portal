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

module.exports = {
  ESTIMATE_DELIVERY_CLAIM_TTL_MS,
  DELIVERY_CLAIM_NOT_LIVE_SQL,
  LINKAGE_INVALIDATION_ABSENT_SQL,
  INVALIDATION_PENDING_ABSENT_SQL,
};
