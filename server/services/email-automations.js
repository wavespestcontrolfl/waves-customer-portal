/**
 * Email Automation Service — replaces 7 Zapier zaps.
 *
 * ALL TRIGGERS ARE MANUAL for now — admin clicks a button to send.
 * Future: auto-trigger based on Square service bookings.
 *
 * Each automation:
 *   1. Beehiiv: upsert subscriber → add tags → enroll in automation
 *   2. SMS: send onboarding text via Twilio (if configured)
 *   3. Log: record the run in email_automation_log
 */

const db = require('../models/db');
const beehiiv = require('./beehiiv');
const TwilioService = require('./twilio');
const logger = require('./logger');

// ── Automation definitions ──
const AUTOMATIONS = {
  new_recurring: {
    name: 'New Recurring Customer',
    description: 'For any new recurring customer who signs up for a pest, lawn, or combo program',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_NEW_RECURRING || 'aut_3f539f94-024a-466f-9d50-4454173627dd',
    tags: ['new customer', 'recurring'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Welcome to a safer, pest-free home with Waves Pest Control 🌊\n\n` +
      `We just sent you a welcome email with everything you need to know about your service. ` +
      `Check your inbox!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
  cold_lead: {
    name: 'Cold Lead Nurture',
    description: 'For customers who declined or haven\'t responded to an estimate',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_COLD || 'aut_13dca63e-702d-4020-870c-27c742532a06',
    tags: ['cold customer'],
    smsTemplate: null,
    enabled: true,
  },
  lawn_service: {
    name: 'Lawn Care Onboarding',
    description: 'For new recurring lawn care customers specifically',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_LAWN || 'aut_0c794b25-1a87-46aa-9ef3-6c508348d288',
    tags: ['lawn', 'recurring'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Welcome to a better lawn with Waves! 🌊\n\n` +
      `We just emailed you a breakdown of what to expect with your lawn care program. ` +
      `Check your inbox for the full details!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
  new_appointment: {
    name: 'New First-Time Appointment',
    description: 'For non-recurring, first-time customers who have never booked with us before',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_NEW_APPT || 'aut_d34a894e-a5bc-43fc-af47-7efba42881e7',
    tags: ['new appointment', 'first-time'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! We just emailed you a breakdown of what to expect from Waves Pest Control 🌊\n\n` +
      `Check your inbox for the details. We're looking forward to helping you!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
  review_thank_you: {
    name: 'Review Thank You',
    description: 'For customers who have recently given us a Google review',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_REVIEW || 'aut_9348030b-df19-48cf-be6e-c83d74434f87',
    tags: ['reviewed'],
    smsTemplate: null,
    enabled: true,
  },
  bed_bug: {
    name: 'Bed Bug Treatment',
    description: 'For first-time customers who have booked a bed bug treatment',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_BEDBUG || 'aut_53cfd473-982b-49fd-b03d-62a9d462909c',
    tags: ['bed bug treatment', 'first-time'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Let's get your home bed bug-free 🌊\n\n` +
      `We just emailed you everything you need to know about your treatment plan. ` +
      `Check your inbox!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
  cockroach: {
    name: 'Cockroach Control',
    description: 'For first-time customers who have booked a cockroach treatment',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_ROACH || 'aut_53cfd473-982b-49fd-b03d-62a9d462909c',
    tags: ['roach treatment', 'first-time'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Let's get your home roach-free 🌊\n\n` +
      `We just emailed you your treatment plan details. Check your inbox!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
};

const EmailAutomationService = {
  AUTOMATIONS,

  /**
   * Execute a single automation for a customer.
   * This is the core function — called by manualTrigger.
   */
  async executeAutomation(key, auto, customer) {
    const email = customer.email;
    if (!email) {
      logger.warn(`[email-auto] Skipping ${key} for ${customer.id}: no email`);
      return { success: false, error: 'No email on file' };
    }

    // 24hr dedupe
    const recent = await db('email_automation_log')
      .where({ customer_id: customer.id, automation_key: key })
      .where('created_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000))
      .first();
    if (recent) {
      return { success: false, error: 'Already sent in last 24h' };
    }

    let beehiivResult = null;
    let smsResult = null;

    // Step 1: Beehiiv
    if (beehiiv.configured) {
      try {
        const subscriber = await beehiiv.upsertSubscriber(email, {
          firstName: customer.first_name,
          lastName: customer.last_name,
          utmSource: 'waves_portal',
          utmMedium: key,
        });
        if (subscriber?.id) {
          if (auto.tags?.length) await beehiiv.addTags(subscriber.id, auto.tags);
          if (auto.beehiivAutomationId) {
            await beehiiv.enrollInAutomation(auto.beehiivAutomationId, { email, subscriptionId: subscriber.id });
          }
          beehiivResult = { subscriberId: subscriber.id, tags: auto.tags };
        }
      } catch (err) {
        logger.error(`[email-auto] Beehiiv failed for ${key}: ${err.message}`);
        beehiivResult = { error: err.message };
      }
    } else {
      beehiivResult = { skipped: 'BEEHIIV_API_KEY not configured' };
    }

    // Step 2: SMS
    if (auto.smsTemplate && customer.phone) {
      try {
        await TwilioService.sendSMS(customer.phone, auto.smsTemplate(customer));
        smsResult = { sent: true, to: customer.phone };
      } catch (err) {
        logger.error(`[email-auto] SMS failed for ${key}: ${err.message}`);
        smsResult = { error: err.message };
      }
    }

    // Step 3: Log
    await db('email_automation_log').insert({
      customer_id: customer.id,
      automation_key: key,
      automation_name: auto.name,
      trigger_type: 'manual',
      trigger_value: key,
      beehiiv_result: JSON.stringify(beehiivResult),
      sms_result: JSON.stringify(smsResult),
      status: beehiivResult?.error || smsResult?.error ? 'partial' : 'success',
    });

    logger.info(`[email-auto] ${key} sent for ${customer.first_name} ${customer.last_name} (${email})`);
    return { success: true, beehiiv: beehiivResult, sms: smsResult };
  },

  /**
   * Manually trigger an automation for a customer (from admin UI).
   */
  async manualTrigger(automationKey, customerId) {
    const auto = AUTOMATIONS[automationKey];
    if (!auto) throw new Error(`Unknown automation: ${automationKey}`);
    if (!auto.enabled) throw new Error(`Automation "${auto.name}" is disabled`);

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    return this.executeAutomation(automationKey, auto, customer);
  },

  /**
   * Get automation log.
   */
  async getLog({ customerId, automationKey, limit = 50, offset = 0 } = {}) {
    let query = db('email_automation_log').orderBy('created_at', 'desc');
    if (customerId) query = query.where({ customer_id: customerId });
    if (automationKey) query = query.where({ automation_key: automationKey });
    return query.limit(limit).offset(offset);
  },
};

module.exports = EmailAutomationService;
