'use strict';

/**
 * Push channel routing — app-installed customers receive eligible automated
 * messages as native push notifications instead of (or in addition to) SMS.
 *
 * Dark behind GATE_PUSH_CHANNEL_ROUTING (request-time gateEnvValue read;
 * default OFF). Design rules, in order of importance:
 *
 *   1. FAIL TOWARD SMS. Any doubt — gate off, no active device, push
 *      provider error, zero devices accepting delivery — and the message
 *      goes out as SMS exactly as today. A push only replaces an SMS when
 *      the provider proves at least one device ACCEPTED it (`sent > 0`,
 *      the same delivery-proof contract as the internal-alert redirect in
 *      services/twilio.js).
 *   2. Routing lives INSIDE TwilioService.sendSMS, after EVERY outbound
 *      guard — owner silence, feature gates, the per-template kill switch,
 *      validateOutbound, and the caller's send-window boundary re-check —
 *      so push inherits the full SMS discipline (incl. 8AM–8PM ET quiet
 *      hours) instead of bypassing any of it. Same precedent as the
 *      internal-alert bell/push redirect in that file.
 *   3. push_and_sms fires its push AFTER Twilio accepts the SMS — a failed
 *      or deferred SMS that the pipeline retries can therefore never
 *      duplicate the push/bell leg.
 *   4. Only AUTOMATED template messages route. Conversational,
 *      operator-authored, operator-initiated, and media-carrying messages
 *      stay SMS — a customer can reply to a text, never to a push.
 *   5. Every push-only send stays visible everywhere history is read:
 *      an sms_log row (status 'sent', from_phone 'push', channel marker in
 *      metadata), a conversations touchpoint threaded into the customer's
 *      SMS conversation, and an in-app bell notification for the customer.
 *
 * The per-template matrix is the OWNER-REVIEWED draft: time- and
 * money-critical messages send BOTH channels; only low-stakes
 * informational types are push-first; anything unlisted is sms_only by
 * omission (fail-safe default). Changing a template's channel is a
 * one-line edit here.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');

// messageType (services/twilio.js vocabulary) → routing policy.
//   push_first   — push replaces SMS when delivery is proven; SMS fallback.
//   push_and_sms — both channels; push fires only after the SMS is accepted.
//   (unlisted)   — sms_only.
// Deliberately sms_only by omission: 'manual' + 'ai_assistant'
// (conversational, reply-able), 'review_request' + 'payment_link' +
// 'invoice' (their tap-through tokenized/external links are the whole
// point), 'internal_alert' (owner path), and anything unknown.
const PUSH_ROUTING_POLICY = {
  tech_en_route: 'push_first',
  receipt: 'push_first',
  appointment_reminder: 'push_and_sms',
  reminder_72h: 'push_and_sms',
  appointment_confirmation: 'push_and_sms',
  appointment_cancelled: 'push_and_sms',
  billing_reminder: 'push_and_sms',
  payment_failure: 'push_and_sms',
  autopay: 'push_and_sms',
};

// Lock-screen presentation per message family. Titles are plain Waves
// voice — no emoji. Links are portal routes the native handler opens on
// tap (deep link beats a pasted URL: the notification IS the link).
const PRESENTATION = {
  tech_en_route: { title: 'Your technician is on the way', link: '/?tab=visits', category: 'service' },
  receipt: { title: 'Payment receipt', link: '/?tab=billing', category: 'billing' },
  appointment_reminder: { title: 'Appointment reminder', link: '/?tab=visits', category: 'service' },
  reminder_72h: { title: 'Appointment reminder', link: '/?tab=visits', category: 'service' },
  appointment_confirmation: { title: 'Appointment confirmed', link: '/?tab=visits', category: 'service' },
  appointment_cancelled: { title: 'Appointment update', link: '/?tab=visits', category: 'service' },
  billing_reminder: { title: 'Billing update', link: '/?tab=billing', category: 'billing' },
  payment_failure: { title: 'Payment issue', link: '/?tab=billing', category: 'billing' },
  autopay: { title: 'Billing update', link: '/?tab=billing', category: 'billing' },
};

function pushPresentation(messageType) {
  return PRESENTATION[messageType] || { title: 'Waves Pest Control', link: '/', category: 'service' };
}

/**
 * Pure routing decision — unit-tested. Everything that must force SMS is
 * decided here; subscription presence and delivery proof are runtime.
 */
function decidePushRoute({ gateOn, customerId, messageType, hasMedia, humanAuthored, operatorInitiated }) {
  if (!gateOn) return 'sms_only';
  if (!customerId) return 'sms_only';
  if (hasMedia) return 'sms_only'; // push carries no MMS media
  if (humanAuthored) return 'sms_only'; // operator-typed → reply-able SMS
  if (operatorInitiated) return 'sms_only'; // operator chose SMS explicitly
  return PUSH_ROUTING_POLICY[messageType] || 'sms_only';
}

async function hasActivePushDevice(customerId, knex = db) {
  const row = await knex('push_subscriptions')
    .where({ customer_id: customerId, active: true })
    .first('id')
    .catch(() => null);
  return Boolean(row);
}

// messageType → the notification_prefs channel column governing its family.
// Every type in PUSH_ROUTING_POLICY must map here (test-enforced) so a
// saved customer channel choice always wins.
const PREF_CHANNEL_COLUMN = {
  tech_en_route: 'en_route_channel',
  receipt: 'payment_receipt_channel',
  appointment_reminder: 'service_reminder_channel',
  reminder_72h: 'service_reminder_channel',
  appointment_confirmation: 'service_reminder_channel',
  appointment_cancelled: 'service_reminder_channel',
  billing_reminder: 'billing_channel',
  payment_failure: 'billing_channel',
  autopay: 'billing_channel',
};

function normalizeDigits(phone) {
  return String(phone || '').replace(/\D+/g, '').slice(-10);
}

/**
 * Runtime eligibility beyond the pure decision — both checks fail toward
 * SMS:
 *   1. `to` must be the ACCOUNT HOLDER's own phone. Reminder/en-route
 *      flows can address secondary authorized contacts under the same
 *      customer id; replacing THEIR text with a push to the account
 *      holder's devices would notify the wrong person (and push_and_sms
 *      would duplicate contact-personalized pushes onto one account).
 *   2. A SAVED notification_prefs row is an explicit customer channel
 *      choice — the prefs vocabulary has no 'push' value yet, so any
 *      saved row governing this message family keeps the customer's
 *      chosen channel untouched. Customers who never saved prefs (no
 *      row) route normally.
 */
async function pushEligibleRuntime(customerId, to, messageType, knex = db) {
  const toDigits = normalizeDigits(to);
  if (toDigits.length < 10) return false;
  const customer = await knex('customers')
    .where({ id: customerId })
    .first('phone')
    .catch(() => null);
  if (!customer || normalizeDigits(customer.phone) !== toDigits) return false;

  const col = PREF_CHANNEL_COLUMN[messageType];
  if (col) {
    const ERR = Symbol('prefs-lookup-failed');
    const prefsRow = await knex('notification_prefs')
      .where({ customer_id: customerId })
      .first(col)
      .catch(() => ERR);
    if (prefsRow === ERR) return false; // unknown preference → SMS
    if (prefsRow) return false; // saved explicit channel choice → SMS
  }
  return true;
}

async function sendPush(customerId, messageType, body) {
  const { title, link, category } = pushPresentation(messageType);
  const PushService = require('../push-notifications');
  const stats = await PushService.sendToCustomer(customerId, {
    title,
    body,
    url: link,
    category,
    tag: `push-routed:${messageType}`,
  });
  return { stats, delivered: Number(stats && stats.sent) > 0 };
}

// Durable in-app record, written only AFTER delivery is proven so retry
// loops can never accumulate bell rows for undelivered attempts.
// NotificationService.create (not notifyCustomer) on purpose: the message
// already passed the SMS pipeline's consent checks, and notifyCustomer
// would fire its own second push.
async function recordBell(customerId, messageType, body) {
  try {
    const { title, link, category } = pushPresentation(messageType);
    const NotificationService = require('../notification-service');
    const notif = await NotificationService.create({
      recipientType: 'customer',
      recipientId: customerId,
      category,
      title,
      body,
      link,
    });
    return notif && notif.id ? String(notif.id) : null;
  } catch (err) {
    logger.warn(`[push-routing] bell record failed: ${err.message}`);
    return null;
  }
}

/**
 * push_first attempt, called by TwilioService.sendSMS immediately before
 * the Twilio handoff (all guards + send-window already passed). When a
 * device proves delivery, this writes the same history the SMS path would
 * have — sms_log row + conversations touchpoint — and the caller skips
 * Twilio entirely. Any failure returns { delivered: false } and the SMS
 * proceeds untouched.
 */
async function attemptPushFirst({ customerId, to, body, messageType, fromNumber }) {
  try {
    if (!(await pushEligibleRuntime(customerId, to, messageType))) return { delivered: false };
    if (!(await hasActivePushDevice(customerId))) return { delivered: false };
    const { delivered } = await sendPush(customerId, messageType, body);
    if (!delivered) {
      logger.info(`[push-routing] ${messageType}: no device accepted delivery — falling back to SMS`);
      return { delivered: false };
    }
    const notificationId = await recordBell(customerId, messageType, body);
    const sid = notificationId ? `push:${notificationId}` : 'push:delivered';
    // History parity: status stays 'sent' (legacy predicates filter on
    // queued/sent/delivered); the channel marker lives in from_phone +
    // metadata.
    try {
      await db('sms_log').insert({
        customer_id: customerId,
        direction: 'outbound',
        from_phone: 'push',
        to_phone: String(to || '').slice(0, 20),
        message_body: body,
        twilio_sid: null,
        status: 'sent',
        message_type: messageType,
        metadata: JSON.stringify({ channel: 'push', push_notification_id: notificationId }),
      });
    } catch (logErr) {
      logger.error(`[push-routing] sms_log record failed: ${logErr.message}`);
    }
    // Same unified-history writer the SMS path uses, threaded into the
    // customer's SMS conversation so staff surfaces show the message inline.
    require('../conversations')
      .recordTouchpoint({
        customerId,
        channel: 'sms',
        ourEndpointId: fromNumber,
        contactPhone: to,
        direction: 'outbound',
        body,
        authorType: 'system',
        adminUserId: null,
        twilioSid: null,
        messageType,
        deliveryStatus: 'sent',
      })
      .catch((err) => {
        logger.warn(`[push-routing] touchpoint record failed: ${err.message}`);
      });
    return { delivered: true, sid, notificationId };
  } catch (err) {
    logger.warn(`[push-routing] push_first attempt failed — falling back to SMS: ${err.message}`);
    return { delivered: false };
  }
}

/**
 * push_and_sms companion, fired by TwilioService.sendSMS only AFTER Twilio
 * accepted the SMS — best-effort, never throws into the send path, and a
 * pipeline retry of a FAILED SMS can never reach it.
 */
async function sendCompanionPush({ customerId, to, body, messageType }) {
  try {
    if (!(await pushEligibleRuntime(customerId, to, messageType))) return;
    if (!(await hasActivePushDevice(customerId))) return;
    const { delivered } = await sendPush(customerId, messageType, body);
    if (delivered) await recordBell(customerId, messageType, body);
  } catch (err) {
    logger.warn(`[push-routing] companion push failed (SMS already sent): ${err.message}`);
  }
}

module.exports = {
  decidePushRoute,
  attemptPushFirst,
  sendCompanionPush,
  PUSH_ROUTING_POLICY,
  gatePushRoutingOn: () => gateEnvValue('GATE_PUSH_CHANNEL_ROUTING'),
  // exported for tests
  _test: { pushPresentation, PRESENTATION, PREF_CHANNEL_COLUMN, normalizeDigits, pushEligibleRuntime },
};
