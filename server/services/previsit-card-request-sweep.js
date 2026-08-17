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
 *     on a free visit reads as a bill), never an unpriced/zero-price visit
 *     (the funnel's own owner rule — mirrored so they can't burn the cap);
 *   - call-linked rows (outbound-review rows included) need the durable
 *     call_sms_cleared_at stamp — a call-level SMS hold honored at booking
 *     stays honored here. An office confirmation of an outbound-review row
 *     IS a clearance decision and stamps it (runOutboundReviewConfirmHook);
 *     a lazily-activated legacy row (silent reschedule) is NOT and never
 *     re-admits on status alone (Codex #3361 r27 P1);
 *   - never a customer with a LIVE RECURRING series (owner ruling
 *     2026-08-15): a recurring plan is an established relationship even
 *     when pre-portal history left no completed visit rows for the
 *     first-time predicate to see — the backstop is for one-time bookings;
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
// Mirror of OFFICE_REVIEW_PENDING_SOURCE_ACTIONS (call-booking-source-actions)
// — required at module top to avoid a cycle with call-recording-processor.
// Voice-agent bookings share the outbound-review treatment: pending rows stay
// excluded from the sweep; the office confirmation is the clearance decision.
const OFFICE_REVIEW_SOURCE_ACTIONS = require('./call-booking-source-actions').OFFICE_REVIEW_PENDING_SOURCE_ACTIONS;
const { ALWAYS_FREE_SERVICE_TYPE_PATTERNS, isAlwaysFreeServiceType } = require('./no-cost-visit-types');
// Shared active-plan status vocabulary (codex #3426 r1 P1): recurring
// evidence must count every NON-TERMINAL row — an in-progress (en_route/
// on_site) recurring visit is still an active plan — not just the sweep's
// own pending/confirmed candidate statuses.
const { TERMINAL_STATUSES } = require('./waveguard-existing-services');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
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
  outboundReviewUncleared = false,
  cardLinkSentAt = null,
  customerEverInvited = false,
  existingRecurringCustomer = false,
} = {}) {
  if (!LIVE_VISIT_STATUSES.includes(String(status || ''))) return { send: false, reason: 'not_live' };
  if (isCallback || reServiceLabel) return { send: false, reason: 'callback_visit' };
  if (outboundReviewUncleared) return { send: false, reason: 'outbound_review_uncleared' };
  if (cardLinkSentAt) return { send: false, reason: 'already_texted' };
  if (customerEverInvited) return { send: false, reason: 'customer_already_invited' };
  if (existingRecurringCustomer) return { send: false, reason: 'existing_recurring_customer' };
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
    // Payer-billed visits resolve by the CANONICAL precedence (payer.js
    // resolveForInvoice: per-job payer_id ?? customers.payer_id unless the
    // visit pins self-pay; an INACTIVE payer link falls back to self-pay,
    // codex r5) — mirrored here so payer-billed visits never burn the cap
    // while deactivated-payer customers are still invited.
    .leftJoin('payers as pj', 'pj.id', 's.payer_id')
    .leftJoin('payers as pa', 'pa.id', 'c.payer_id')
    .where((qb) => qb
      // per-job link present but INACTIVE → canonical self-pay (never falls
      // through to the account payer)
      .where((jobInactive) => jobInactive
        .whereNotNull('s.payer_id')
        .whereRaw('pj.active IS DISTINCT FROM TRUE'))
      // no per-job link, visit pinned self-pay
      .orWhere((pinned) => pinned
        .whereNull('s.payer_id')
        .where('s.self_pay_override', true))
      // no per-job link, account payer absent or inactive
      .orWhere((acct) => acct
        .whereNull('s.payer_id')
        .where((a2) => a2.whereNull('c.payer_id').orWhereRaw('pa.active IS DISTINCT FROM TRUE'))))
    .where((qb) => qb.where('s.is_callback', false).orWhereNull('s.is_callback'))
    // EVERY canonical always-free label is excluded (codex r5: an
    // Estimate/Follow-up/Re-Visit row with a stale positive price would get
    // a card + cancellation-fee ask for work completion never invoices) —
    // the shared no-cost-visit-types patterns, not a parallel list.
    .where((qb) => {
      for (const pattern of ALWAYS_FREE_SERVICE_TYPE_PATTERNS) {
        qb.whereRaw("COALESCE(s.service_type, '') NOT ILIKE ?", [`%${pattern}%`]);
      }
    })
    .whereNotNull('s.customer_id')
    // Funnel positive-price predicate mirrored (codex r3 P1: the funnel
    // skips unpriced/zero-price visits by owner rule 2026-07-30, and
    // phone-booked recurring rows intentionally carry no price — they must
    // not consume the batch allowance).
    .where('s.estimated_price', '>', 0)
    // Call-level TCPA holds survive into the sweep (codex r2/r3): ANY
    // call-linked row — phone_call booking_source, a source_call_log_id
    // linkage (attached manual bookings included), or an office-review row
    // (outbound-callback OR voice-agent — OFFICE_REVIEW_SOURCE_ACTIONS)
    // — needs the ONE durable clearance record before the sweep may
    // text: call_sms_cleared_at, stamped at the exact decision point that
    // releases the call's SMS legs (no proxy: reminder rows register
    // regardless of holds, and confirmation_sent_at stamps even on skipped
    // sends). For outbound-review rows the stamping decision point is the
    // OFFICE confirmation — runOutboundReviewConfirmHook stamps it on the
    // office-confirm path, and ONLY there. status='confirmed' is no
    // clearance evidence anymore (Codex #3361 r27 P1): after the review-
    // hold removal a silent reschedule of a legacy pending row also lands
    // on 'confirmed' via lazy activation, and that is not a customer trust
    // point. Pre-removal office-confirmed rows without the stamp stay
    // office-only (the admin send button) — fail closed on a
    // payment-adjacent text.
    .where((qb) => qb
      .where((nonCall) => nonCall
        .whereRaw("s.booking_source IS DISTINCT FROM 'phone_call'")
        .whereNull('s.source_call_log_id')
        // NULL-safe by construction: SQL `NULL <> 'x'` is NULL, so a row with
        // no source_action only survives via the explicit whereNull leg.
        .where((sa) => sa.whereNull('s.source_action').orWhereNotIn('s.source_action', OFFICE_REVIEW_SOURCE_ACTIONS)))
      .orWhereNotNull('s.call_sms_cleared_at'))
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
    // Existing RECURRING customers are never backstopped (owner ruling
    // 2026-08-15). The completed-history predicate above misses members
    // whose service history predates the portal's visit rows (pre-portal
    // imports carry no completed scheduled_services), so a 16-month member
    // read as first-time and got a "finish booking" + cancel-fee text on a
    // plan visit he'd already confirmed. A live recurring series — the
    // candidate visit itself included — is its own proof of an established
    // relationship; new plan conversions still get their card invite at
    // booking time from the funnel's primary trigger.
    .whereNotExists(function recurringPlan() {
      this.select(dbh.raw('1'))
        .from('scheduled_services as rec')
        .whereRaw('rec.customer_id = s.customer_id')
        .whereNotIn('rec.status', TERMINAL_STATUSES)
        .where((qb) => qb.where('rec.is_recurring', true).orWhereNotNull('rec.recurring_parent_id'));
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
    .select('s.id', 's.customer_id', 's.scheduled_date', 's.status', 's.is_callback', 's.service_type', 's.source_action', 's.card_link_sent_at', 's.call_sms_cleared_at', 's.call_sms_cleared_recipient')
    .limit(500);

  const seenCustomers = new Set();
  let considered = 0;
  let attempts = 0;
  let sent = 0;
  let autoSecured = 0;
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
      reServiceLabel: isAlwaysFreeServiceType(visit.service_type),
      // Clearance-stamped or not at all (Codex #3361 r27 P1) — mirrors the
      // query's call-linked clause; status is deliberately not consulted.
      // Membership, not a single marker: voice-agent bookings share the
      // office-review lifecycle (OFFICE_REVIEW_SOURCE_ACTIONS).
      outboundReviewUncleared: OFFICE_REVIEW_SOURCE_ACTIONS.includes(visit.source_action) && !visit.call_sms_cleared_at,
      cardLinkSentAt: visit.card_link_sent_at,
      customerEverInvited: false, // query-level NOT EXISTS owns the fast path; the locked recheck below owns the race
      existingRecurringCustomer: false, // same split: the recurringPlan NOT EXISTS owns the fast path, the locked recheck owns the race
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
        // Rung 6 (customer-comms) closes the conversion race END TO END
        // (codex #3426 r2): every plan-conversion writer holds
        // `customer-comms:<id>` around its scheduled_services inserts
        // (customer-comms-lock.js contract; estimate-converter takes it on
        // both its own-transaction and caller-trx seeding paths), and this
        // transaction stays open through the funnel call BELOW — send
        // included. So a conversion either commits before this lock is
        // granted (the recheck sees the recurring row and skips) or waits
        // until after this commit (the customer was genuinely not recurring
        // at send time). The private invite key alone couldn't do this —
        // conversion writers never take it. Order vs the invite key is
        // free of cycles: this sweep is that key's only taker.
        await lockCustomerComms(trx, visit.customer_id);
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['previsit-card-invite', String(visit.customer_id)]);
        const [reqRow, stampRow, liveCustomer, recurringRow] = await Promise.all([
          trx('appointment_card_requests as r')
            .join('scheduled_services as v', 'r.scheduled_service_id', 'v.id')
            .where('v.customer_id', visit.customer_id)
            .first('r.id'),
          trx('scheduled_services')
            .where({ customer_id: visit.customer_id })
            .whereNotNull('card_link_sent_at')
            .first('id'),
          // Archive race (codex r5): an admin archiving the customer between
          // the candidate query and this send must win — recheck under the
          // lock, fail toward not texting.
          trx('customers')
            .where({ id: visit.customer_id })
            .whereNull('deleted_at')
            .first('id'),
          // Recurring-plan race (owner ruling 2026-08-15): a booking
          // converted to a plan between the candidate query and this send
          // makes the customer an existing recurring customer — recheck
          // under the lock, fail toward not texting.
          trx('scheduled_services as rec')
            .where('rec.customer_id', visit.customer_id)
            .whereNotIn('rec.status', TERMINAL_STATUSES)
            .where((qb) => qb.where('rec.is_recurring', true).orWhereNotNull('rec.recurring_parent_id'))
            .first('rec.id'),
        ]);
        if (reqRow || stampRow || !liveCustomer || recurringRow) { skipped += 1; return; }
        const result = await requestCardForAppointment({
          scheduledServiceId: visit.id,
          trigger: 'previsit_backstop',
          // A call-cleared visit's send goes to the recipient the clearance
          // covered (codex r4: implied-consent redirects can point at the
          // caller's ANI, not customers.phone); non-call rows carry null and
          // take the funnel's normal recipient resolution.
          recipientPhone: visit.call_sms_cleared_recipient || null,
        });
        // Launch metrics tell the truth (codex r4 P2): auto-secure enrolls a
        // saved method SILENTLY — it is not a sent invitation.
        if (result?.action === 'sent' || result?.requested === true) sent += 1;
        else if (result?.action === 'auto_secured') autoSecured += 1;
        else skipped += 1;
      });
    } catch (err) {
      skipped += 1;
      logger.warn(`[previsit-card-sweep] funnel call failed for visit ${visit.id}: ${err.message}`);
    }
  }

  return { considered, attempts, sent, autoSecured, skipped };
}

module.exports = {
  runSweep,
  previsitCardInviteEligible,
  sweepGateEnabled,
  LEAD_DAYS,
  BATCH_CAP,
};
