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
const RETIRE_CLOSER = 'estimate-draft-retire';
// A draft younger than this is still being finished by its creator: the
// estimator engine posts its "draft ready" bell and parks clarifications
// after the insert, and the lead webhook's background triage rewrites the
// row. None of them hold the estimate lock, so the sweep waits them out.
const DRAFT_SETTLE_MINUTES = 30;
// Thrown inside the per-draft transaction to roll an archive back.
class KeepDraft extends Error {}
// lock_not_available (NOWAIT / lock_timeout) and deadlock_detected: another
// writer holds a row this draft needs. Skipped; the next tick retries.
const BUSY_ROW_CODES = new Set(['55P03', '40P01']);
// Sends checked per draft (same-door first): bounds the read per draft.
const SENDS_PER_DRAFT = 5;

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

// A send that started with no recorded result may have reached the customer;
// the send route refuses another send until staff check it (the
// SEND_OUTCOME_UNCERTAIN rule in admin-estimates.js). Such a draft is kept.
const NO_UNCERTAIN_SEND_SQL = `NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(estimates.estimate_data->'manualSendAttempts') = 'array'
      THEN estimates.estimate_data->'manualSendAttempts' ELSE '[]'::jsonb END) a
   WHERE COALESCE(a->>'startedAt', '') <> ''
     AND COALESCE(a->'result', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb)
)`;

const DRAFT_ELIGIBLE_SQL = `
  status = 'draft'
  AND archived_at IS NULL
  AND customer_id IS NOT NULL
  AND estimate_group_id IS NULL
  AND scheduled_at IS NULL
  AND price_locked_at IS NULL
  AND created_at < NOW() - INTERVAL '${DRAFT_SETTLE_MINUTES} minutes'
  AND COALESCE(source, '') NOT IN ('one_tap_purchase', 'quote_wizard')
  AND ${NO_LIVE_DEPENDENTS_SQL}
  AND ${NO_UNCERTAIN_SEND_SQL}
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

// A real send by staff or a verified flow. Website quote rows (quote_wizard)
// never count: /api/public/quote/calculate is unauthenticated, so a caller
// who knows a prospect's email and address could otherwise mint a "sent" row
// that archives that customer's staff drafts (codex security review).
// Report click-to-estimate and plan-restart mints stamp sent_at
// at mint time with nothing delivered (publish-without-delivery), so they
// count only once deliveryState records a delivery — the same witness the
// unworked-comms watcher uses for these two sources.
const SENT_EVIDENCE_SQL = (alias) => `${alias}.sent_at IS NOT NULL
  AND ${alias}.status <> 'draft'
  AND ${LINKAGE_MARKERS_ABSENT_SQL(alias)}
  AND COALESCE(${alias}.source, '') <> 'quote_wizard'
  AND (COALESCE(${alias}.source, '') NOT IN ('service_report_cta', 'plan_restart')
       OR COALESCE(${alias}.estimate_data #>> '{deliveryState,firstDeliveredAt}', '') <> '')`;

// Archive one draft, clear a lead link to it, and mark its open "draft
// ready" bells done, in one transaction. The sent estimate is read FOR SHARE first, so a concurrent
// revise (address move) or linkage invalidation of it either commits
// before this check or waits until the archive commits.
async function retireOneDraft(trx, pair) {
  // Lead first, then estimates — the order createOrReuseAdminEstimate takes
  // (lead, then its estimate), so a staff save of the same lead cannot
  // deadlock with this sweep.
  // The sweep never waits behind another writer: customer acceptance locks
  // the replacement estimate and THEN its lead, the reverse of this order, so
  // a wait here could deadlock a customer's request. A busy row means "not
  // this tick" (lock_not_available is skipped by the caller).
  await trx.raw("SET LOCAL lock_timeout = '1500ms'");
  const leads = await trx('leads').where({ estimate_id: pair.draft_id }).forUpdate().select('id');
  const sent = await trx.raw(`
    SELECT id, status, archived_at FROM estimates s
     WHERE s.id = ?
       AND s.property_id IS NOT DISTINCT FROM ?
       AND s.address IS NOT DISTINCT FROM ?
       AND ${SENT_EVIDENCE_SQL('s')}
     FOR SHARE NOWAIT
  `, [pair.sent_id, pair.sent_property_id, pair.sent_address]);
  if (!sent?.rows?.length) return null;
  // An ACCEPTED replacement would need the lead converted; that is the
  // acceptance flow's decision, not this sweep's. Keep a lead-linked draft.
  const sentStatus = sent.rows[0].status;
  // Only a live courtship is replayed for the lead (the backfill's own rule:
  // unarchived sent/viewed rows); a declined, expired or archived replacement
  // still retires the draft, and the lead is only unlinked.
  const replaySend = !sent.rows[0].archived_at && ['sent', 'viewed'].includes(sentStatus);
  if (leads.length && sentStatus === 'accepted') return null;
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
  // A lead linked between the first lock (which locks nothing when no lead
  // points here yet) and the archive is picked up now, under the draft's row
  // lock. For an accepted replacement the whole retirement is undone.
  const lateLeads = await trx('leads').where({ estimate_id: row.id }).whereNotIn('id', leads.map((l) => l.id)).forUpdate().select('id');
  if (lateLeads.length && sentStatus === 'accepted') throw new KeepDraft();
  leads.push(...lateLeads);
  // Unlink, never re-point: the sent estimate may already belong to another
  // lead (by FK or by its estimate_data mirror), and staff can link it.
  if (leads.length) {
    await trx('leads').whereIn('id', leads.map((l) => l.id)).where({ estimate_id: row.id })
      .update({ estimate_id: null, updated_at: trx.fn.now() });
    // Replay the send for the now-unlinked lead the way the send backfill
    // does (scripts/backfill-estimate-sent-lead-status.js): the canonical
    // resolver links and advances it only when it is the sent estimate's
    // single unambiguous open lead, as of the send time. Lead state only; it
    // sends nothing. Skipped when a lead already owns the sent estimate: that
    // send is accounted for, and a replay would only re-record it there.
    // A viewed replacement then replays the view, as the backfill does.
    const sentOwned = await trx('leads').where({ estimate_id: pair.sent_id }).first('id');
    if (replaySend && !sentOwned) {
      const link = require('./lead-estimate-link');
      const replay = { estimateId: pair.sent_id, performedBy: RETIRE_CLOSER, database: trx, originatingNotAfter: pair.sent_at };
      await link.markLinkedLeadEstimateSent({ ...replay, sendMethod: 'backfill', respondedAt: pair.sent_at });
      if (sentStatus === 'viewed') await link.markLinkedLeadEstimateViewed(replay);
    }
  }
  // The canonical system close (notification-service done contract): the
  // closer is named, read state follows, a person's earlier Done is kept.
  const { doneColumns, openToCloser } = require('./notification-service')._private;
  await openToCloser(
    trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'estimateId' = ?", [String(row.id)]),
    RETIRE_CLOSER,
  ).update(doneColumns({ by: RETIRE_CLOSER, resolution: 'A newer estimate was sent, so this draft was archived', keepExisting: true, conn: trx }));
  return row;
}

// Query errors from knex carry the bound values (street addresses) in
// err.message; only the code and name leave this module, so no address
// reaches the scheduler log or runExclusive's error record.
async function retireDraftsReplacedBySentEstimate(opts = {}) {
  try {
    return await retireDrafts(opts);
  } catch (err) {
    const safe = new Error(`estimate draft retire failed: ${err?.code || err?.name || 'error'}`);
    safe.code = err?.code;
    throw safe;
  }
}

async function retireDrafts({ conn = db, limit = RETIRE_BATCH_LIMIT } = {}) {
  const batch = Math.max(1, Math.min(Number(limit) || RETIRE_BATCH_LIMIT, 1000));
  // Unqualified columns in DRAFT_ELIGIBLE_SQL resolve to the draft (the
  // subquery reads one table). Up to SENDS_PER_DRAFT real sends per draft,
  // created after it, from a bounded lateral that lists same-property and
  // same-address sends first, so a newer send for another door cannot hide
  // the one that replaced the draft, and no drafts x sends set is formed. No
  // outer LIMIT for other-door pairs to starve later drafts behind; the
  // WRITES are capped at `batch`.
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
         ORDER BY COALESCE(s.property_id = d.property_id, false) DESC,
                  COALESCE(LOWER(TRIM(s.address)) = LOWER(TRIM(d.address)), false) DESC,
                  s.sent_at DESC
         LIMIT ${SENDS_PER_DRAFT}
      ) s
     -- A lead-linked draft with ANY later accepted estimate is kept whole:
     -- that lead belongs to the acceptance flow, so an older sent estimate
     -- must not retire the draft and take the lead instead.
     WHERE NOT (
       EXISTS (SELECT 1 FROM leads l WHERE l.estimate_id = d.id)
       AND EXISTS (SELECT 1 FROM estimates a
                    WHERE a.customer_id = d.customer_id AND a.id <> d.id
                      AND a.status = 'accepted' AND a.created_at > d.created_at)
     )
  `))?.rows || [];

  // First matching send per draft (the lateral lists same-door sends first).
  // No cap here: a candidate retireOneDraft keeps (accepted replacement with
  // a lead, a row changed since the read) must not use up the batch.
  const chosen = [...new Map(pairs.filter(sameProperty).reverse().map((p) => [p.draft_id, p])).values()];

  const rows = [];
  // The kept-forever shape (a lead-linked draft whose replacement is accepted)
  // is filtered in the read above, so what returns null here is transient (a
  // busy row, a change since the read). Attempts are capped too, so a run
  // opens at most 2 x batch transactions.
  let attempts = 0;
  for (const pair of chosen) {
    if (rows.length >= batch || attempts >= batch * 2) break;
    attempts += 1;
    const row = await conn.transaction((trx) => retireOneDraft(trx, pair))
      .catch((err) => { if (err instanceof KeepDraft || BUSY_ROW_CODES.has(err?.code)) return null; throw err; });
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
