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

// When the customer last actually received the estimate: the delivery
// witness (deliveryState.lastDeliveredAt, or the older shape below), with
// sent_at only for legacy rows that have no delivery tracking. sent_at alone is not a fence: a resend attempt that
// delivers on no channel still overwrites it.
// The older tracking shape (2026-07 to 2026-08) has no lastDeliveredAt: a
// non-empty sentChannels list is its delivery witness and attemptedAt its time.
const SENT_CHANNELS_SQL = (alias) => `(jsonb_typeof(${alias}.estimate_data #> '{deliveryState,sentChannels}') = 'array'
  AND jsonb_array_length(${alias}.estimate_data #> '{deliveryState,sentChannels}') > 0)`;
const DELIVERED_AT_SQL = (alias) => `((${alias}.estimate_data #>> '{deliveryState,lastDeliveredAt}') ~ '^[0-9]{4}-')`;
const SENT_TIME_SQL = (alias) => `(CASE
  WHEN ${DELIVERED_AT_SQL(alias)}
    THEN (${alias}.estimate_data #>> '{deliveryState,lastDeliveredAt}')::timestamptz
  WHEN ${SENT_CHANNELS_SQL(alias)} AND (${alias}.estimate_data #>> '{deliveryState,attemptedAt}') ~ '^[0-9]{4}-'
    THEN (${alias}.estimate_data #>> '{deliveryState,attemptedAt}')::timestamptz
  ELSE ${alias}.sent_at END)`;

// A real send by staff or a verified flow. A row WITH delivery tracking
// (deliveryState) must carry a delivery witness: a suppressed send stamps
// sent_at and status with nothing delivered. Only legacy rows with no
// delivery tracking at all are taken on sent_at. Website quote rows (quote_wizard)
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
  AND (jsonb_typeof(${alias}.estimate_data->'deliveryState') IS DISTINCT FROM 'object'
       OR COALESCE(${DELIVERED_AT_SQL(alias)}, false)
       OR COALESCE(${SENT_CHANNELS_SQL(alias)}, false))
  AND (COALESCE(${alias}.source, '') NOT IN ('service_report_cta', 'plan_restart')
       OR COALESCE(${alias}.estimate_data #>> '{deliveryState,firstDeliveredAt}', '') <> '')`;

// Unlink, never re-point: the sent estimate may already belong to another
// lead (by FK or by its estimate_data mirror), and staff can link it. Then
// replay the send for the now-unlinked lead the way the send backfill does
// (scripts/backfill-estimate-sent-lead-status.js): the canonical resolver
// links and advances it only when it is the sent estimate's single
// unambiguous open lead, as of the send time. Lead state only; it sends
// nothing. Replayed only for a live courtship (the backfill's own rule:
// unarchived sent/viewed rows) that no lead owns yet: an owned send is
// accounted for, and a replay would only re-record it there. A viewed
// replacement then replays the view.
async function detachLeads(trx, { pair, draftId, leads, sentRow }) {
  await trx('leads').whereIn('id', leads.map((l) => l.id)).where({ estimate_id: draftId })
    .update({ estimate_id: null, updated_at: trx.fn.now() });
  if (sentRow.archived_at || !['sent', 'viewed'].includes(sentRow.status)) return;
  if (await trx('leads').where({ estimate_id: pair.sent_id }).first('id')) return;
  const link = require('./lead-estimate-link');
  const replay = { estimateId: pair.sent_id, performedBy: RETIRE_CLOSER, database: trx, originatingNotAfter: pair.sent_at };
  // Only the channels the delivery record proves count for the contact-wide
  // answered stamp; with no record, none (an empty list stamps nothing)
  // rather than assuming both.
  const recorded = sentRow.sent_channels;
  const sentChannels = Array.isArray(recorded) ? recorded.filter((ch) => ch === 'sms' || ch === 'email') : [];
  await link.markLinkedLeadEstimateSent({ ...replay, sendMethod: 'backfill', respondedAt: pair.sent_at, sentChannels });
  if (sentRow.status === 'viewed') await link.markLinkedLeadEstimateViewed(replay);
}

// Archive one draft, clear a lead link to it, and mark its open "draft
// ready" bells done, in one transaction. The sent estimate is locked FOR
// UPDATE NOWAIT first: a revise (address move), a linkage invalidation or a
// Pipeline link of it (which takes FOR SHARE) either committed before this
// check or cannot proceed until the archive commits, so nothing changes its
// owner between the owner check and the send replay below. A busy row skips
// this draft for the tick.
async function retireOneDraft(trx, pair) {
  // Lead first, then estimates — the order createOrReuseAdminEstimate takes
  // (lead, then its estimate), so a staff save of the same lead cannot
  // deadlock with this sweep.
  // The sweep never waits behind another writer: customer acceptance locks
  // the replacement estimate and THEN its lead, the reverse of this order, so
  // a wait here could deadlock a customer's request. A busy row means "not
  // this tick" (lock_not_available is skipped by the caller).
  await trx.raw("SET LOCAL lock_timeout = '1500ms'");
  // Draft, then its leads, then the sent estimate — every lock NOWAIT, so
  // the sweep never waits on one row while holding another, whatever order
  // another writer uses (call-linkage reconciliation: draft then lead; an
  // estimate save: lead then draft; acceptance: estimate then lead).
  const held = await trx.raw('SELECT id FROM estimates WHERE id = ? FOR UPDATE NOWAIT', [pair.draft_id]);
  if (!held?.rows?.length) return null;
  const leads = await trx('leads').where({ estimate_id: pair.draft_id }).forUpdate().noWait().select('id', 'deleted_at');
  // A soft-deleted lead keeps its estimate_id; it is unlinked like the rest
  // but is not a live opportunity for the accepted-estimate hold.
  const hasLiveLead = () => leads.some((l) => !l.deleted_at);
  const sent = await trx.raw(`
    SELECT id, status, archived_at, estimate_data #> '{deliveryState,sentChannels}' AS sent_channels FROM estimates s
     WHERE s.id = ?
       AND s.property_id IS NOT DISTINCT FROM ?
       AND s.address IS NOT DISTINCT FROM ?
       AND date_trunc('milliseconds', ${SENT_TIME_SQL('s')}) = date_trunc('milliseconds', ?::timestamptz)
       AND ${SENT_EVIDENCE_SQL('s')}
     FOR UPDATE NOWAIT
  `, [pair.sent_id, pair.sent_property_id, pair.sent_address, pair.sent_at]);
  if (!sent?.rows?.length) return null;
  // An ACCEPTED replacement would need the lead converted; that is the
  // acceptance flow's decision, not this sweep's. Keep a lead-linked draft.
  const sentStatus = sent.rows[0].status;
  if (hasLiveLead() && sentStatus === 'accepted') return null;
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
  const lateLeads = await trx('leads').where({ estimate_id: row.id }).whereNotIn('id', leads.map((l) => l.id)).forUpdate().noWait().select('id', 'deleted_at');
  leads.push(...lateLeads);
  // With any lead on the draft (found at the first lock or just now), the
  // accepted-at-this-door hold is judged again on current rows: the first
  // read may predate the link or the acceptance. A hit undoes the archive.
  if (hasLiveLead()) {
    const acceptedNow = (await trx.raw(`
      SELECT a.property_id, a.address
        FROM estimates d
        JOIN estimates a ON a.customer_id = d.customer_id AND a.id <> d.id
                        AND a.status = 'accepted' AND a.created_at > d.created_at
       WHERE d.id = ?
    `, [row.id]))?.rows || [];
    if (acceptedNow.some((a) => sameProperty({ ...pair, sent_property_id: a.property_id, sent_address: a.address }))) throw new KeepDraft();
  }
  if (leads.length) await detachLeads(trx, { pair, draftId: row.id, leads, sentRow: sent.rows[0] });
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
           s.id AS sent_id, s.sent_at, s.property_id AS sent_property_id, s.address AS sent_address,
           CASE WHEN EXISTS (SELECT 1 FROM leads l WHERE l.estimate_id = d.id AND l.deleted_at IS NULL) THEN (
             SELECT json_agg(json_build_object('property_id', a.property_id, 'address', a.address))
               FROM estimates a
              WHERE a.customer_id = d.customer_id AND a.id <> d.id
                AND a.status = 'accepted' AND a.created_at > d.created_at
           ) END AS accepted_later
      FROM (SELECT * FROM estimates WHERE ${DRAFT_ELIGIBLE_SQL}) d
      CROSS JOIN LATERAL (
        SELECT s.id, ${SENT_TIME_SQL('s')} AS sent_at, s.property_id, s.address,
               ROW_NUMBER() OVER (ORDER BY COALESCE(s.property_id = d.property_id, false) DESC,
                                           COALESCE(LOWER(TRIM(s.address)) = LOWER(TRIM(d.address)), false) DESC,
                                           ${SENT_TIME_SQL('s')} DESC) AS rank
          FROM estimates s
         WHERE s.customer_id = d.customer_id
           AND s.id <> d.id
           AND ${SENT_EVIDENCE_SQL('s')}
           AND s.created_at > d.created_at
           AND d.updated_at <= ${SENT_TIME_SQL('s')}
         ORDER BY COALESCE(s.property_id = d.property_id, false) DESC,
                  COALESCE(LOWER(TRIM(s.address)) = LOWER(TRIM(d.address)), false) DESC,
                  ${SENT_TIME_SQL('s')} DESC
         LIMIT ${SENDS_PER_DRAFT}
      ) s
     ORDER BY d.id, s.rank
  `))?.rows || [];

  // First matching send per draft (the lateral lists same-door sends first).
  // No cap here: a candidate retireOneDraft keeps (accepted replacement with
  // a lead, a row changed since the read) must not use up the batch.
  // A lead-linked draft with a later ACCEPTED estimate at the same door is
  // kept whole: that lead belongs to the acceptance flow, so an older sent
  // estimate must not retire the draft and take the lead instead. An accepted
  // estimate for another property does not count.
  const acceptedAtDoor = (pair) => (pair.accepted_later || []).some((accepted) => sameProperty({
    draft_property_id: pair.draft_property_id,
    draft_address: pair.draft_address,
    sent_property_id: accepted.property_id,
    sent_address: accepted.address,
  }));
  // Rows arrive ranked per draft (ORDER BY d.id, s.rank): keep the first match.
  const byDraft = new Map();
  for (const pair of pairs) {
    if (!byDraft.has(pair.draft_id) && sameProperty(pair) && !acceptedAtDoor(pair)) byDraft.set(pair.draft_id, pair);
  }
  const chosen = [...byDraft.values()];

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
