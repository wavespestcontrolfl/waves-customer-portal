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
 *   - not part of an estimate group, no scheduled send, no price lock, not a
 *     one-tap purchase draft (its purchase row and slot hold own its life);
 *   - same property: same property_id when both rows have one, else the same
 *     address (no address = kept);
 *   - no live delivery claim, estimator-engine hold or address hold;
 *   - the sent estimate is a real send: not reset to draft and not carrying
 *     a call-linkage invalidation marker.
 */
const db = require('../models/db');
const logger = require('./logger');
const { DELIVERY_CLAIM_NOT_LIVE_SQL, ADDRESS_UNVERIFIED_ABSENT_SQL } = require('../utils/estimate-claim-sql');

const RETIRE_BATCH_LIMIT = 200;

// Hold markers a sweep must never step over: each one means another flow
// still owns this draft's next write.
// Linkage markers, shared by both sides of the join: an estimate whose call
// identity was invalidated (or is about to be) belongs to another lead — it
// is neither a draft to retire nor proof that a send replaced one.
const LINKAGE_MARKERS_ABSENT_SQL = (alias) => `(
  COALESCE(${alias}.estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''
  AND COALESCE(${alias}.estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') = ''
)`;

const DRAFT_HOLD_MARKERS_ABSENT_SQL = `(
  ${LINKAGE_MARKERS_ABSENT_SQL('estimates')}
  AND COALESCE(estimate_data->'estimatorEngine'->>'reprice_pending_at', '') = ''
  AND ${ADDRESS_UNVERIFIED_ABSENT_SQL}
)`;

const DRAFT_ELIGIBLE_SQL = `
  status = 'draft'
  AND archived_at IS NULL
  AND customer_id IS NOT NULL
  AND estimate_group_id IS NULL
  AND scheduled_at IS NULL
  AND price_locked_at IS NULL
  AND COALESCE(source, '') <> 'one_tap_purchase'
  AND ${DELIVERY_CLAIM_NOT_LIVE_SQL}
  AND ${DRAFT_HOLD_MARKERS_ABSENT_SQL}
`;

// Same property: same property_id when both rows have one; else the same
// door by the shared premise matcher (street, city and ZIP, so "Ter" and
// "Terrace" or a trailing ", USA" still match) plus the same unit. A missing
// or unparseable address fails closed: the draft is kept.
function sameProperty(pair) {
  if (pair.draft_property_id && pair.sent_property_id) return pair.draft_property_id === pair.sent_property_id;
  const { samePremiseDisplay, parseDisplayAddress } = require('./lead-address-unverified');
  if (!samePremiseDisplay(pair.draft_address, pair.sent_address, { requireLocality: true })) return false;
  const unit = (text) => String(parseDisplayAddress(text).unit || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return unit(pair.draft_address) === unit(pair.sent_address);
}

const SENT_EVIDENCE_SQL = (alias) => `${alias}.sent_at IS NOT NULL
  AND ${alias}.status <> 'draft'
  AND ${LINKAGE_MARKERS_ABSENT_SQL(alias)}`;

async function retireDraftsReplacedBySentEstimate({ conn = db, limit = RETIRE_BATCH_LIMIT } = {}) {
  const batch = Math.max(1, Math.min(Number(limit) || RETIRE_BATCH_LIMIT, 1000));
  // Unqualified columns in DRAFT_ELIGIBLE_SQL resolve to the draft: the
  // subquery reads one table.
  const pairs = (await conn.raw(`
    SELECT d.id AS draft_id, d.property_id AS draft_property_id, d.address AS draft_address,
           s.id AS sent_id, s.sent_at, s.property_id AS sent_property_id, s.address AS sent_address
      FROM (SELECT * FROM estimates WHERE ${DRAFT_ELIGIBLE_SQL}) d
      JOIN estimates s
        ON s.customer_id = d.customer_id
       AND s.id <> d.id
       AND ${SENT_EVIDENCE_SQL('s')}
       AND s.created_at > d.created_at
       AND d.updated_at <= s.sent_at
     ORDER BY d.created_at, d.id, s.sent_at DESC
     LIMIT ?
  `, [batch * 10]))?.rows || [];

  const chosen = new Map();
  for (const pair of pairs) {
    if (chosen.size >= batch) break;
    if (!chosen.has(pair.draft_id) && sameProperty(pair)) chosen.set(pair.draft_id, pair);
  }

  // One row per write, every predicate re-checked on the row itself: a draft
  // edited, sent or claimed since the read — or a send since invalidated —
  // is left alone.
  const rows = [];
  for (const pair of chosen.values()) {
    const result = await conn.raw(`
      UPDATE estimates
         SET archived_at = NOW(),
             updated_at = NOW(),
             estimate_data = jsonb_set(
               COALESCE(estimate_data, '{}'::jsonb),
               '{retiredBySentEstimate}',
               jsonb_build_object('estimate_id', ?::text, 'retired_at', NOW())
             )
       WHERE id = ?
         AND updated_at <= ?
         AND ${DRAFT_ELIGIBLE_SQL}
         AND EXISTS (SELECT 1 FROM estimates s WHERE s.id = ? AND ${SENT_EVIDENCE_SQL('s')})
      RETURNING id, customer_id
    `, [pair.sent_id, pair.draft_id, pair.sent_at, pair.sent_id]);
    const row = result?.rows?.[0];
    if (!row) continue;
    rows.push({ ...row, sent_id: pair.sent_id });
    logger.info(`[estimate-draft-retire] archived draft ${row.id} (customer ${row.customer_id}): replaced by sent estimate ${pair.sent_id}`);
  }
  return { retired: rows.length, rows };
}

module.exports = {
  retireDraftsReplacedBySentEstimate,
  DRAFT_ELIGIBLE_SQL,
  RETIRE_BATCH_LIMIT,
};
