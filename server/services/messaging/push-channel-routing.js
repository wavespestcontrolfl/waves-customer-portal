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
// Keys are the CONCRETE messageType values live senders use (billing/
// autopay callers override original_message_type with specific types —
// the generic purpose-mapped names alone would never match them).
const PUSH_ROUTING_POLICY = {
  tech_en_route: 'push_first',
  receipt: 'push_first',
  deposit_receipt: 'push_first',
  appointment_reminder: 'push_and_sms',
  reminder_72h: 'push_and_sms',
  // appointment_confirmation / appointment_cancelled are deliberately
  // ABSENT: admin-schedule/admin-dispatch trigger those through shared
  // helpers that carry no operatorInitiated provenance, so routing them
  // would push staff-initiated actions. Add them back only once the
  // shared helpers thread the marker.
  billing_reminder: 'push_and_sms',
  payment_failure: 'push_and_sms',
  payment_failed: 'push_and_sms',
  late_payment: 'push_and_sms',
  payment_expiry: 'push_and_sms',
  autopay: 'push_and_sms',
  autopay_pre_charge: 'push_and_sms',
  autopay_charge_failed: 'push_and_sms',
  autopay_retry_failed: 'push_and_sms',
  autopay_retry_final_failed: 'push_and_sms',
  // Concrete Stripe/ACH failure types (stripe-webhook.js overrides
  // original_message_type with these — the generic payment_failure entry
  // never matches the live sends).
  ach_retry_notice: 'push_and_sms',
  ach_card_fallback: 'push_and_sms',
  ach_suspended: 'push_and_sms',
  bank_verification_incomplete: 'push_and_sms',
  bank_verification_failed: 'push_and_sms',
};

// Lock-screen presentation per message family. Titles are plain Waves
// voice — no emoji. Links are portal routes the native handler opens on
// tap (deep link beats a pasted URL: the notification IS the link).
const BILLING_UPDATE = { title: 'Billing update', link: '/?tab=billing', category: 'billing' };
const PAYMENT_ISSUE = { title: 'Payment issue', link: '/?tab=billing', category: 'billing' };
const PRESENTATION = {
  // en-route deep-links HOME: the authenticated live tracker (map + ETA)
  // renders on the dashboard, not the Visits tab — the tap must land on
  // the same live view the SMS /track link promises.
  tech_en_route: { title: 'Your technician is on the way', link: '/', category: 'service' },
  receipt: { title: 'Payment receipt', link: '/?tab=billing', category: 'billing' },
  deposit_receipt: { title: 'Payment receipt', link: '/?tab=billing', category: 'billing' },
  appointment_reminder: { title: 'Appointment reminder', link: '/?tab=visits', category: 'service' },
  reminder_72h: { title: 'Appointment reminder', link: '/?tab=visits', category: 'service' },
  billing_reminder: BILLING_UPDATE,
  payment_failure: PAYMENT_ISSUE,
  payment_failed: PAYMENT_ISSUE,
  late_payment: PAYMENT_ISSUE,
  payment_expiry: BILLING_UPDATE,
  autopay: BILLING_UPDATE,
  autopay_pre_charge: BILLING_UPDATE,
  autopay_charge_failed: PAYMENT_ISSUE,
  autopay_retry_failed: PAYMENT_ISSUE,
  autopay_retry_final_failed: PAYMENT_ISSUE,
  ach_retry_notice: PAYMENT_ISSUE,
  ach_card_fallback: PAYMENT_ISSUE,
  ach_suspended: PAYMENT_ISSUE,
  bank_verification_incomplete: PAYMENT_ISSUE,
  bank_verification_failed: PAYMENT_ISSUE,
};

function pushPresentation(messageType) {
  return PRESENTATION[messageType] || { title: 'Waves Pest Control', link: '/', category: 'service' };
}

/**
 * Pure routing decision — unit-tested. Everything that must force SMS is
 * decided here; subscription presence and delivery proof are runtime.
 */
function decidePushRoute({ gateOn, customerId, messageType, hasMedia, humanAuthored, operatorInitiated, adminAttributed }) {
  if (!gateOn) return 'sms_only';
  if (!customerId) return 'sms_only';
  if (hasMedia) return 'sms_only'; // push carries no MMS media
  if (humanAuthored) return 'sms_only'; // operator-typed → reply-able SMS
  if (operatorInitiated) return 'sms_only'; // operator chose SMS explicitly
  // Admin attribution = operator provenance even when the entry point never
  // learned the operatorInitiated flag (IB send_sms, comms composer both
  // stamp adminUserId) — staff-triggered sends stay on the channel staff chose.
  if (adminAttributed) return 'sms_only';
  return PUSH_ROUTING_POLICY[messageType] || 'sms_only';
}

async function hasActivePushDevice(customerId, knex = db) {
  const row = await knex('push_subscriptions')
    .where({ customer_id: customerId, active: true })
    .first('id')
    .catch(() => null);
  return Boolean(row);
}

// push_first additionally requires a FRESH device heartbeat. Provider
// acceptance (stats.sent) proves APNs/FCM took the request, not that the
// OS displayed it — a customer who revoked notification permission and
// never reopened the app keeps an accepting-but-silent token until the
// next launch cleans it up. Registration re-fires on every app launch and
// bumps the row's updated_at (routes/push.js), so a recent heartbeat means
// the app was recently open under intact permission. Outside the window,
// push_first falls back to SMS — costless for reliability, since
// push-instead-of-SMS only helps customers actively using the app anyway.
// push_and_sms is exempt: its SMS goes regardless.
const PUSH_FIRST_HEARTBEAT_HOURS = 72;

async function hasFreshPushDevice(customerId, knex = db) {
  const row = await knex('push_subscriptions')
    .where({ customer_id: customerId, active: true })
    .where('updated_at', '>=', heartbeatCutoff())
    .first('id')
    .catch(() => null);
  return Boolean(row);
}

// messageType → the LIVE notification_prefs channel column the actual
// senders consult (appointment-reminders.js, twilio.js en-route,
// scheduler.js receipts). Every type in PUSH_ROUTING_POLICY must map here
// (test-enforced) so a customer channel choice always wins.
const PREF_CHANNEL_COLUMN = {
  tech_en_route: 'en_route_channel',
  receipt: 'payment_receipt_channel',
  deposit_receipt: 'payment_receipt_channel',
  appointment_reminder: 'service_reminder_24h_channel',
  reminder_72h: 'service_reminder_72h_channel',
  billing_reminder: 'billing_channel',
  payment_failure: 'billing_channel',
  payment_failed: 'billing_channel',
  late_payment: 'billing_channel',
  payment_expiry: 'billing_channel',
  autopay: 'billing_channel',
  autopay_pre_charge: 'billing_channel',
  autopay_charge_failed: 'billing_channel',
  autopay_retry_failed: 'billing_channel',
  autopay_retry_final_failed: 'billing_channel',
  ach_retry_notice: 'billing_channel',
  ach_card_fallback: 'billing_channel',
  ach_suspended: 'billing_channel',
  bank_verification_incomplete: 'billing_channel',
  bank_verification_failed: 'billing_channel',
};

// Channel columns that live on the account PRIMARY profile (see
// routes/notifications.js loadPreferencePayload) — everything else
// (billing/receipt) is per charged customer row.
const PRIMARY_SCOPED_COLUMNS = new Set([
  'en_route_channel',
  'service_reminder_24h_channel',
  'service_reminder_72h_channel',
]);

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
 *   2. A NON-DEFAULT channel value ('email' or 'both') on the account's
 *      PRIMARY-profile prefs row is an unambiguous explicit choice and
 *      vetoes routing. Rows at the seeded 'sms' default (or absent)
 *      route normally — presence and timestamps are not provenance
 *      (rows were globally backfilled; unrelated writes restamp them).
 */
async function pushEligibleRuntime(customerId, to, messageType, knex = db) {
  const toDigits = normalizeDigits(to);
  if (toDigits.length < 10) return false;
  const customer = await knex('customers')
    .where({ id: customerId })
    .first('phone', 'account_id')
    .catch(() => null);
  if (!customer || normalizeDigits(customer.phone) !== toDigits) return false;
  const accountId = customer.account_id;

  const col = PREF_CHANNEL_COLUMN[messageType];
  if (col) {
    // Preference OWNERSHIP mirrors routes/notifications.js exactly:
    // appointment/en-route channels are ACCOUNT-level and live on the
    // primary profile, but billing_channel + payment_receipt_channel are
    // deliberately PER CHARGED PROFILE (excluded from the primary-channel
    // list there) — a secondary charged profile's explicit receipt choice
    // must be read from its own row.
    let prefsOwnerId = customerId;
    if (PRIMARY_SCOPED_COLUMNS.has(col)) {
      const { resolvePrimaryProfileId } = require('../../routes/notifications');
      try {
        // onError 'throw': the resolver's default fallback would silently
        // read the CURRENT profile on a transient failure and could
        // override the primary profile's explicit choice — unknown
        // ownership fails closed to SMS instead.
        prefsOwnerId = await resolvePrimaryProfileId(
          { accountId: accountId || null, customerId },
          knex,
          { onError: 'throw' },
        );
      } catch {
        return false;
      }
    }
    const ERR = Symbol('prefs-lookup-failed');
    const prefsRow = await knex('notification_prefs')
      .where({ customer_id: prefsOwnerId })
      .first(col)
      .catch(() => ERR);
    if (prefsRow === ERR) return false; // unknown preference → SMS
    // Value-vs-seeded-default, NOT row presence or timestamps: every
    // mapped column seeds 'sms' (rows were globally backfilled, and
    // unrelated writes restamp updated_at), so only a non-default value —
    // 'email' or 'both' — is an unambiguous explicit choice, and it vetoes.
    //
    // OWNER RULING (2026-08-12) on the 'sms'-valued case: a customer who
    // installed the app, signed in, and ACCEPTED the notification prompt
    // has opted into app notifications — that registration, not the
    // indistinguishable-from-default 'sms' value, is the governing signal,
    // and app-installed customers default to push. Critical templates are
    // push_and_sms (the SMS still goes); a per-customer push opt-out
    // toggle ships with the notification-prefs UI follow-up and will veto
    // here once it exists.
    const value = prefsRow ? String(prefsRow[col] || '').toLowerCase() : '';
    if (value === 'email' || value === 'both') return false;
  }
  return true;
}

// No abandoning outer race — abandonment is what creates duplicates (a
// still-running leg delivering after the SMS fallback). Instead EVERY
// network stage is individually destroy-bounded at 8s (APNs request, FCM
// token fetch + request, web-push request), so the whole sequential
// fan-out is bounded by construction and the caller simply awaits it: no
// leg can still be running when the SMS fallback decision is made.
async function sendPush(customerId, messageType, body, { shouldContinue, minUpdatedAt } = {}) {
  const { title, link, category } = pushPresentation(messageType);
  const PushService = require('../push-notifications');
  const stats = await PushService.sendToCustomer(customerId, {
    title,
    body,
    url: link,
    category,
    tag: `push-routed:${messageType}`,
  }, { shouldContinue, minUpdatedAt });
  return { stats, delivered: Number(stats && stats.sent) > 0 };
}

function heartbeatCutoff() {
  return new Date(Date.now() - PUSH_FIRST_HEARTBEAT_HOURS * 3600 * 1000);
}

// Per-leg send-window gate for the fan-out: the sequential device walk can
// straddle the 20:00 ET cutoff (each leg is bounded at 8s but they add up),
// and a push landing after the cutoff is exactly what the window exists to
// stop. Built from the caller's own boundary check; absent check = no gate
// (non-window senders).
function windowGuardFrom(preSendCheck) {
  if (typeof preSendCheck !== 'function') return undefined;
  return async () => {
    try {
      const verdict = await preSendCheck();
      return Boolean(verdict && verdict.ok === true);
    } catch {
      return false; // unknown window state → stop the fan-out
    }
  };
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
async function attemptPushFirst({ customerId, to, body, messageType, fromNumber, scheduledSmsLogId, preSendCheck }) {
  try {
    if (!(await pushEligibleRuntime(customerId, to, messageType))) return { delivered: false };
    if (!(await hasFreshPushDevice(customerId))) return { delivered: false };
    // The fan-out itself is restricted to fresh-heartbeat rows — a stale
    // accepting-but-silent token must not become the "delivery" that
    // suppresses the SMS while a fresh device failed.
    const { delivered } = await sendPush(customerId, messageType, body, {
      shouldContinue: windowGuardFrom(preSendCheck),
      minUpdatedAt: heartbeatCutoff(),
    });
    if (!delivered) {
      logger.info(`[push-routing] ${messageType}: no device accepted delivery — falling back to SMS`);
      return { delivered: false };
    }
    // PROOF FIRST, bell second: this sms_log row is what
    // recoverStaleScheduledSmsClaims reads as durable proof-of-send — a
    // crash inside the bell insert before the proof exists would let the
    // sweep resend a push the customer already received. History parity:
    // status stays 'sent' (legacy predicates filter on queued/sent/
    // delivered); the channel marker lives in from_phone + metadata. The
    // bell is a courtesy record; its id back-fills into metadata
    // best-effort afterward.
    let proofRowId = null;
    try {
      const inserted = await db('sms_log').insert({
        customer_id: customerId,
        direction: 'outbound',
        from_phone: 'push',
        to_phone: String(to || '').slice(0, 20),
        message_body: body,
        twilio_sid: null,
        status: 'sent',
        message_type: messageType,
        metadata: JSON.stringify({
          channel: 'push',
          ...(scheduledSmsLogId ? { scheduled_sms_log_id: scheduledSmsLogId } : {}),
        }),
      }).returning('id');
      proofRowId = inserted && inserted[0] ? (inserted[0].id || inserted[0]) : null;
    } catch (logErr) {
      logger.error(`[push-routing] sms_log record failed: ${logErr.message}`);
    }
    const notificationId = await recordBell(customerId, messageType, body);
    const sid = notificationId ? `push:${notificationId}` : 'push:delivered';
    if (proofRowId && notificationId) {
      await db('sms_log')
        .where({ id: proofRowId })
        .update({
          metadata: JSON.stringify({
            channel: 'push',
            push_notification_id: notificationId,
            ...(scheduledSmsLogId ? { scheduled_sms_log_id: scheduledSmsLogId } : {}),
          }),
        })
        .catch(() => {});
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
async function sendCompanionPush({ customerId, to, body, messageType, preSendCheck }) {
  try {
    if (!(await pushEligibleRuntime(customerId, to, messageType))) return;
    if (!(await hasActivePushDevice(customerId))) return;
    // The companion starts only after Twilio accepted the SMS, but its own
    // fan-out can still cross the cutoff — same per-leg gate.
    const { delivered } = await sendPush(customerId, messageType, body, {
      shouldContinue: windowGuardFrom(preSendCheck),
    });
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
