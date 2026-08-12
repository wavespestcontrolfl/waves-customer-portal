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
 *   2. This runs INSIDE the SMS channel, after every pipeline validator
 *      (consent, suppression, send-window) has already passed — so push
 *      sends inherit the 8AM–8PM ET quiet-hours discipline instead of
 *      skipping it (validators/send-window.js exempts non-sms channels;
 *      routing at the provider seam closes that hole). The send-window
 *      boundary re-check (preSendCheck) runs before the push attempt for
 *      the same reason it runs before messages.create().
 *   3. Only AUTOMATED template messages route. Conversational and
 *      operator-authored messages ('manual', humanAuthored, media) stay
 *      SMS — a customer can reply to a text, never to a push.
 *   4. Every push-routed message stays visible to staff and customer:
 *      an sms_log row (status 'sent_push', from_phone 'push') keeps the
 *      comms history whole, and an in-app bell notification gives the
 *      customer a durable record behind the lock-screen banner.
 *
 * The per-template matrix below is the OWNER-REVIEWED draft: time- and
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
//   push_and_sms — both channels, always (critical: never rely on push alone).
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
function decidePushRoute({ gateOn, customerId, messageType, hasMedia, humanAuthored }) {
  if (!gateOn) return 'sms_only';
  if (!customerId) return 'sms_only';
  if (hasMedia) return 'sms_only'; // push carries no MMS media
  if (humanAuthored) return 'sms_only'; // operator-typed → reply-able SMS
  return PUSH_ROUTING_POLICY[messageType] || 'sms_only';
}

async function hasActivePushDevice(customerId, knex = db) {
  const row = await knex('push_subscriptions')
    .where({ customer_id: customerId, active: true })
    .first('id')
    .catch(() => null);
  return Boolean(row);
}

// Best-effort history record — comms surfaces read sms_log, so a
// push-routed send must not leave a gap in the customer's thread.
async function recordPushInSmsLog(input, messageType, notificationId) {
  try {
    await db('sms_log').insert({
      customer_id: input.customerId,
      direction: 'outbound',
      from_phone: 'push',
      to_phone: String(input.to || '').slice(0, 20),
      message_body: input.body,
      twilio_sid: null,
      status: 'sent_push',
      message_type: messageType,
      metadata: JSON.stringify({ push_notification_id: notificationId || null }),
    });
  } catch (err) {
    logger.error(`[push-routing] sms_log record failed: ${err.message}`);
  }
}

/**
 * Attempt push routing for one provider-bound message.
 *
 * Returns:
 *   { handled: false }                → proceed with SMS (includes push_and_sms,
 *                                       which pushes best-effort AND sends SMS)
 *   { handled: true, providerResult } → push proven delivered on a push_first
 *                                       type (or the boundary check blocked);
 *                                       caller returns providerResult as-is.
 */
async function maybeRouteViaPush(input, messageType, preSendCheck) {
  const decision = decidePushRoute({
    gateOn: gateEnvValue('GATE_PUSH_CHANNEL_ROUTING'),
    customerId: input.customerId || null,
    messageType,
    hasMedia: Boolean((input.metadata && (input.metadata.mediaUrls || input.metadata.media))),
    humanAuthored: Boolean(input.metadata && input.metadata.humanAuthored === true),
  });
  if (decision === 'sms_only') return { handled: false, decision };

  try {
    if (!(await hasActivePushDevice(input.customerId))) {
      return { handled: false, decision };
    }

    // Send-window boundary parity: the SMS path re-checks at the provider
    // handoff (inside twilio.js, before messages.create). A push replacing
    // that SMS must hit the same wall — quiet hours defer BOTH channels.
    if (typeof preSendCheck === 'function') {
      let verdict;
      try {
        verdict = await preSendCheck();
      } catch (err) {
        verdict = { ok: false, code: 'PRE_SEND_CHECK_FAILED', reason: err.message };
      }
      if (!verdict || verdict.ok !== true) {
        return {
          handled: true,
          decision,
          providerResult: {
            sent: false,
            provider: 'push',
            blocked: true,
            code: verdict?.code || 'PRE_SEND_CHECK_FAILED',
            error: verdict?.reason || 'pre-send check did not pass',
            retryable: verdict?.retryable === true,
            deferred: verdict?.deferred === true,
            nextAllowedAt: verdict?.nextAllowedAt,
          },
        };
      }
    }

    const { title, link, category } = pushPresentation(messageType);

    // Durable in-app record FIRST (mirrors notifyCustomer's bell-then-push
    // order): the bell row survives even if the push provider hiccups.
    let notificationId = null;
    try {
      const NotificationService = require('../notification-service');
      const notif = await NotificationService.create({
        recipientType: 'customer',
        recipientId: input.customerId,
        category,
        title,
        body: input.body,
        link,
      });
      notificationId = notif && notif.id ? String(notif.id) : null;
    } catch (err) {
      logger.warn(`[push-routing] bell record failed (continuing): ${err.message}`);
    }

    const PushService = require('../push-notifications');
    const stats = await PushService.sendToCustomer(input.customerId, {
      title,
      body: input.body,
      url: link,
      category,
      notificationId,
      tag: notificationId ? `push-routed:${notificationId}` : `push-routed:${messageType}`,
    });
    const delivered = Number(stats && stats.sent) > 0;

    if (decision === 'push_and_sms') {
      // Both channels: the SMS still goes out regardless of push outcome.
      return { handled: false, decision, pushDelivered: delivered };
    }

    if (!delivered) {
      // push_first without proof of delivery → SMS fallback. Dead tokens
      // were already deactivated inside sendToCustomer.
      logger.info(`[push-routing] ${messageType}: no device accepted delivery — falling back to SMS`);
      return { handled: false, decision };
    }

    await recordPushInSmsLog(input, messageType, notificationId);
    return {
      handled: true,
      decision,
      providerResult: {
        sent: true,
        provider: 'push',
        providerMessageId: notificationId ? `push:${notificationId}` : 'push:delivered',
        sentAt: new Date().toISOString(),
        raw: { pushStats: { sent: stats.sent, expired: stats.expired, failed: stats.failed, subscriptions: stats.subscriptions } },
      },
    };
  } catch (err) {
    // Any push-side failure → SMS, always.
    logger.warn(`[push-routing] push attempt failed — falling back to SMS: ${err.message}`);
    return { handled: false, decision };
  }
}

module.exports = {
  maybeRouteViaPush,
  decidePushRoute,
  PUSH_ROUTING_POLICY,
  // exported for tests
  _test: { pushPresentation, PRESENTATION },
};
