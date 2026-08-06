/**
 * Pre-visit card/Auto Pay invitation BACKSTOP sweep (owner directive
 * 2026-08-06).
 *
 * The PRIMARY invitation moment is booking time — every booking channel
 * (estimate flow, /book wizard, AI call pipeline, admin button) already
 * rides requestCardForAppointment, and the AI call pipeline sends the link
 * FIRST, before the confirmation text (owner ruling 2026-08-06: the
 * appointment is top of mind right after the call). This sweep exists for
 * the visits that moment MISSES:
 *
 *   - a booking converted to a plan AFTER it was made (phone one-time →
 *     quarterly, admin-created plans) — no trigger looks again;
 *   - a phone booking whose card send failed transiently while its
 *     confirmation DID send (the sent confirmation is the durable proof of
 *     the call's SMS clearance — codex r2: a call whose SMS leg was
 *     deliberately withheld stays withheld here too, office-only);
 *   - any historical visit that predates the booking-time triggers.
 *
 * Selection is deliberately conservative — this is an INTRODUCTION, not a
 * dunning ladder:
 *
 *   - visits LEAD_DAYS out or sooner (today included), live statuses only;
 *   - never a callback/re-service visit (free with the plan — a card ask
 *     on a free visit reads as a bill);
 *   - never an outbound-review pending row (office confirms first);
 *   - one visit per customer per run (the soonest), and ONLY for customers
 *     the funnel has never invited anywhere (no appointment_card_requests
 *     row, no card_link_sent_at stamp on any visit) — repeat nudges are a
 *     deliberate NON-goal (owner default 2026-08-06);
 *   - the funnel itself still owns policy: payer exemption, already-on-
 *     Auto-Pay skip, saved-method silent auto-secure, one-text-ever, the
 *     email leg riding a confirmed text, and the lane's two dark levers.
 *
 * DARK BY DEFAULT: inert unless GATE_PREVISIT_CARD_SWEEP=true AND the
 * secure-card lane itself is lit (APPOINTMENT_CARD_REQUEST + active
 * template — isSecureCardLaneReady). Kill = unset the gate.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime, addETDays } = require('../utils/datetime-et');

const LEAD_DAYS = 3;
const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];
// Mirror of CALL_OUTBOUND_REVIEW_SOURCE_ACTION (call-booking-source-actions)
// — required at module top to avoid a cycle with call-recording-processor.
const OUTBOUND_REVIEW_SOURCE_ACTION = require('./call-booking-source-actions').CALL_OUTBOUND_REVIEW_SOURCE_ACTION;
const BATCH_CAP = 25;

function sweepGateEnabled() {
  const flag = process.env.GATE_PREVISIT_CARD_SWEEP;
  return flag === '1' || flag === 'true' || flag === 'on';
}

/**
 * Pure eligibility for one candidate visit (unit-tested): the sweep's own
 * rules only — everything the funnel already owns (payer, autopay, saved
 * method, one-text-ever) is deliberately NOT re-encoded here.
 */
function previsitCardInviteEligible({
  status,
  isCallback = false,
  reServiceLabel = false,
  outboundReviewPending = false,
  cardLinkSentAt = null,
  customerEverInvited = false,
} = {}) {
  if (!LIVE_VISIT_STATUSES.includes(String(status || ''))) return { send: false, reason: 'not_live' };
  if (isCallback || reServiceLabel) return { send: false, reason: 'callback_visit' };
  if (outboundReviewPending) return { send: false, reason: 'outbound_review_pending' };
  if (cardLinkSentAt) return { send: false, reason: 'already_texted' };
  if (customerEverInvited) return { send: false, reason: 'customer_already_invited' };
  return { send: true };
}

async function runSweep(dbh = db) {
  if (!sweepGateEnabled()) return { skipped: true, reason: 'gate_off' };
  const { isSecureCardLaneReady, requestCardForAppointment } = require('./appointment-card-request');
  if (!(await isSecureCardLaneReady())) return { skipped: true, reason: 'card_lane_dark' };

  const todayEt = etDateString();
  const horizonEt = etDateString(addETDays(parseETDateTime(`${todayEt}T12:00`), LEAD_DAYS));

  // Soonest live visit per customer inside the window, minus callbacks,
  // outbound-review holds, already-texted visits, archived customers, and
  // ever-invited customers (all in the query — the per-customer advisory
  // lock below re-checks history at send time for the race window only).
  const candidates = await dbh('scheduled_services as s')
    // Archived customers never get a payment-adjacent invite (codex #3234 r1
    // P1 — the archive route only stamps customers.deleted_at, and the
    // funnel has no deleted-customer guard of its own). Same join the
    // neighboring balance-reminder sweep uses.
    .join('customers as c', 's.customer_id', 'c.id')
    .whereNull('c.deleted_at')
    .whereIn('s.status', LIVE_VISIT_STATUSES)
    .whereBetween('s.scheduled_date', [todayEt, horizonEt])
    .whereNull('s.card_link_sent_at')
    .whereNull('s.payer_id')
    .where((qb) => qb.where('s.is_callback', false).orWhereNull('s.is_callback'))
    .whereNot('s.service_type', 'ilike', '%re-service%')
    .where((qb) => qb.whereNull('s.source_action').orWhereNot('s.source_action', OUTBOUND_REVIEW_SOURCE_ACTION))
    .whereNotNull('s.customer_id')
    // Call-level TCPA holds survive into the sweep (codex r2 P1): a
    // phone-booked visit whose confirmation SMS never sent may have been
    // withheld by a call-level consent/routing decision the sweep cannot
    // reconstruct — fail closed and leave it to the office (the admin
    // send button re-runs the funnel with a human in the loop). A sent
    // confirmation is the durable proof the call's SMS clearance was
    // affirmed and used.
    .where((qb) => qb
      .whereRaw("s.booking_source IS DISTINCT FROM 'phone_call'")
      .orWhereNotNull('s.confirmation_sms_sent_at'))
    // Freshly created visits are excluded for one run (codex r2 P2): the
    // realistic cross-path double-invite is a booking-time trigger still in
    // flight for a visit created moments before the 10:26 sweep touches the
    // same customer. A 15-minute creation cool-off closes that window
    // deterministically (booking triggers fire within their own flow,
    // never 15+ minutes later); the advisory lock below still serializes
    // sweep-vs-sweep, including across replicas.
    .where('s.created_at', '<', dbh.raw("now() - interval '15 minutes'"))
    // First-time customers only, IN the query (codex r2 P1): the funnel
    // skips established customers anyway (owner rule 2026-07-30 —
    // completed history means an established payment relationship), but a
    // post-attempt skip burns the batch cap; mirror the funnel's predicate
    // here so established customers never consume allowance.
    .whereNotExists(function priorCompleted() {
      this.select(dbh.raw('1'))
        .from('scheduled_services as done')
        .whereRaw('done.customer_id = s.customer_id')
        .where('done.status', 'completed');
    })
    // Never-invited is part of the QUERY (codex r1 P2): applying it after a
    // LIMIT let already-invited customers' visits starve eligible first-time
    // customers out of the window entirely.
    .whereNotExists(function historyRequest() {
      this.select(dbh.raw('1'))
        .from('appointment_card_requests as r')
        .join('scheduled_services as v', 'r.scheduled_service_id', 'v.id')
        .whereRaw('v.customer_id = s.customer_id');
    })
    .whereNotExists(function historyStamp() {
      this.select(dbh.raw('1'))
        .from('scheduled_services as v2')
        .whereRaw('v2.customer_id = s.customer_id')
        .whereNotNull('v2.card_link_sent_at');
    })
    .orderBy([{ column: 's.scheduled_date', order: 'asc' }, { column: 's.window_start', order: 'asc' }])
    .select('s.id', 's.customer_id', 's.scheduled_date', 's.status', 's.is_callback', 's.service_type', 's.source_action', 's.card_link_sent_at')
    .limit(500);

  const seenCustomers = new Set();
  let considered = 0;
  let attempts = 0;
  let sent = 0;
  let skipped = 0;
  for (const visit of candidates) {
    // The cap counts funnel ATTEMPTS, not confirmed sends (codex #3234 r1
    // P1): an uncertain provider outcome (timeout/5xx/429) keeps the
    // funnel's claim because the text MAY have been accepted — a sweep that
    // only counted clean sends could fire hundreds of maybe-sent texts
    // through a provider incident.
    if (attempts >= BATCH_CAP) break;
    if (seenCustomers.has(visit.customer_id)) continue;
    seenCustomers.add(visit.customer_id);
    considered += 1;

    const verdict = previsitCardInviteEligible({
      status: visit.status,
      isCallback: visit.is_callback === true,
      reServiceLabel: /re-?service/i.test(String(visit.service_type || '')),
      outboundReviewPending: visit.source_action === OUTBOUND_REVIEW_SOURCE_ACTION,
      cardLinkSentAt: visit.card_link_sent_at,
      customerEverInvited: false, // query-level NOT EXISTS owns the fast path; the locked recheck below owns the race
    });
    if (!verdict.send) { skipped += 1; continue; }

    // One introduction per CUSTOMER, atomically (codex r1 P2): the funnel's
    // claim is per-visit, so a concurrent invite for the same customer's
    // OTHER visit could double-introduce. A customer-keyed advisory lock +
    // in-lock history recheck serializes the sweep against itself (and any
    // other taker of this namespace); the funnel call runs INSIDE the lock
    // so a second locker's recheck sees the request row.
    attempts += 1;
    try {
      await dbh.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['previsit-card-invite', String(visit.customer_id)]);
        const [reqRow, stampRow] = await Promise.all([
          trx('appointment_card_requests as r')
            .join('scheduled_services as v', 'r.scheduled_service_id', 'v.id')
            .where('v.customer_id', visit.customer_id)
            .first('r.id'),
          trx('scheduled_services')
            .where({ customer_id: visit.customer_id })
            .whereNotNull('card_link_sent_at')
            .first('id'),
        ]);
        if (reqRow || stampRow) { skipped += 1; return; }
        const result = await requestCardForAppointment({
          scheduledServiceId: visit.id,
          trigger: 'previsit_backstop',
        });
        if (result?.requested || result?.action === 'sent' || result?.action === 'auto_secured') sent += 1;
        else skipped += 1;
      });
    } catch (err) {
      skipped += 1;
      logger.warn(`[previsit-card-sweep] funnel call failed for visit ${visit.id}: ${err.message}`);
    }
  }

  return { considered, attempts, sent, skipped };
}

module.exports = {
  runSweep,
  previsitCardInviteEligible,
  sweepGateEnabled,
  LEAD_DAYS,
  BATCH_CAP,
};
