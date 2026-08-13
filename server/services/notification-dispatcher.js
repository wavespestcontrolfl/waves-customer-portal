const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');
const { SEND_WINDOW_START_HOUR_ET, SEND_WINDOW_END_HOUR_ET } = require('./messaging/send-window');
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
  // End EXCLUSIVE: quiet hours "until 08:00" reopen AT 08:00 — the same
  // boundary shape as the global send window, and the minute the deferred
  // rail schedules replays for (an inclusive end held every 08:00 replay
  // for wraparound windows like 21:00-08:00).
  return start <= end
    ? (currentTime >= start && currentTime < end)
    : (currentTime >= start || currentTime < end);
}

// True when the customer's quiet window leaves NO deliverable minute inside
// the global send window — the deferred-replay recheck must terminally
// suppress rather than ping-pong between the two windows forever. Pure
// HH:MM string comparison (both windows are ET wall-clock).
function customerQuietHoursCoverSendWindow(prefs) {
  const start = String(prefs?.quiet_hours_start || '').substring(0, 5);
  const end = String(prefs?.quiet_hours_end || '').substring(0, 5);
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start === end) return false;
  const open = `${String(SEND_WINDOW_START_HOUR_ET).padStart(2, '0')}:00`;
  const close = `${String(SEND_WINDOW_END_HOUR_ET).padStart(2, '0')}:00`;
  // Non-wraparound quiet window [start, end): covers [open, close) iff it
  // starts at/before the open and ends at/after the close.
  if (start < end) return start <= open && end >= close;
  // Wraparound (start > end): the only NON-quiet gap is [end, start); the
  // send window is covered iff that gap lies entirely before the open or
  // entirely at/after the close.
  return start <= open || end >= close;
}

// The next instant the customer's OWN quiet window ends (ET wall-clock,
// DST-safe via the iterate-and-re-read shape nextSendWindowOpenET uses).
function nextCustomerQuietHoursEndET(prefs, at = new Date()) {
  const end = String(prefs?.quiet_hours_end || '').substring(0, 5);
  const [eh, em] = end.split(':').map(Number);
  if (!Number.isFinite(eh) || !Number.isFinite(em)) return new Date(at.getTime() + 15 * 60 * 1000);
  let target = new Date(at.getTime());
  for (let i = 0; i < 3; i++) {
    const p = etParts(target);
    let deltaMinutes = (eh - p.hour) * 60 + (em - p.minute);
    if (deltaMinutes <= 0 && i === 0) deltaMinutes += 24 * 60;
    if (deltaMinutes === 0 && p.second === 0) break;
    target = new Date(target.getTime() + deltaMinutes * 60 * 1000 - p.second * 1000);
  }
  return target;
}

// Replay-time preference recheck for a quiet-hours-deferred notification
// (deferred-replay registry): the queued row replays through the generic
// executor, which knows nothing about the dispatcher's per-type toggles,
// channel choices, or customer quiet hours — and any of those can change
// overnight. Suppression mirrors the immediate dispatcher exactly (it
// drops on all three without retrying); a read failure fails closed as
// retryable.
async function deferredNotificationStillWanted(notificationType, customerId, now = new Date()) {
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
    if (inCustomerQuietHours(prefs, now)) {
      // If the customer's OWN quiet window covers the entire global 8AM-8PM
      // send window (e.g. 08:00-21:00), no deliverable minute exists: a
      // replay at the quiet-hours end is rejected by the global cutoff and
      // rescheduled back to 08:00, with the attempt refunded each time —
      // an infinite ping-pong. Terminally suppress instead so the row gets
      // its blocked settlement + terminal hooks, and alert loudly: the
      // caller's notify() already reported this notification as queued.
      if (customerQuietHoursCoverSendWindow(prefs)) {
        logger.error(`[notify] customer ${customerId} quiet hours ${prefs.quiet_hours_start}-${prefs.quiet_hours_end} cover the entire ${SEND_WINDOW_START_HOUR_ET}:00-${SEND_WINDOW_END_HOUR_ET}:00 ET send window — terminally suppressing deferred ${notificationType} (no deliverable minute exists)`);
        return { eligible: false, reason: 'quiet_hours_cover_send_window' };
      }
      // Still wanted, just not YET — retryable with the customer's actual
      // quiet-hours END as the retry time, so the executor reschedules
      // straight to it (and refunds the attempt) instead of burning the
      // bounded 15-minute ladder against a window that ends at e.g. 09:00.
      return {
        eligible: false,
        reason: 'customer_quiet_hours',
        retryable: true,
        retryAt: nextCustomerQuietHoursEndET(prefs, now),
      };
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
// Shared with the property-alerts sweep so both surfaces enforce the same
// customer quiet-hours window shape.
module.exports.inCustomerQuietHours = inCustomerQuietHours;
