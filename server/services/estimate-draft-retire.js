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
const { DELIVERY_CLAIM_NOT_LIVE_SQL, ADDRESS_UNVERIFIED_ABSENT_SQL, ASSESSMENT_EXCEPTION_ABSENT_SQL } = require('../utils/estimate-claim-sql');

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

// A draft with its own live lifecycle is never retired (codex #6081 r1-r6):
// an assessment-linked pre-draft (ASSESSMENT_EXCEPTION_ABSENT_SQL, kept for
// staff to price after the visit), a booking-page handoff (booking_intents, which the public capture can
// re-open) or a staged clarification text. A linked lead is not a blocker:
// the link is cleared, as the Delete action does (see retireOneDraft).
const NO_LIVE_DEPENDENTS_SQL = `(
  NOT EXISTS (SELECT 1 FROM booking_intents b WHERE b.pricing_estimate_id = estimates.id)
  AND NOT EXISTS (
    SELECT 1 FROM message_drafts m
     WHERE m.intent = 'estimate_clarify'
       AND m.flags->>'estimate_id' = estimates.id::text
       AND m.status IN ('pending', 'approved', 'revised')
       AND m.sent_at IS NULL
  )
)`;

const DRAFT_ELIGIBLE_SQL = `
  status = 'draft'
  AND archived_at IS NULL
  AND customer_id IS NOT NULL
  AND estimate_group_id IS NULL
  AND scheduled_at IS NULL
  AND price_locked_at IS NULL
  AND COALESCE(source, '') NOT IN ('one_tap_purchase', 'quote_wizard')
  AND ${NO_LIVE_DEPENDENTS_SQL}
  AND ${ASSESSMENT_EXCEPTION_ABSENT_SQL}
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
  // Canonical unit key, so "Apt 4", "Unit 4" and "#4" are one door.
  const { normalizeUnitLine, unitLineValueKey } = require('../utils/address-normalizer');
  const unit = (text) => unitLineValueKey(normalizeUnitLine(parseDisplayAddress(text).unit));
  return unit(pair.draft_address) === unit(pair.sent_address);
}

const SENT_EVIDENCE_SQL = (alias) => `${alias}.sent_at IS NOT NULL
  AND ${alias}.status <> 'draft'
  AND ${LINKAGE_MARKERS_ABSENT_SQL(alias)}`;

// Archive one draft, clear a lead link to it, and mark its open "draft
// ready" bells done, in one transaction. The sent estimate is read FOR SHARE first, so a concurrent
// revise (address move) or linkage invalidation of it either commits
// before this check or waits until the archive commits.
async function retireOneDraft(trx, pair) {
  // Lead first, then estimates — the order createOrReuseAdminEstimate takes
  // (lead, then its estimate), so a staff save of the same lead cannot
  // deadlock with this sweep.
  const leads = await trx('leads').where({ estimate_id: pair.draft_id }).forUpdate().select('id');
  const sent = await trx.raw(`
    SELECT id FROM estimates s
     WHERE s.id = ?
       AND s.property_id IS NOT DISTINCT FROM ?
       AND s.address IS NOT DISTINCT FROM ?
       AND ${SENT_EVIDENCE_SQL('s')}
     FOR SHARE
  `, [pair.sent_id, pair.sent_property_id, pair.sent_address]);
  if (!sent?.rows?.length) return null;
  // Every draft predicate re-checked on the row itself: a draft edited,
  // sent, claimed or newly linked since the read is left alone.
  const result = await trx.raw(`
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
       AND property_id IS NOT DISTINCT FROM ?
       AND address IS NOT DISTINCT FROM ?
       AND EXISTS (SELECT 1 FROM estimates s WHERE s.id = ? AND s.customer_id = estimates.customer_id AND s.created_at > estimates.created_at)
       AND ${DRAFT_ELIGIBLE_SQL}
    RETURNING id, customer_id
  `, [pair.sent_id, pair.draft_id, pair.sent_at, pair.draft_property_id, pair.draft_address, pair.sent_id]);
  const row = result?.rows?.[0];
  if (!row) return null;
  // Unlink, never re-point: the sent estimate may already belong to another
  // lead (by FK or by its estimate_data mirror), and staff can link it.
  if (leads.length) {
    await trx('leads').whereIn('id', leads.map((l) => l.id)).where({ estimate_id: row.id })
      .update({ estimate_id: null, updated_at: trx.fn.now() });
  }
  await trx('notifications')
    .whereRaw("metadata->>'estimateId' = ?", [String(row.id)])
    .whereNull('done_at')
    .update({ done_at: trx.fn.now(), resolution: 'estimate_draft_replaced' });
  return row;
}

async function retireDraftsReplacedBySentEstimate({ conn = db, limit = RETIRE_BATCH_LIMIT } = {}) {
  const batch = Math.max(1, Math.min(Number(limit) || RETIRE_BATCH_LIMIT, 1000));
  // Unqualified columns in DRAFT_ELIGIBLE_SQL resolve to the draft (the
  // subquery reads one table). One pair per draft: its customer's NEWEST real send created after it
  // (fails closed — a newest send for another door keeps the draft). So the
  // read is bounded by the open drafts that have a newer sent sibling, with
  // no LIMIT for other-door pairs to starve later drafts behind; the WRITES
  // are capped at `batch`.
  const pairs = (await conn.raw(`
    SELECT d.id AS draft_id, d.property_id AS draft_property_id, d.address AS draft_address,
           s.id AS sent_id, s.sent_at, s.property_id AS sent_property_id, s.address AS sent_address
      FROM (SELECT * FROM estimates WHERE ${DRAFT_ELIGIBLE_SQL}) d
      CROSS JOIN LATERAL (
        SELECT s.id, s.sent_at, s.property_id, s.address
          FROM estimates s
         WHERE s.customer_id = d.customer_id
           AND s.id <> d.id
           AND ${SENT_EVIDENCE_SQL('s')}
           AND s.created_at > d.created_at
           AND d.updated_at <= s.sent_at
         ORDER BY s.sent_at DESC
         LIMIT 1
      ) s
  `))?.rows || [];

  const chosen = pairs.filter(sameProperty).slice(0, batch);

  const rows = [];
  for (const pair of chosen) {
    const row = await conn.transaction((trx) => retireOneDraft(trx, pair));
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
