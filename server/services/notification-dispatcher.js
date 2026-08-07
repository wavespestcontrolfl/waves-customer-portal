const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

// Map notification types to their toggle column and channel column in notification_prefs
const TYPE_MAP = {
  service_reminder:  { toggle: 'service_reminder_24h', channel: 'service_reminder_channel' },
  en_route:          { toggle: 'tech_en_route',        channel: 'en_route_channel' },
  service_complete:  { toggle: 'service_completed',    channel: 'service_complete_channel' },
  // No toggle (owner ruling 2026-08-01): billing notices carry no
  // per-purpose opt-out — billing_reminder is ignored (column dropped in a
  // follow-up deploy). A null toggle reads prefs[null] === undefined, which
  // passes the type-enabled check; sms_enabled and the channel preference
  // still apply downstream.
  billing:           { toggle: null,                   channel: 'billing_channel' },
  seasonal:          { toggle: 'seasonal_tips',        channel: 'seasonal_channel' },
  review_request:    { toggle: 'review_request',       channel: 'review_request_channel' },
  referral:          { toggle: 'referral_nudge',       channel: 'referral_channel' },
  marketing:         { toggle: 'marketing_offers',     channel: 'marketing_channel' },
  payment_receipt:   { toggle: 'payment_receipt',      channel: 'payment_receipt_channel' },
  weather_alert:     { toggle: 'weather_alerts',       channel: 'weather_alert_channel' },
};

function purposeForNotificationType(type) {
  if (['service_reminder', 'en_route', 'service_complete', 'weather_alert'].includes(type)) return 'appointment';
  if (type === 'billing') return 'billing';
  if (type === 'payment_receipt') return 'payment_receipt';
  if (type === 'review_request') return 'review_request';
  if (type === 'referral') return 'referral';
  if (type === 'seasonal' || type === 'marketing') return 'marketing';
  return 'conversational';
}

// Customer-level quiet-hours check (prefs are ET wall-clock — the server
// runs UTC). Shared by notify() and the deferred-replay recheck so both
// enforce the same window shape.
function inCustomerQuietHours(prefs, at = new Date()) {
  if (!prefs?.quiet_hours_start || !prefs?.quiet_hours_end) return false;
  const et = etParts(at);
  const currentTime = `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`;
  const start = prefs.quiet_hours_start.substring(0, 5);
  const end = prefs.quiet_hours_end.substring(0, 5);
  return start <= end
    ? (currentTime >= start && currentTime <= end)
    : (currentTime >= start || currentTime <= end);
}

// Replay-time preference recheck for a quiet-hours-deferred notification
// (deferred-replay registry): the queued row replays through the generic
// executor, which knows nothing about the dispatcher's per-type toggles,
// channel choices, or customer quiet hours — and any of those can change
// overnight. Suppression mirrors the immediate dispatcher exactly (it
// drops on all three without retrying); a read failure fails closed as
// retryable.
async function deferredNotificationStillWanted(notificationType, customerId) {
  try {
    const typeConfig = TYPE_MAP[notificationType];
    if (!typeConfig || !customerId) return { eligible: true };
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (prefs && typeConfig.toggle && prefs[typeConfig.toggle] === false) {
      return { eligible: false, reason: 'type_disabled' };
    }
    const channel = prefs?.[typeConfig.channel] || 'sms';
    if (channel !== 'sms' && channel !== 'both') {
      return { eligible: false, reason: `channel_${channel}` };
    }
    if (inCustomerQuietHours(prefs)) {
      return { eligible: false, reason: 'customer_quiet_hours' };
    }
    return { eligible: true };
  } catch (err) {
    logger.warn(`[notify] deferred recheck failed for ${customerId}/${notificationType} (holding for retry): ${err.message}`);
    return { eligible: false, reason: 'recheck-failed', retryable: true };
  }
}

const NotificationDispatcher = {

  /**
   * Send a notification to a customer, respecting their preferences.
   *
   * @param {string} customerId
   * @param {string} notificationType — key from TYPE_MAP
   * @param {object} options — { smsMessage, emailSubject, emailBody }
   * @returns {{ sent: boolean, channel: string|null, results: object }}
   */
  async notify(customerId, notificationType, { smsMessage, emailSubject, emailBody } = {}) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) {
      logger.warn(`[notify] Customer ${customerId} not found`);
      return { sent: false, channel: null, results: { error: 'customer_not_found' } };
    }

    const typeConfig = TYPE_MAP[notificationType];
    if (!typeConfig) {
      logger.warn(`[notify] Unknown notification type: ${notificationType}`);
      return { sent: false, channel: null, results: { error: 'unknown_type' } };
    }

    // Get preferences (or defaults)
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();

    // Check if type is enabled
    if (prefs && prefs[typeConfig.toggle] === false) {
      logger.info(`[notify] ${notificationType} disabled for customer ${customerId}`);
      return { sent: false, channel: null, results: { reason: 'type_disabled' } };
    }

    // Check quiet hours (shared helper — also enforced by the deferred-
    // replay recheck so a queued notification honors the same window)
    if (inCustomerQuietHours(prefs)) {
      logger.info(`[notify] Quiet hours active for customer ${customerId} (${prefs.quiet_hours_start}-${prefs.quiet_hours_end})`);
      return { sent: false, channel: null, results: { reason: 'quiet_hours' } };
    }

    // Determine channel
    const channel = prefs?.[typeConfig.channel] || 'sms';
    const results = {};
    let sent = false;

    // Send SMS
    if ((channel === 'sms' || channel === 'both') && smsMessage && customer.phone) {
      try {
        const purpose = purposeForNotificationType(notificationType);
        const smsResult = await sendCustomerMessage({
          to: customer.phone,
          body: smsMessage,
          channel: 'sms',
          audience: 'customer',
          purpose,
          customerId: customer.id,
          identityTrustLevel: 'phone_matches_customer',
          entryPoint: 'notification_dispatcher',
          consentBasis: purpose === 'marketing' ? {
            status: 'opted_in',
            source: 'notification_prefs',
            capturedAt: prefs?.updated_at || prefs?.created_at || new Date().toISOString(),
          } : undefined,
          metadata: {
            original_message_type: notificationType,
          },
        });
        if (smsResult.sent) {
          results.sms = 'sent';
          sent = true;
        } else if (smsResult.code === 'QUIET_HOURS_HOLD'
          && smsResult.deferred
          && smsResult.nextAllowedAt) {
          // Send-window hold: this dispatcher's callers stamp "notified"
          // off `sent` and never retry, so a held notification must be
          // durably queued for the window open — the queued row owns
          // delivery, so it counts as sent for the caller's stamp.
          try {
            const TWILIO_NUMBERS = require('../config/twilio-numbers');
            await db('sms_log').insert({
              customer_id: customer.id,
              direction: 'outbound',
              from_phone: TWILIO_NUMBERS.getOutboundNumber(),
              to_phone: customer.phone,
              message_body: smsMessage,
              status: 'scheduled',
              scheduled_for: new Date(smsResult.nextAllowedAt),
              message_type: notificationType,
              metadata: JSON.stringify({
                entry_point: 'notification_dispatcher_deferred',
                notification_type: notificationType,
                notify_customer_id: customer.id,
                original_block_code: smsResult.code,
                replay_purpose: purpose,
                refresh_customer_phone: true,
                resolve_from_by_customer: true,
              }),
            });
            results.sms = 'scheduled';
            sent = true;
            logger.info(`[notify] ${notificationType} SMS for ${customerId} held outside the 8AM-8PM ET send window — queued for ${smsResult.nextAllowedAt}`);
          } catch (queueErr) {
            results.sms = `blocked: ${smsResult.code}`;
            logger.error(`[notify] Held SMS requeue failed for ${customerId}: ${queueErr.message}`);
          }
        } else {
          results.sms = `blocked: ${smsResult.code || smsResult.reason || 'unknown'}`;
          logger.warn(`[notify] SMS blocked/failed for ${customerId}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        }
      } catch (err) {
        logger.error(`[notify] SMS failed for ${customerId}: ${err.message}`);
        results.sms = `error: ${err.message}`;
      }
    }

    // Email channel: NOT implemented. A generic subject/body send here
    // would bypass the template library's suppression ledger, and a real
    // template needs owner copy — until that exists this leg must report
    // failure honestly. It used to set sent=true after only logging, so
    // callers stamped "notified" while email-preferring customers got
    // nothing. sent stays false unless the SMS leg above delivered.
    if ((channel === 'email' || channel === 'both') && emailSubject && emailBody && customer.email) {
      logger.warn(`[notify] email channel not implemented — ${notificationType} for customer ${customerId} NOT emailed (subject: ${emailSubject})`);
      results.email = 'unavailable: email channel not implemented';
    }

    return { sent, channel, results };
  },
};

module.exports = NotificationDispatcher;
// Deferred-replay registry hook (replay-time preference recheck).
module.exports.deferredNotificationStillWanted = deferredNotificationStillWanted;
