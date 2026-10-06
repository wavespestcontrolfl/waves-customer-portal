/**
 * Retire draft estimates a later SENT estimate replaced (owner 2026-10-06).
 *
 * A call can leave an auto draft, staff build their own estimate later, send
 * that one, and the first draft sits forever in the list and the missed
 * follow-up counts. This sweep archives such drafts. Archive, not delete:
 * the row carries `estimate_data.retiredBySentEstimate` and the normal
 * unarchive action restores it.
 *
 * A draft is retired only when ALL hold:
 *   - status 'draft', not archived, has a customer;
 *   - the same customer has an estimate that was SENT and was created after
 *     the draft (a draft started after the send is new work, kept);
 *   - nobody touched the draft after that send (updated_at <= sent_at);
 *   - not part of an estimate group, no scheduled send, no price lock;
 *   - same property when both rows name one;
 *   - no live delivery claim and no estimator-engine hold marker.
 */
const db = require('../models/db');
const logger = require('./logger');
const { DELIVERY_CLAIM_NOT_LIVE_SQL } = require('../utils/estimate-claim-sql');

const RETIRE_BATCH_LIMIT = 200;

// Hold markers a sweep must never step over: each one means another flow
// still owns this draft's next write.
const DRAFT_HOLD_MARKERS_ABSENT_SQL = `(
  COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''
  AND COALESCE(estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') = ''
  AND COALESCE(estimate_data->'estimatorEngine'->>'reprice_pending_at', '') = ''
  AND estimate_data->'addressUnverifiedFlag' IS NULL
)`;

const DRAFT_ELIGIBLE_SQL = `
  status = 'draft'
  AND archived_at IS NULL
  AND customer_id IS NOT NULL
  AND estimate_group_id IS NULL
  AND scheduled_at IS NULL
  AND price_locked_at IS NULL
  AND ${DELIVERY_CLAIM_NOT_LIVE_SQL}
  AND ${DRAFT_HOLD_MARKERS_ABSENT_SQL}
`;

async function retireDraftsReplacedBySentEstimate({ conn = db, limit = RETIRE_BATCH_LIMIT } = {}) {
  const batch = Math.max(1, Math.min(Number(limit) || RETIRE_BATCH_LIMIT, 1000));
  // Candidates and the write share one statement; the UPDATE re-checks every
  // draft predicate on the locked row, so a draft edited, sent or claimed
  // since the CTE read is left alone. Unqualified columns in
  // DRAFT_ELIGIBLE_SQL resolve to the draft: the subquery reads one table,
  // and cand exposes only draft_id / sent_id / sent_at.
  const result = await conn.raw(`
    WITH cand AS (
      SELECT DISTINCT ON (d.id) d.id AS draft_id, s.id AS sent_id, s.sent_at AS sent_at
      FROM (SELECT * FROM estimates WHERE ${DRAFT_ELIGIBLE_SQL}) d
      JOIN estimates s
        ON s.customer_id = d.customer_id
       AND s.id <> d.id
       AND s.sent_at IS NOT NULL
       AND s.created_at > d.created_at
       AND d.updated_at <= s.sent_at
       AND (d.property_id IS NULL OR s.property_id IS NULL OR d.property_id = s.property_id)
      ORDER BY d.id, s.sent_at DESC
      LIMIT ?
    )
    UPDATE estimates
       SET archived_at = NOW(),
           updated_at = NOW(),
           estimate_data = jsonb_set(
             COALESCE(estimate_data, '{}'::jsonb),
             '{retiredBySentEstimate}',
             jsonb_build_object('estimate_id', cand.sent_id::text, 'retired_at', NOW())
           )
      FROM cand
     WHERE estimates.id = cand.draft_id
       AND estimates.updated_at <= cand.sent_at
       AND ${DRAFT_ELIGIBLE_SQL}
    RETURNING estimates.id, estimates.customer_id, cand.sent_id
  `, [batch]);
  const rows = result?.rows || [];
  for (const row of rows) {
    logger.info(`[estimate-draft-retire] archived draft ${row.id} (customer ${row.customer_id}): replaced by sent estimate ${row.sent_id}`);
  }
  return { retired: rows.length, rows };
}

module.exports = {
  retireDraftsReplacedBySentEstimate,
  DRAFT_ELIGIBLE_SQL,
  RETIRE_BATCH_LIMIT,
};
