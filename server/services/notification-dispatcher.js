const db = require('../models/db');
const logger = require('./logger');

// Map notification types to their toggle column and channel column in notification_prefs
const TYPE_MAP = {
  service_reminder:  { toggle: 'service_reminder_24h', channel: 'service_reminder_channel' },
  en_route:          { toggle: 'tech_en_route',        channel: 'en_route_channel' },
  service_complete:  { toggle: 'service_completed',    channel: 'service_complete_channel' },
  billing:           { toggle: 'billing_alerts',       channel: 'billing_channel' },
  seasonal:          { toggle: 'seasonal_tips',        channel: 'seasonal_channel' },
  review_request:    { toggle: 'review_request',       channel: 'review_request_channel' },
  referral:          { toggle: 'referral_nudge',       channel: 'referral_channel' },
  marketing:         { toggle: 'marketing_offers',     channel: 'marketing_channel' },
  payment_receipt:   { toggle: 'payment_receipt',      channel: 'payment_receipt_channel' },
  weather_alert:     { toggle: 'weather_alerts',       channel: 'weather_alert_channel' },
};

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

    // Check quiet hours
    if (prefs?.quiet_hours_start && prefs?.quiet_hours_end) {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const start = prefs.quiet_hours_start.substring(0, 5);
      const end = prefs.quiet_hours_end.substring(0, 5);

      let inQuietHours = false;
      if (start <= end) {
        // e.g. 21:00 to 08:00 does NOT apply here; this is e.g. 08:00 to 17:00
        inQuietHours = currentTime >= start && currentTime <= end;
      } else {
        // Wraps midnight: e.g. 21:00 to 08:00
        inQuietHours = currentTime >= start || currentTime <= end;
      }

      if (inQuietHours) {
        logger.info(`[notify] Quiet hours active for customer ${customerId} (${start}-${end})`);
        return { sent: false, channel: null, results: { reason: 'quiet_hours' } };
      }
    }

    // Determine channel
    const channel = prefs?.[typeConfig.channel] || 'sms';
    const results = {};
    let sent = false;

    // Send SMS
    if ((channel === 'sms' || channel === 'both') && smsMessage && customer.phone) {
      try {
        const TwilioService = require('./twilio');
        await TwilioService.sendSMS(customer.phone, smsMessage, {
          customerId: customer.id,
          messageType: notificationType,
        });
        results.sms = 'sent';
        sent = true;
      } catch (err) {
        logger.error(`[notify] SMS failed for ${customerId}: ${err.message}`);
        results.sms = `error: ${err.message}`;
      }
    }

    // Send email
    if ((channel === 'email' || channel === 'both') && emailSubject && emailBody && customer.email) {
      try {
        // Use SendGrid / nodemailer if available — for now log intent
        // Future: const EmailService = require('./email');
        // await EmailService.send(customer.email, emailSubject, emailBody);
        logger.info(`[notify] Email would be sent to ${customer.email}: ${emailSubject}`);
        results.email = 'logged'; // change to 'sent' when email service is wired
        sent = true;
      } catch (err) {
        logger.error(`[notify] Email failed for ${customerId}: ${err.message}`);
        results.email = `error: ${err.message}`;
      }
    }

    return { sent, channel, results };
  },
};

module.exports = NotificationDispatcher;
