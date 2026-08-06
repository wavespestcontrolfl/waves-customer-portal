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
 *   - a call whose comms were held (review card, consent hold) — the
 *     booking landed but neither the confirmation nor the card link went;
 *   - a booking converted to a plan AFTER it was made (phone one-time →
 *     quarterly, admin-created plans) — no trigger looks again;
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
  // outbound-review holds, and already-texted visits. The never-invited
  // filter runs per customer below (two cheap EXISTS reads beat a
  // three-way join here).
  const candidates = await dbh('scheduled_services as s')
    .whereIn('s.status', LIVE_VISIT_STATUSES)
    .whereBetween('s.scheduled_date', [todayEt, horizonEt])
    .whereNull('s.card_link_sent_at')
    .whereNull('s.payer_id')
    .where((qb) => qb.where('s.is_callback', false).orWhereNull('s.is_callback'))
    .whereNot('s.service_type', 'ilike', '%re-service%')
    .where((qb) => qb.whereNull('s.source_action').orWhereNot('s.source_action', OUTBOUND_REVIEW_SOURCE_ACTION))
    .whereNotNull('s.customer_id')
    .orderBy([{ column: 's.scheduled_date', order: 'asc' }, { column: 's.window_start', order: 'asc' }])
    .select('s.id', 's.customer_id', 's.scheduled_date', 's.status', 's.is_callback', 's.service_type', 's.source_action', 's.card_link_sent_at')
    .limit(500);

  const seenCustomers = new Set();
  let considered = 0;
  let sent = 0;
  let skipped = 0;
  for (const visit of candidates) {
    if (sent >= BATCH_CAP) break;
    if (seenCustomers.has(visit.customer_id)) continue;
    seenCustomers.add(visit.customer_id);
    considered += 1;

    let everInvited = true; // fail toward NOT texting
    try {
      const [reqRow, stampRow] = await Promise.all([
        dbh('appointment_card_requests as r')
          .join('scheduled_services as v', 'r.scheduled_service_id', 'v.id')
          .where('v.customer_id', visit.customer_id)
          .first('r.id'),
        dbh('scheduled_services')
          .where({ customer_id: visit.customer_id })
          .whereNotNull('card_link_sent_at')
          .first('id'),
      ]);
      everInvited = !!(reqRow || stampRow);
    } catch (err) {
      logger.warn(`[previsit-card-sweep] invite-history lookup failed for customer ${visit.customer_id} (skipping): ${err.message}`);
    }

    const verdict = previsitCardInviteEligible({
      status: visit.status,
      isCallback: visit.is_callback === true,
      reServiceLabel: /re-?service/i.test(String(visit.service_type || '')),
      outboundReviewPending: visit.source_action === OUTBOUND_REVIEW_SOURCE_ACTION,
      cardLinkSentAt: visit.card_link_sent_at,
      customerEverInvited: everInvited,
    });
    if (!verdict.send) { skipped += 1; continue; }

    try {
      const result = await requestCardForAppointment({
        scheduledServiceId: visit.id,
        trigger: 'previsit_backstop',
      });
      if (result?.requested || result?.action === 'sent' || result?.action === 'auto_secured') sent += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      logger.warn(`[previsit-card-sweep] funnel call failed for visit ${visit.id}: ${err.message}`);
    }
  }

  return { considered, sent, skipped };
}

module.exports = {
  runSweep,
  previsitCardInviteEligible,
  sweepGateEnabled,
  LEAD_DAYS,
  BATCH_CAP,
};
