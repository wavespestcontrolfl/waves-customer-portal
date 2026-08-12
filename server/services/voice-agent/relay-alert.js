/**
 * Voice-relay Phase E — URGENT/HOT-LEAD INTERNAL OWNER ALERT.
 *
 * When Sandy captures a lead she classified `hot` (the prompt defines hot as
 * emergency / swarming / active infestation / angry customer), the owner gets
 * an alert IMMEDIATELY instead of finding it in a digest tomorrow.
 *
 * REUSED MECHANISM (never a parallel one): this is the SAME internal-alert
 * sender the self-booking confirm path uses — routes/booking.js
 * createSelfBooking's `if (process.env.ADAM_PHONE) TwilioService.sendSMS(...,
 * { messageType: 'internal_alert' })` block. services/twilio.js
 * redirectInternalAdminSmsToNotification intercepts owner-phone +
 * internal_alert sends at the top of sendSMS and delivers them through the
 * admin bell/push path. Nothing here talks to Twilio directly.
 *
 * NOT CUSTOMER-FACING, EVER. The house rule ("the owner sends all customer
 * communications") is untouched: the only recipient this module can address is
 * the owner phone from the environment, and the only messageType it can send
 * is 'internal_alert'. There is no code path from the voice agent to
 * sendCustomerMessage / a customer SMS or email.
 *
 * GATE: the existing context gate (VOICE_RELAY_CONTEXT_ENABLED === 'true',
 * fail-closed). Gate off ⇒ no alert, no sender loaded, no env read.
 *
 * IDEMPOTENT: at most ONE SUCCESSFUL alert per call. The session owns the flag
 * (relay-conversation's tool ctx: ctx.ownerAlerted / ctx.markOwnerAlerted), so
 * a model that calls capture_lead twice — or a retry after a tool error —
 * cannot page the owner twice. The flag is set AFTER the send returns: a
 * transient failure must not consume the one-per-call budget and silently
 * swallow the page.
 *
 * FAIL-OPEN: an alert failure must never break the call or the lead write.
 * Everything is inside a try/catch that logs and returns false. Phone numbers
 * are masked in logs (the alert BODY carries the real callback number — that
 * is the point of the alert, and it goes only to the owner).
 */

const logger = require('../logger');
const { maskPhone } = require('./relay-protocol');

const MAX_ALERT_BODY = 480; // two-ish SMS segments; the bell/push render truncates anyway

/**
 * Did an internal alert actually LAND? services/twilio.js suppresses
 * owner-phone `internal_alert` sends and redirects them to the admin
 * bell/push path — and that redirect returns `success: true` even when the
 * notification write failed (`notificationUndelivered` / `notificationError`),
 * because the SMS fallback is deliberately not taken. Only an explicit
 * failure marker counts as undelivered, so a plain SMS result (no redirect
 * keys) still reads as delivered.
 */
function internalAlertDelivered(result) {
  if (!result || result.success === false) return false;
  if (result.notificationUndelivered === true || result.notificationError === true) return false;
  return true;
}

/** The owner phone, using the SAME env precedence the alert callers use. */
function ownerAlertPhone() {
  return String(process.env.ADAM_PHONE || '').trim() || null;
}

/** One flat, quote-free line for the alert body. */
function alertSafe(value, max = 80) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Build the owner-facing alert body. Internal surface: the callback number is
 * deliberately in full so the owner can call back from the notification.
 */
function buildHotLeadAlert({ firstName, lastName, phone, city, requestedService, urgencyReason, summary, existingCustomer }) {
  const name = [alertSafe(firstName, 40), alertSafe(lastName, 40)].filter(Boolean).join(' ');
  const lines = [
    '🚨 URGENT lead from the phone assistant:',
    name || 'Caller name not given',
    alertSafe(phone, 20) || 'no callback number',
  ];
  if (city) lines.push(alertSafe(city, 40));
  if (existingCustomer) lines.push('EXISTING CUSTOMER');
  if (requestedService) lines.push(`Wants: ${alertSafe(requestedService, 80)}`);
  if (urgencyReason) lines.push(`Why urgent: ${alertSafe(urgencyReason, 120)}`);
  if (summary) lines.push(alertSafe(summary, 160));
  lines.push('Call them back — this was flagged hot on the call.');
  return lines.join('\n').slice(0, MAX_ALERT_BODY);
}

/**
 * Fire the internal hot-lead alert for THIS call. Returns true when an alert
 * was actually sent, false in every other case (gate off, not hot, already
 * alerted, no owner phone configured, send failed).
 *
 * @param {object} lead   { first_name, last_name, phone, city, requested_service,
 *                          urgency_reason, call_summary, lead_quality }
 * @param {object} ctx    the relay session tool ctx (callSid, ownerAlerted,
 *                        markOwnerAlerted, customerId)
 */
async function alertOwnerHotLead(lead = {}, ctx = {}) {
  try {
    const { isContextEnabled } = require('./relay-context');
    if (!isContextEnabled()) return false;
    if (String(lead.lead_quality || '').toLowerCase() !== 'hot') return false;
    // One per CALL, never per turn. The session exposes a LIVE reader
    // (isOwnerAlerted) because the tool ctx is rebuilt each turn while two
    // capture_lead calls can land inside one turn; a plain `ownerAlerted`
    // boolean is honoured too so a test ctx stays simple.
    const alreadyAlerted = typeof ctx.isOwnerAlerted === 'function'
      ? ctx.isOwnerAlerted() === true
      : ctx.ownerAlerted === true;
    if (alreadyAlerted) return false;

    const to = ownerAlertPhone();
    if (!to) {
      logger.warn('[voice-relay-alert] hot lead captured but ADAM_PHONE is unset — no owner alert sent');
      return false;
    }

    const body = buildHotLeadAlert({
      firstName: lead.first_name,
      lastName: lead.last_name,
      phone: lead.phone,
      city: lead.city,
      requestedService: lead.requested_service,
      urgencyReason: lead.urgency_reason,
      summary: lead.call_summary,
      existingCustomer: Boolean(ctx.customerId),
    });

    // The SAME sender + messageType the self-booking confirm alert uses.
    const TwilioService = require('../twilio');
    const sent = await TwilioService.sendSMS(to, body, { messageType: 'internal_alert' });
    // ⭐ `success: true` IS NOT DELIVERY ON THIS PATH. The internal-alert
    // redirect (services/twilio.js redirectInternalAdminSmsToNotification)
    // returns success:true with `notificationUndelivered` / `notificationError`
    // when the bell/push write itself failed — it suppressed the SMS and had
    // nowhere to put the alert. Latching on that consumed the one-per-call
    // budget for an alert nobody ever saw, and blocked the retry that would
    // have paged the owner.
    if (!internalAlertDelivered(sent)) {
      logger.error(
        `[voice-relay-alert] hot-lead owner alert NOT delivered callSid=${ctx.callSid || 'n/a'} `
        + `(${sent && sent.notificationError ? 'notification error' : 'notification undelivered'}) — latch left open for a retry`
      );
      return false;
    }
    // ⭐ THE LATCH IS SET AFTER A SUCCESSFUL SEND, NOT BEFORE IT. Marking first
    // meant a transient Twilio/DB blip PERMANENTLY consumed the one-per-call
    // budget: the retry (or the second capture_lead) saw `alreadyAlerted` and
    // returned quietly, and the hot lead — a swarm, a sting, an angry customer —
    // was never paged at all. The failure path below now leaves the latch open
    // so the next attempt on this call can still get through, and the send
    // itself stays idempotent-by-latch once it succeeds.
    if (typeof ctx.markOwnerAlerted === 'function') ctx.markOwnerAlerted();
    logger.info(`[voice-relay-alert] hot-lead owner alert sent callSid=${ctx.callSid || 'n/a'} caller=${maskPhone(lead.phone)}`);
    return true;
  } catch (err) {
    // FAIL-OPEN, loudly: the lead is already written and the caller is still
    // on the line — an alert failure can never surface to either. The
    // one-per-call latch is deliberately NOT set here, so a later attempt on
    // this same call can still page the owner.
    logger.error(`[voice-relay-alert] hot-lead owner alert FAILED callSid=${ctx.callSid || 'n/a'}: ${err.message}`);
    return false;
  }
}

/**
 * Build the owner-facing body for a voice-filed RE-SERVICE. Internal surface.
 */
function buildReserviceAlert({ lane, urgency, subject, issue, covered, requestId, unverifiedRequester, unverifiedNote }) {
  const lines = [
    `${urgency === 'urgent' ? '🚨 URGENT ' : ''}Re-service filed by the phone assistant`,
  ];
  // ⭐ SECOND LINE, ALWAYS, when the caller only matched a secondary contact
  // slot (spouse/tenant/prior occupant — relay-reservice's stamp). The body is
  // sliced to MAX_ALERT_BODY and the bell/push render truncates again, so a
  // warning further down could be cut off; this one cannot be.
  if (unverifiedRequester) {
    lines.push(`⚠️ ${alertSafe(unverifiedNote, 200)
      || 'UNVERIFIED third-party requester — verify identity before confirming.'}`);
  }
  lines.push(
    `Lane: ${alertSafe(lane, 20)}`,
    alertSafe(subject || issue, 200),
  );
  if (covered) lines.push('Covered by their plan (free re-service).');
  if (requestId) lines.push(`Request ${alertSafe(requestId, 40)}`);
  // The ticket queue is a known black hole — this alert IS the routing fix.
  lines.push('Get them on the schedule — do not leave this in the request queue.');
  return lines.join('\n').slice(0, MAX_ALERT_BODY);
}

/**
 * ⭐ OWNER-RULED: every voice-filed re-service pages the owner.
 *
 * routes/requests.js 409s a covered pest/lawn ticket because the ticket queue
 * is "a proven black hole — 14 requests, zero resolved". The voice agent must
 * still file the ticket (it is the durable record) and cannot use the
 * streamline's booking half (that fires customer comms, which the agent may
 * never do) — so the alert is what makes the ticket reach a human.
 *
 * Reuses the SAME internal sender as the hot-lead alert. Not idempotent-latched
 * like the hot-lead path: request_reservice already refuses to file a second
 * ticket in a lane, so one filed ticket is one alert by construction.
 *
 * Returns true when an alert was actually sent. Never throws.
 */
async function alertOwnerReservice(request = {}, ctx = {}) {
  try {
    const { isContextEnabled } = require('./relay-context');
    if (!isContextEnabled()) return false;
    const to = ownerAlertPhone();
    if (!to) {
      logger.warn('[voice-relay-alert] re-service filed but ADAM_PHONE is unset — no owner alert sent');
      return false;
    }
    const TwilioService = require('../twilio');
    const sent = await TwilioService.sendSMS(to, buildReserviceAlert(request), { messageType: 'internal_alert' });
    // Same success-is-not-delivery rule as the hot-lead path: the ticket is
    // durable either way, but an alert that never reached the bell must say so
    // (the whole point of this lane is reaching a human, not the queue).
    if (!internalAlertDelivered(sent)) {
      logger.error(
        `[voice-relay-alert] re-service owner alert NOT delivered callSid=${ctx.callSid || 'n/a'} `
        + `request=${request.requestId || 'n/a'} — the ticket is filed but unannounced`
      );
      return false;
    }
    logger.info(`[voice-relay-alert] re-service owner alert sent callSid=${ctx.callSid || 'n/a'} request=${request.requestId || 'n/a'}`);
    return true;
  } catch (err) {
    logger.error(`[voice-relay-alert] re-service owner alert FAILED callSid=${ctx.callSid || 'n/a'}: ${err.message}`);
    return false;
  }
}

module.exports = {
  alertOwnerHotLead,
  alertOwnerReservice,
  buildHotLeadAlert,
  buildReserviceAlert,
  ownerAlertPhone,
  MAX_ALERT_BODY,
};
