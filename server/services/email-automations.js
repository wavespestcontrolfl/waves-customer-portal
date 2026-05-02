/**
 * Email Automation Service.
 *
 * ALL TRIGGERS ARE MANUAL for now — admin clicks a button to send.
 *
 * Each automation:
 *   1. Email: enroll the customer in the local SendGrid-backed sequence
 *      defined in automation_templates + automation_steps. The runner
 *      (server/services/automation-runner.js) ticks every minute and
 *      fires steps per their delay_hours. ASM group suppression
 *      handles unsubscribe semantics; webhook events cancel active
 *      enrollments on bounce/spam/unsub.
 *   2. SMS: send onboarding text via Twilio (if configured).
 *   3. Log: record the run in email_automation_log.
 *
 * Beehiiv was decommissioned in migration 20260424000008 — the AUTOMATIONS
 * map's `beehiivAutomationId` field is retained purely as historical
 * reference and is not read at runtime.
 */

const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

// ── Automation definitions ──
const AUTOMATIONS = {
  new_recurring: {
    name: 'New Recurring Customer',
    description: 'For any new recurring customer who signs up for a pest, lawn, or combo program',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_NEW_RECURRING || 'aut_3f539f94-024a-466f-9d50-4454173627dd',
    tags: ['new customer', 'recurring'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Welcome to a safer, pest-free home with Waves! Check your inbox, we just emailed you our welcome guide.\n\n` +
      `If you have any questions or need assistance, simply reply to this message.`,
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
      `Hello ${c.first_name}! Welcome to a better lawn with Waves! We just emailed your our lawn care welcome guide + expert tips for the best results for your lawn!\n\n` +
      `If you have any questions or need assistance, simply reply to this message.`,
    enabled: true,
  },
  new_appointment: {
    name: 'New First-Time Appointment',
    description: 'For non-recurring, first-time customers who have never booked with us before',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_NEW_APPT || 'aut_d34a894e-a5bc-43fc-af47-7efba42881e7',
    tags: ['new appointment', 'first-time'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! We just emailed you a breakdown of what to expect with your upcoming service with Waves!\n\n` +
      `If you have any questions or need assistance, simply reply to this message.`,
    enabled: true,
  },
  review_thank_you_lwr: {
    name: 'Review Thank You — Lakewood Ranch',
    description: 'For LWR customers who have given us a Google review',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_REVIEW_LWR || 'aut_7a99204b-3a0f-46db-914f-05722f2eb7f0',
    tags: ['reviewed', 'lakewood-ranch'],
    smsTemplate: null,
    enabled: true,
  },
  review_thank_you_venice: {
    name: 'Review Thank You — Venice',
    description: 'For Venice customers who have given us a Google review',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_REVIEW_VENICE || 'aut_6fd321f7-dce1-4887-bd89-91cea7ac00b7',
    tags: ['reviewed', 'venice'],
    smsTemplate: null,
    enabled: true,
  },
  review_thank_you_sarasota: {
    name: 'Review Thank You — Sarasota',
    description: 'For Sarasota customers who have given us a Google review',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_REVIEW_SARASOTA || 'aut_023254b1-bd8e-443a-a59f-a54e88cf54c7',
    tags: ['reviewed', 'sarasota'],
    smsTemplate: null,
    enabled: true,
  },
  review_thank_you_parrish: {
    name: 'Review Thank You — Parrish',
    description: 'For Parrish customers who have given us a Google review',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_REVIEW_PARRISH || 'aut_e36ad726-024a-4741-83aa-3c7d08b054c2',
    tags: ['reviewed', 'parrish'],
    smsTemplate: null,
    enabled: true,
  },
  bed_bug: {
    name: 'Bed Bug Treatment',
    description: 'For first-time customers who have booked a bed bug treatment',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_BEDBUG || 'aut_9e3657f3-82de-4d4f-84a5-ae757ac7e13b',
    tags: ['bed bug treatment', 'first-time'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Let's get your home bed bug-free. We just emailed your Waves treatment guide—please review it to help us get the best results for your home!\n\n` +
      `If you have any questions or need assistance, simply reply to this message.`,
    enabled: true,
  },
  cockroach: {
    name: 'Cockroach Control',
    description: 'For first-time customers who have booked a cockroach treatment',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_ROACH || 'aut_53cfd473-982b-49fd-b03d-62a9d462909c',
    tags: ['roach treatment', 'first-time'],
    smsTemplate: (c) =>
      `Hello ${c.first_name}! Let's get your home cockroach-free. We just emailed your Waves treatment guide—please review it to help us get the best results for your home!\n\n` +
      `If you have any questions or need assistance, simply reply to this message.`,
    enabled: true,
  },
  new_lead: {
    name: 'New Lead',
    description: 'For new leads entering the pipeline — intro to Waves services',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_NEW_LEAD || 'aut_d08077d4-3079-4e69-9488-f6669caf6a6c',
    tags: ['new lead'],
    smsTemplate: (c) =>
      `Hi ${c.first_name}! Thanks for your interest in Waves Pest Control. We just sent you an email with more info about our services.\n\n` +
      `Reply here anytime if you have questions!`,
    enabled: true,
  },
  service_renewal: {
    name: 'Service Renewal Reminder',
    description: 'Reminder for customers whose service agreement is coming up for renewal',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_RENEWAL || 'aut_6e9b0067-89c9-4c11-acbe-f62eaa80b1aa',
    tags: ['renewal reminder'],
    smsTemplate: (c) =>
      `Hi ${c.first_name}! Your Waves service is coming up for renewal. We just emailed you the details — take a look when you get a chance.\n\n` +
      `Questions? Just reply here!`,
    enabled: true,
  },
  pricing_update: {
    name: 'Pricing Update',
    description: 'Notify customers about service pricing changes',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_PRICING || 'aut_0d249df2-79fe-4e4d-a7ad-e35259e9d706',
    tags: ['pricing update'],
    smsTemplate: null,
    enabled: true,
  },
  payment_failed: {
    name: 'Payment Failed',
    description: 'Sent when autopay fails — friendly heads-up before retry',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_PAYMENT_FAILED || 'aut_bf915f3e-8ca2-4355-be54-9a66e9633296',
    tags: ['payment failed'],
    smsTemplate: null,
    enabled: true,
  },
  referral_nudge: {
    name: 'Referral Nudge',
    description: 'Post-service nudge encouraging customer to refer friends and family',
    trigger: 'manual',
    beehiivAutomationId: process.env.BEEHIIV_AUTO_REFERRAL || 'aut_45641d64-3111-49c2-87bb-3f1fe6ccce25',
    tags: ['referral'],
    smsTemplate: null,
    enabled: true,
  },
};

function purposeForAutomation(key) {
  if (['new_recurring', 'lawn_service', 'new_appointment', 'bed_bug', 'cockroach'].includes(key)) return 'appointment';
  if (key === 'service_renewal') return 'retention';
  if (key === 'referral_nudge') return 'referral';
  if (key === 'payment_failed') return 'billing';
  return 'marketing';
}

// ASM (Advanced Suppression Manager) group classification for SendGrid.
//
// Newsletter group = promotional intent. A user who unsubs from the monthly
// newsletter expects these to stop too (re-engagement pitches, intro emails,
// referral asks). Map to SENDGRID_ASM_GROUP_NEWSLETTER.
//
// Service group = transactional. Program welcomes, treatment prep, review
// thank-yous, renewals, billing. Stay delivered even if newsletter-unsubbed
// because the customer relationship demands it. Map to SENDGRID_ASM_GROUP_SERVICE.
//
// These automations currently send via beehiiv drips; the asmGroup field is
// forward-looking for the SendGrid migration but also tells admin surfaces
// how to label each automation to the operator.
const NEWSLETTER_AUTOMATION_KEYS = new Set(['cold_lead', 'new_lead', 'referral_nudge']);
for (const [key, auto] of Object.entries(AUTOMATIONS)) {
  auto.asmGroup = NEWSLETTER_AUTOMATION_KEYS.has(key) ? 'newsletter' : 'service';
}

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

    let localResult = null;
    let smsResult = null;

    // Step 1 — Enroll in the local SendGrid-backed runner. Every template
    // has at least one seeded step (migration 000007), so enrollment
    // succeeds unless explicitly disabled or the customer already has an
    // active enrollment on this template (which is a no-op on purpose).
    try {
      const AutomationRunner = require('./automation-runner');
      localResult = await AutomationRunner.enrollCustomer({ templateKey: key, customer });
    } catch (err) {
      logger.error(`[email-auto] enrollCustomer failed for ${key}: ${err.message}`);
      localResult = { error: err.message };
    }

    // Step 2: SMS — check DB template first, fall back to inline
    if ((auto.smsTemplate || auto.smsTemplateKey) && customer.phone) {
      try {
        let smsBody = null;

        // Try DB template (editable from SMS Templates admin)
        const templateKey = auto.smsTemplateKey || `auto_${key}`;
        try {
          const templates = require('../routes/admin-sms-templates');
          smsBody = await templates.getTemplate(templateKey, {
            first_name: customer.first_name || '',
            last_name: customer.last_name || '',
          });
        } catch { /* template lookup failed — fall back to inline */ }

        // Fall back to inline template function
        if (!smsBody && auto.smsTemplate) {
          smsBody = auto.smsTemplate(customer);
        }

        if (smsBody) {
          const sendResult = await sendCustomerMessage({
            to: customer.phone,
            body: smsBody,
            channel: 'sms',
            audience: 'customer',
            purpose: purposeForAutomation(key),
            customerId: customer.id,
            identityTrustLevel: 'phone_matches_customer',
            entryPoint: 'email_automation_sms',
            metadata: {
              original_message_type: `auto_${key}`,
              automation_key: key,
            },
          });
          smsResult = sendResult.sent
            ? { sent: true }
            : { sent: false, blocked: sendResult.blocked, error: sendResult.code || sendResult.reason || 'SMS send blocked/failed' };
        }
      } catch (err) {
        logger.error(`[email-auto] SMS failed for ${key}: ${err.message}`);
        smsResult = { error: err.message };
      }
    }

    // Step 3: Log — beehiiv_result column kept for schema compat; carries
    // the local enrollment result now.
    await db('email_automation_log').insert({
      customer_id: customer.id,
      automation_key: key,
      automation_name: auto.name,
      trigger_type: 'manual',
      trigger_value: key,
      beehiiv_result: JSON.stringify({ local: localResult }),
      sms_result: JSON.stringify(smsResult),
      status: (localResult?.error || smsResult?.error) ? 'partial' : 'success',
    });

    logger.info(`[email-auto] ${key} sent for ${customer.first_name} ${customer.last_name} (${email})`);
    return { success: true, local: localResult, sms: smsResult };
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
