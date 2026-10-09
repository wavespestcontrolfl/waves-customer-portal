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
 *   - no lead links to it, open or closed, unless soft-deleted (owner
 *     2026-10-08): a lead's draft stays for staff. The sweep writes nothing
 *     to leads;
 *   - the sent estimate is a real send: delivered, not reset to draft and
 *     not carrying a call-linkage invalidation marker.
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

// A draft with its own live lifecycle is never retired: an assessment-linked
// pre-draft (ASSESSMENT_EXCEPTION_ABSENT_SQL, kept for staff to price after
// the visit), a booking-page handoff (booking_intents, which the public
// capture can re-open), a staged clarification text (by its estimate_id or,
// for a merged bedroom ask, its bedroom_estimate_id), or ANY lead that is not
// soft-deleted (owner 2026-10-08: a lead's draft stays for staff, and the
// sweep never writes to leads). Both link forms count: leads.estimate_id and
// the draft's own estimate_data.lead_id mirror, which the estimator engine
// keeps as the link when its FK write fails. The mirror is a fallback only,
// as in resolveEstimateEventLeads: it counts while that lead has no FK link
// (a lead staff re-linked to the sent estimate no longer holds the draft). Closed leads count too: one reopened later
// must not point at an archived draft.
const NO_LIVE_DEPENDENTS_SQL = `(
  NOT EXISTS (SELECT 1 FROM booking_intents b WHERE b.pricing_estimate_id = estimates.id)
  AND NOT EXISTS (
    SELECT 1 FROM leads l
     WHERE (l.estimate_id = estimates.id
            OR (l.estimate_id IS NULL AND l.id::text = estimates.estimate_data->>'lead_id'))
       AND l.deleted_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM message_drafts m
     WHERE m.intent = 'estimate_clarify'
       AND (m.flags->>'estimate_id' = estimates.id::text
            OR m.flags->>'bedroom_estimate_id' = estimates.id::text)
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
// The older tracking shape (2026-07 to 2026-08) has no lastDeliveredAt. A
// non-empty sentChannels list alone is NOT proof: a suppressed SMS or an
// idempotent email "success" records a channel with nothing delivered. It
// counts only when the customer opened the estimate (viewed_at). Its time
// is the EARLIER of attemptedAt and viewed_at: a later suppressed resend
// overwrites attemptedAt, but the first view never moves.
const SENT_CHANNELS_SQL = (alias) => `(jsonb_typeof(${alias}.estimate_data #> '{deliveryState,sentChannels}') = 'array'
  AND jsonb_array_length(${alias}.estimate_data #> '{deliveryState,sentChannels}') > 0
  AND ${alias}.viewed_at IS NOT NULL)`;
// Shape AND validity: the shape regex alone lets an ISO-looking but invalid
// value abort the whole candidate query at the cast, and pg_input_is_valid
// alone accepts special literals such as 'infinity'.
const ISO_INSTANT_SQL = (expr) => `(${expr} ~ '^[0-9]{4}-' AND pg_input_is_valid(${expr}, 'timestamptz'))`;
const DELIVERED_AT_SQL = (alias) => ISO_INSTANT_SQL(`(${alias}.estimate_data #>> '{deliveryState,lastDeliveredAt}')`);
const SENT_TIME_SQL = (alias) => `(CASE
  WHEN ${DELIVERED_AT_SQL(alias)}
    THEN (${alias}.estimate_data #>> '{deliveryState,lastDeliveredAt}')::timestamptz
  WHEN ${SENT_CHANNELS_SQL(alias)} AND ${ISO_INSTANT_SQL(`(${alias}.estimate_data #>> '{deliveryState,attemptedAt}')`)}
    THEN LEAST((${alias}.estimate_data #>> '{deliveryState,attemptedAt}')::timestamptz, ${alias}.viewed_at)
  WHEN ${SENT_CHANNELS_SQL(alias)} THEN ${alias}.viewed_at
  ELSE ${alias}.sent_at END)`;

// A real send by staff or a verified flow. sent_at is not required when a
// delivery witness exists: an accept or decline during the first in-flight
// send leaves sent_at null beside a real lastDeliveredAt. A row WITH delivery tracking
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
const SENT_EVIDENCE_SQL = (alias) => `(${alias}.sent_at IS NOT NULL OR COALESCE(${DELIVERED_AT_SQL(alias)}, false))
  AND ${alias}.status <> 'draft'
  AND ${LINKAGE_MARKERS_ABSENT_SQL(alias)}
  AND COALESCE(${alias}.source, '') <> 'quote_wizard'
  AND (jsonb_typeof(${alias}.estimate_data->'deliveryState') IS DISTINCT FROM 'object'
       OR COALESCE(${DELIVERED_AT_SQL(alias)}, false)
       OR COALESCE(${SENT_CHANNELS_SQL(alias)}, false))
  AND (COALESCE(${alias}.source, '') NOT IN ('service_report_cta', 'plan_restart')
       OR COALESCE(${alias}.estimate_data #>> '{deliveryState,firstDeliveredAt}', '') <> '')`;

// Archive one draft and mark its open "draft ready" bells done, in one
// transaction. Lock order: the draft, its leads, then the sent estimate, each
// NOWAIT (a busy row skips this draft for the tick), so the sweep never waits on one
// row while holding another. A Pipeline link takes the draft FOR SHARE NOWAIT
// before its write: it either committed first (the lead predicate in
// DRAFT_ELIGIBLE_SQL then keeps the draft) or is refused until this commits
// and then sees the archive.
async function retireOneDraft(trx, pair) {
  await trx.raw("SET LOCAL lock_timeout = '1500ms'");
  const held = await trx.raw("SELECT id, estimate_data->>'lead_id' AS mirror_lead_id FROM estimates WHERE id = ? FOR UPDATE NOWAIT", [pair.draft_id]);
  if (!held?.rows?.length) return null;
  // Every lead linked to the draft, by FK or by the draft's lead_id mirror,
  // is locked too (NOWAIT, read only): a
  // lead edit in flight — a deleted lead being restored — holds its row, so
  // the sweep skips this tick; once it commits, the lead predicate in the
  // UPDATE below sees it. The sweep still writes nothing to leads.
  await trx.raw(`
    SELECT id FROM leads
     WHERE estimate_id = ? OR id::text = ?
       FOR UPDATE NOWAIT
  `, [pair.draft_id, String(held.rows[0].mirror_lead_id || '')]);
  // The send is judged again on the current row: still a real delivery at
  // the same door and time the read saw.
  const sent = await trx.raw(`
    SELECT id FROM estimates s
     WHERE s.id = ?
       AND s.property_id IS NOT DISTINCT FROM ?
       AND s.address IS NOT DISTINCT FROM ?
       AND date_trunc('milliseconds', ${SENT_TIME_SQL('s')}) = date_trunc('milliseconds', ?::timestamptz)
       AND ${SENT_EVIDENCE_SQL('s')}
     FOR SHARE NOWAIT
  `, [pair.sent_id, pair.sent_property_id, pair.sent_address, pair.sent_at]);
  if (!sent?.rows?.length) return null;
  // Every draft predicate re-checked on the row itself: a draft edited,
  // sent, claimed or linked to an open lead since the read is left alone.
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

  // Rows arrive ranked per draft (ORDER BY d.id, s.rank): keep the first
  // same-door send.
  const byDraft = new Map();
  for (const pair of pairs) {
    if (!byDraft.has(pair.draft_id) && sameProperty(pair)) byDraft.set(pair.draft_id, pair);
  }
  const chosen = [...byDraft.values()];

  const rows = [];
  // What returns null here is transient (a busy row, a change since the
  // read). Attempts are capped too, so a run opens at most 2 x batch
  // transactions.
  let attempts = 0;
  for (const pair of chosen) {
    if (rows.length >= batch || attempts >= batch * 2) break;
    attempts += 1;
    const row = await conn.transaction((trx) => retireOneDraft(trx, pair))
      .catch((err) => { if (BUSY_ROW_CODES.has(err?.code)) return null; throw err; });
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
