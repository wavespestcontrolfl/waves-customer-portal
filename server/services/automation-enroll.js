/**
 * Shared event → Automations-tab sequence enrollment helper.
 *
 * Used by the non-booking event wirings (google review thank-you, autopay
 * failure, renewal window, referral invite). Applies the bed-bug-lane
 * guards (#2635/#2638) that make an enrollment safe to fire from an event:
 *
 *   • sendability FIRST — template enabled AND the FIRST enabled step has
 *     real content (the runner starts at step 0 and skips empty bodies, so
 *     an enrolled-but-empty sequence would silently send nothing);
 *   • dedupe — 'ever': delivered-or-deliverable rows suppress (active /
 *     completed / cancelled / failed-that-sent), a failed row that never
 *     sent anything may retry; or a numeric day window: any enrollment row
 *     within N days suppresses (recurring events like renewals and repeat
 *     autopay failures re-enroll next cycle via enrollCustomer's
 *     reactivation);
 *   • primary customer email — these are account-level emails (billing,
 *     reviews, referrals), unlike prep's service-contact routing.
 *
 * No advisory lock: every current caller is a single-flight cron or a
 * serialized request path, and enrollCustomer's active-enrollment no-op
 * covers the residual overlap. Never throws — callers fire from crons and
 * webhooks that must not break on an enrollment hiccup.
 */

const db = require('../models/db');
const logger = require('./logger');

// Template enabled + first enabled step has content. Mirrors the
// appointment tagger's isTreatmentSequenceSendable. Fails CLOSED.
async function isSequenceSendable(templateKey) {
  try {
    const template = await db('automation_templates').where({ key: templateKey }).first();
    if (!template || !template.enabled) return false;
    const firstStep = await db('automation_steps')
      .where({ template_key: templateKey, enabled: true })
      .orderBy('step_order', 'asc')
      .first();
    return !!(firstStep && (String(firstStep.html_body || '').trim() || String(firstStep.text_body || '').trim()));
  } catch (err) {
    logger.warn(`[automation-enroll] sendable-check failed for ${templateKey}: ${err.message}`);
    return false;
  }
}

async function enrollSequenceFromEvent({ templateKey, customerId, dedupe = 'ever', source = 'event' } = {}) {
  try {
    if (!templateKey || !customerId) return { enrolled: false, reason: 'bad_args' };

    if (!(await isSequenceSendable(templateKey))) return { enrolled: false, reason: 'not_sendable' };

    const priorQuery = db('automation_enrollments')
      .where({ template_key: templateKey, customer_id: customerId });
    if (dedupe === 'ever') {
      priorQuery.where(function priorDelivered() {
        this.whereNot('status', 'failed').orWhereNotNull('last_sent_at');
      });
    } else {
      priorQuery.where('enrolled_at', '>', new Date(Date.now() - Number(dedupe) * 24 * 3600 * 1000));
    }
    if (await priorQuery.first('id')) return { enrolled: false, reason: 'deduped' };

    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!customer) return { enrolled: false, reason: 'no_customer' };
    const email = String(customer.email || '').trim();
    if (!email || !email.includes('@')) return { enrolled: false, reason: 'no_email' };

    const AutomationRunner = require('./automation-runner');
    const result = await AutomationRunner.enrollCustomer({
      templateKey,
      customer: {
        id: customer.id,
        email,
        first_name: customer.first_name || null,
        last_name: customer.last_name || null,
      },
    });
    if (result?.enrolled) {
      logger.info(`[automation-enroll] ${source}: enrolled customer ${customerId} in ${templateKey}`);
      return { enrolled: true, reason: 'enrolled' };
    }
    return { enrolled: false, reason: result?.reason || 'not_enrolled' };
  } catch (err) {
    logger.error(`[automation-enroll] ${source}: ${templateKey} enroll failed for customer ${customerId}: ${err.message}`);
    return { enrolled: false, reason: 'error' };
  }
}

module.exports = { enrollSequenceFromEvent, isSequenceSendable };
