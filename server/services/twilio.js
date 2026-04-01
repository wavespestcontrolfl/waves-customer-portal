const twilio = require('twilio');
const config = require('../config');
const db = require('../models/db');
const logger = require('./logger');

// Initialize Twilio client
const client = twilio(config.twilio.accountSid, config.twilio.authToken);

const TwilioService = {
  // =========================================================================
  // PHONE VERIFICATION (Login via OTP)
  // =========================================================================

  /**
   * Send a verification code via SMS for phone-based login
   */
  async sendVerificationCode(phone) {
    try {
      const verification = await client.verify.v2
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
      const check = await client.verify.v2
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
   * Send a single SMS message
   */
  async sendSMS(to, body) {
    try {
      const message = await client.messages.create({
        body,
        from: config.twilio.phoneNumber,
        to,
      });
      logger.info(`SMS sent to ${to}: ${message.sid}`);
      return { success: true, sid: message.sid };
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
