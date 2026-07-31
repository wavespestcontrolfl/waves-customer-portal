const db = require('../../models/db');
const logger = require('../logger');

class MissedAppointment {
  /**
   * Handle a skipped/missed appointment. First skip is handled by reschedule
   * system. 2+ skips in 90 days surfaces a recommended outreach task — no
   * SMS is sent automatically; the team reviews and sends manually.
   */
  async onSkip(scheduledServiceId, reason = 'no_show') {
    const service = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first();

    if (!service) {
      logger.error(`MissedAppointment: scheduled service ${scheduledServiceId} not found`);
      return null;
    }

    const customerId = service.customer_id;
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return null;

    // original_date = the slot that was missed. It is the OCCURRENCE key:
    // the same scheduled_services row can be missed more than once (soft
    // Quick Move no-show rebooks it in place), so dedupe checks and the
    // 90-day count below discriminate by (service, missed slot), not by
    // service row alone (codex P2 on #3110).
    await db('reschedule_log').insert({
      customer_id: customerId,
      scheduled_service_id: scheduledServiceId,
      reason_code: 'customer_noshow',
      initiated_by: 'system',
      original_date: service.scheduled_date || null,
      notes: reason || 'skip',
    });

    // Count distinct missed OCCURRENCES, not rows: a nightly-sweep flag and
    // a soft Quick Move of the same miss both log customer_noshow for the
    // same (service, slot) pair and must count once. Legacy rows with NULL
    // original_date collapse per-service, matching the old per-row behavior
    // closely enough for the 90-day window.
    const skipCount = await db('reschedule_log')
      .where({ customer_id: customerId, reason_code: 'customer_noshow' })
      .where('created_at', '>', db.raw("NOW() - INTERVAL '90 days'"))
      .select(db.raw("count(distinct (scheduled_service_id, coalesce(original_date, '1970-01-01'::date))) as count"))
      .first();

    const totalSkips = parseInt(skipCount.count, 10);

    if (totalSkips <= 1) {
      logger.info(`First skip for customer ${customerId} — handled by reschedule system`);
      return { action: 'reschedule_system', skips: totalSkips };
    }

    logger.warn(`Customer ${customerId} has ${totalSkips} skips in 90 days — creating recommendation`);

    const suggestedSms =
      `Hi ${customer.first_name}, we've noticed we've missed you a few times recently. ` +
      `We want to make sure your home stays protected. ` +
      `Can we find a better day/time that works for you? ` +
      `Reply with your preferred day or call us. - Waves Pest Control`;

    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'task',
      channel: 'internal',
      subject: `Recommended outreach: ${totalSkips} missed appointments in 90 days`,
      body:
        `Customer has skipped ${totalSkips} times in 90 days. Last reason: ${reason}. ` +
        `Recommend a phone call or reviewing/sending the SMS below.\n\n` +
        `Suggested SMS:\n${suggestedSms}`,
      status: 'pending',
    });

    return { action: 'recommendation_created', skips: totalSkips };
  }
}

module.exports = new MissedAppointment();
