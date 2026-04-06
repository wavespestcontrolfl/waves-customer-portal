const twilio = require('twilio');
const config = require('../config');
const db = require('../models/db');
const logger = require('./logger');

// Lazy-initialize Twilio client — don't crash if creds are missing
let _client;
function getClient() {
  if (_client) return _client;
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    logger.warn('[twilio] TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set — SMS/voice disabled');
    return null;
  }
  _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return _client;
}
// Keep backward-compatible reference for any code that reads `client` directly
const client = null;

const TwilioService = {
  // =========================================================================
  // PHONE VERIFICATION (Login via OTP)
  // =========================================================================

  /**
   * Send a verification code via SMS for phone-based login
   */
  async sendVerificationCode(phone) {
    try {
      const c = getClient();
      if (!c) throw new Error('Twilio not configured');
      const verification = await c.verify.v2
        .services(config.twilio.verifyServiceSid)
        .verifications.create({ to: phone, channel: 'sms' });

      logger.info(`Verification sent to ${phone}: ${verification.status}`);
      return { success: true, status: verification.status };
    } catch (err) {
      logger.error(`Twilio verification send failed: ${err.message}`);
      throw new Error('Failed to send verification code');
    }
  },

  /**
   * Check a verification code
   */
  async checkVerificationCode(phone, code) {
    try {
      const c = getClient();
      if (!c) throw new Error('Twilio not configured');
      const check = await c.verify.v2
        .services(config.twilio.verifyServiceSid)
        .verificationChecks.create({ to: phone, code });

      logger.info(`Verification check for ${phone}: ${check.status}`);
      return { success: check.status === 'approved', status: check.status };
    } catch (err) {
      logger.error(`Twilio verification check failed: ${err.message}`);
      throw new Error('Verification check failed');
    }
  },

  // =========================================================================
  // SERVICE NOTIFICATIONS
  // =========================================================================

  /**
   * Send a single SMS message — routes through the customer's location number
   * options: { customerId, customerLocationId, fromNumber, messageType, adminUserId }
   */
  async sendSMS(to, body, options = {}) {
    try {
      const { isEnabled } = require('../config/feature-gates');
      if (!isEnabled('twilioSms')) {
        logger.info(`[GATE BLOCKED] SMS to ${to}: "${body.substring(0, 60)}..." (gate: twilioSms)`);
        return { success: true, sid: 'gate-blocked', gateBlocked: true };
      }

      const TWILIO_NUMBERS = require('../config/twilio-numbers');
      const { resolveLocation } = require('../config/locations');

      // Determine FROM number — always the customer's location number
      let fromNumber = options.fromNumber;

      if (!fromNumber) {
        let locationId = options.customerLocationId;

        if (!locationId && options.customerId) {
          try {
            const customer = await db('customers').where({ id: options.customerId }).first();
            if (customer) {
              const loc = resolveLocation(customer.city);
              locationId = loc.id;
            }
          } catch {}
        }

        fromNumber = TWILIO_NUMBERS.getOutboundNumber(locationId || 'lakewood-ranch');
      }

      const c = getClient();
      if (!c) {
        logger.warn(`[twilio] Cannot send SMS — client not initialized. To: ${to}`);
        return { success: false, sid: null, error: 'Twilio not configured' };
      }

      // SMS Preview Mode: send to admin phone first for all customer-facing messages
      const ADMIN_PHONE = process.env.ADAM_PHONE || '+19415993489';
      const isInternalAlert = options.messageType === 'internal_alert' || to === ADMIN_PHONE;
      const previewMode = process.env.SMS_PREVIEW_MODE === 'true';

      if (previewMode && !isInternalAlert) {
        // Send preview to admin instead of customer
        try {
          const previewBody = `📋 SMS PREVIEW (to ${to}):\n\n${body}`;
          await c.messages.create({ body: previewBody, from: fromNumber, to: ADMIN_PHONE });
          logger.info(`[sms-preview] Preview sent to admin for message to ${to}`);
        } catch (prevErr) {
          logger.error(`[sms-preview] Preview failed: ${prevErr.message}`);
        }
        // In preview mode, still send to the actual customer too
        // Remove this line if you want admin-only preview (no customer send):
        // return { success: true, sid: 'preview-only', preview: true };
      }

      const message = await c.messages.create({ body, from: fromNumber, to });
      logger.info(`SMS sent to ${to} from ${fromNumber}: ${message.sid}`);

      // Log to sms_log
      try {
        await db('sms_log').insert({
          customer_id: options.customerId || null,
          direction: 'outbound',
          from_phone: fromNumber,
          to_phone: to,
          message_body: body,
          twilio_sid: message.sid,
          status: 'sent',
          message_type: options.messageType || 'manual',
          admin_user_id: options.adminUserId || null,
        });
      } catch (logErr) {
        logger.error(`SMS log failed: ${logErr.message}`);
      }

      return { success: true, sid: message.sid, fromNumber };
    } catch (err) {
      logger.error(`SMS send failed to ${to}: ${err.message}`);
      throw new Error('Failed to send SMS');
    }
  },

  /**
   * Send 24-hour service reminder
   * Called by cron job the day before scheduled service
   */
  async sendServiceReminder(customerId, scheduledServiceId) {
    const customer = await db('customers').where({ id: customerId }).first();
    const service = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'technicians.name as tech_name')
      .first();

    if (!customer || !service) return;

    // Check if customer has this notification enabled
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!prefs?.service_reminder_24h || !prefs?.sms_enabled) return;

    const timeWindow = service.window_start && service.window_end
      ? `between ${formatTime(service.window_start)} - ${formatTime(service.window_end)}`
      : '(time window TBD)';

    const body = `🌊 Waves Pest Control — Service Reminder\n\n` +
      `Hi ${customer.first_name}! Your ${service.service_type} is scheduled for tomorrow ${timeWindow}.\n\n` +
      `Technician: ${service.tech_name || 'TBD'}\n\n` +
      `Please ensure gates are unlocked and pets are secured. ` +
      `Reply CONFIRM to confirm or call (941) 555-0100 to reschedule.`;

    return this.sendSMS(customer.phone, body);
  },

  /**
   * Send "tech en route" notification
   * Called when tech marks job as started in the field
   */
  async sendTechEnRoute(customerId, techName, etaMinutes) {
    const customer = await db('customers').where({ id: customerId }).first();
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!customer || !prefs?.tech_en_route || !prefs?.sms_enabled) return;

    const body = `🌊 Waves Pest Control\n\n` +
      `${techName} is on the way to your property! ` +
      `Estimated arrival: ${etaMinutes} minutes.\n\n` +
      `Please ensure gates are unlocked and pets are secured.`;

    return this.sendSMS(customer.phone, body);
  },

  /**
   * Send service completion summary
   * Called after tech completes service and submits notes
   */
  async sendServiceCompletedSummary(customerId, serviceRecordId) {
    const customer = await db('customers').where({ id: customerId }).first();
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!customer || !prefs?.service_completed || !prefs?.sms_enabled) return;

    const service = await db('service_records')
      .where({ id: serviceRecordId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'technicians.name as tech_name')
      .first();

    const products = await db('service_products')
      .where({ service_record_id: serviceRecordId })
      .select('product_name');

    const productList = products.map(p => p.product_name).join(', ');

    const body = `✅ Waves Pest Control — Service Complete\n\n` +
      `Hi ${customer.first_name}! ${service.tech_name} just completed your ${service.service_type}.\n\n` +
      `Products applied: ${productList}\n\n` +
      `View full details and tech notes in your customer portal. ` +
      `Questions? Reply to this text or call (941) 555-0100.`;

    return this.sendSMS(customer.phone, body);
  },

  /**
   * Send monthly billing reminder
   */
  async sendBillingReminder(customerId, amount, date) {
    const customer = await db('customers').where({ id: customerId }).first();
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!customer || !prefs?.billing_reminder || !prefs?.sms_enabled) return;

    const body = `🌊 Waves Pest Control — Billing Notice\n\n` +
      `Hi ${customer.first_name}, your ${customer.waveguard_tier} WaveGuard monthly charge of $${amount.toFixed(2)} ` +
      `will be processed on ${date}.\n\n` +
      `Manage your payment method in your customer portal or call (941) 555-0100.`;

    return this.sendSMS(customer.phone, body);
  },

  /**
   * Send seasonal tip / pest alert
   */
  async sendSeasonalAlert(customerId, subject, tip) {
    const customer = await db('customers').where({ id: customerId }).first();
    const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
    if (!customer || !prefs?.seasonal_tips || !prefs?.sms_enabled) return;

    const body = `🌊 Waves Pest Control — ${subject}\n\n` +
      `Hi ${customer.first_name}! ${tip}\n\n` +
      `Questions? Reply to this text or call (941) 555-0100.`;

    return this.sendSMS(customer.phone, body);
  },
};

// Helper
function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2, '0')} ${ampm}`;
}

module.exports = TwilioService;
