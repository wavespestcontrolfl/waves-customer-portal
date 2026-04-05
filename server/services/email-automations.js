/**
 * Email Automation Service — replaces 7 Zapier zaps.
 *
 * Triggers on customer lifecycle events (stage changes, service bookings,
 * reviews) and performs:
 *   1. Beehiiv: upsert subscriber → add tags → enroll in automation
 *   2. SMS: send onboarding/welcome text via Twilio
 *   3. Log: record the automation run in email_automation_log
 *
 * Each automation maps to a Beehiiv automation ID + Twilio SMS template.
 */

const db = require('../models/db');
const beehiiv = require('./beehiiv');
const TwilioService = require('./twilio');
const logger = require('./logger');

// ── Automation definitions (maps to the 7 Zapier zaps) ──
const AUTOMATIONS = {
  new_recurring: {
    name: 'New Recurring Customer',
    trigger: 'stage_change',
    triggerValue: 'won',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_NEW_RECURRING || 'aut_3f539f94-024a-466f-9d50-4454173627dd',
    tags: ['new customer'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Welcome to a safer, pest-free home with Waves Pest Control 🌊\n\n` +
      `We just sent you a welcome email with everything you need to know about your service. ` +
      `Check your inbox!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
  cold_lead: {
    name: 'Cold Lead Nurture',
    trigger: 'stage_change',
    triggerValue: 'dormant',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_COLD || 'aut_13dca63e-702d-4020-870c-27c742532a06',
    tags: ['cold customer'],
    smsTemplate: null, // No SMS for cold leads
    enabled: true,
  },
  lawn_service: {
    name: 'Lawn Care Onboarding',
    trigger: 'service_type',
    triggerValue: 'lawn',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_LAWN || 'aut_0c794b25-1a87-46aa-9ef3-6c508348d288',
    tags: ['lawn'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Welcome to a better lawn with Waves! 🌊\n\n` +
      `We just emailed you a breakdown of what to expect with your lawn care program. ` +
      `Check your inbox for the full details!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
  new_appointment: {
    name: 'New Appointment',
    trigger: 'stage_change',
    triggerValue: 'estimate_sent',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_NEW_APPT || 'aut_d34a894e-a5bc-43fc-af47-7efba42881e7',
    tags: ['new appointment'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! We just emailed you a breakdown of what to expect from Waves Pest Control 🌊\n\n` +
      `Check your inbox for the details. We're looking forward to helping you!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
  review_thank_you: {
    name: 'Review Thank You',
    trigger: 'review_received',
    triggerValue: null,
    beehiivAutomationId: process.env.BEEHIIV_AUTO_REVIEW || 'aut_9348030b-df19-48cf-be6e-c83d74434f87',
    tags: ['reviewed'],
    smsTemplate: null, // Thank-you handled by email only
    enabled: true,
  },
  bed_bug: {
    name: 'Bed Bug Treatment',
    trigger: 'service_type',
    triggerValue: 'bed bug',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_BEDBUG || 'aut_53cfd473-982b-49fd-b03d-62a9d462909c',
    tags: ['bed bug treatment'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Let's get your home bed bug-free 🌊\n\n` +
      `We just emailed you everything you need to know about your treatment plan. ` +
      `Check your inbox!\n\n` +
      `Questions? Reply here or call (941) 318-7612.`,
    enabled: true,
  },
  cockroach: {
    name: 'Cockroach Control',
    trigger: 'service_type',
    triggerValue: 'roach',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_ROACH || 'aut_53cfd473-982b-49fd-b03d-62a9d462909c',
    tags: ['roach treatment'],
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
   * Run all automations that match a stage change event.
   * Called when PUT /api/admin/customers/:id/stage fires.
   */
  async onStageChange(customerId, newStage, oldStage) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return;

    const results = [];
    for (const [key, auto] of Object.entries(AUTOMATIONS)) {
      if (!auto.enabled) continue;
      if (auto.trigger !== 'stage_change') continue;
      if (auto.triggerValue !== newStage) continue;

      try {
        const result = await this.executeAutomation(key, auto, customer);
        results.push({ automation: key, ...result });
      } catch (err) {
        logger.error(`[email-auto] ${key} failed for customer ${customerId}: ${err.message}`);
        results.push({ automation: key, success: false, error: err.message });
      }
    }
    return results;
  },

  /**
   * Run all automations that match a service type.
   * Called when a new service is booked for a customer.
   */
  async onServiceBooked(customerId, serviceType) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return;

    const svcLower = (serviceType || '').toLowerCase();
    const results = [];
    for (const [key, auto] of Object.entries(AUTOMATIONS)) {
      if (!auto.enabled) continue;
      if (auto.trigger !== 'service_type') continue;
      if (!svcLower.includes(auto.triggerValue)) continue;

      try {
        const result = await this.executeAutomation(key, auto, customer);
        results.push({ automation: key, ...result });
      } catch (err) {
        logger.error(`[email-auto] ${key} failed for customer ${customerId}: ${err.message}`);
        results.push({ automation: key, success: false, error: err.message });
      }
    }
    return results;
  },

  /**
   * Run the review thank-you automation.
   * Called when a new review is synced.
   */
  async onReviewReceived(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return;

    const auto = AUTOMATIONS.review_thank_you;
    if (!auto.enabled) return;

    try {
      return await this.executeAutomation('review_thank_you', auto, customer);
    } catch (err) {
      logger.error(`[email-auto] review_thank_you failed for ${customerId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  },

  /**
   * Execute a single automation for a customer.
   */
  async executeAutomation(key, auto, customer) {
    const email = customer.email;
    if (!email) {
      logger.warn(`[email-auto] Skipping ${key} for ${customer.id}: no email`);
      return { success: false, error: 'No email on file' };
    }

    // Check if we already ran this automation for this customer recently (24hr dedupe)
    const recent = await db('email_automation_log')
      .where({ customer_id: customer.id, automation_key: key })
      .where('created_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000))
      .first();
    if (recent) {
      logger.info(`[email-auto] Skipping ${key} for ${customer.id}: already ran in last 24h`);
      return { success: false, error: 'Already ran recently (24h dedupe)' };
    }

    let beehiivResult = null;
    let smsResult = null;

    // Step 1: Beehiiv — upsert subscriber, add tags, enroll in automation
    if (beehiiv.configured) {
      try {
        const subscriber = await beehiiv.upsertSubscriber(email, {
          firstName: customer.first_name,
          lastName: customer.last_name,
          utmSource: 'waves_portal',
          utmMedium: key,
        });

        if (subscriber?.id) {
          // Add tags
          if (auto.tags?.length) {
            await beehiiv.addTags(subscriber.id, auto.tags);
          }
          // Enroll in automation
          if (auto.beehiivAutomationId) {
            await beehiiv.enrollInAutomation(auto.beehiivAutomationId, {
              email,
              subscriptionId: subscriber.id,
            });
          }
          beehiivResult = { subscriberId: subscriber.id, tags: auto.tags };
        }
      } catch (err) {
        logger.error(`[email-auto] Beehiiv step failed for ${key}: ${err.message}`);
        beehiivResult = { error: err.message };
      }
    } else {
      beehiivResult = { skipped: 'BEEHIIV_API_KEY not configured' };
    }

    // Step 2: SMS — send onboarding text
    if (auto.smsTemplate && customer.phone) {
      try {
        const msg = auto.smsTemplate(customer);
        await TwilioService.sendSMS(customer.phone, msg);
        smsResult = { sent: true, to: customer.phone };
        logger.info(`[email-auto] SMS sent for ${key} to ${customer.phone}`);
      } catch (err) {
        logger.error(`[email-auto] SMS failed for ${key}: ${err.message}`);
        smsResult = { error: err.message };
      }
    }

    // Step 3: Log the automation run
    await db('email_automation_log').insert({
      customer_id: customer.id,
      automation_key: key,
      automation_name: auto.name,
      trigger_type: auto.trigger,
      trigger_value: auto.triggerValue,
      beehiiv_result: JSON.stringify(beehiivResult),
      sms_result: JSON.stringify(smsResult),
      status: beehiivResult?.error || smsResult?.error ? 'partial' : 'success',
    });

    logger.info(`[email-auto] Completed ${key} for ${customer.first_name} ${customer.last_name} (${email})`);
    return { success: true, beehiiv: beehiivResult, sms: smsResult };
  },

  /**
   * Manually trigger an automation for a customer (from admin UI).
   */
  async manualTrigger(automationKey, customerId) {
    const auto = AUTOMATIONS[automationKey];
    if (!auto) throw new Error(`Unknown automation: ${automationKey}`);

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    return this.executeAutomation(automationKey, auto, customer);
  },

  /**
   * Get automation log for a customer or all customers.
   */
  async getLog({ customerId, automationKey, limit = 50, offset = 0 } = {}) {
    let query = db('email_automation_log').orderBy('created_at', 'desc');
    if (customerId) query = query.where({ customer_id: customerId });
    if (automationKey) query = query.where({ automation_key: automationKey });
    return query.limit(limit).offset(offset);
  },
};

module.exports = EmailAutomationService;
