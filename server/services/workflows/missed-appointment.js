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

    // original_date + original_window = the slot that was missed. Together
    // with the service id they are the OCCURRENCE key: the same
    // scheduled_services row can be missed more than once (soft Quick Move
    // no-show rebooks it in place — possibly later the SAME day), so dedupe
    // checks and the 90-day count discriminate by (service, slot date, slot
    // window), never by service row alone (codex r1+r2 on #3110).
    await db('reschedule_log').insert({
      customer_id: customerId,
      scheduled_service_id: scheduledServiceId,
      reason_code: 'customer_noshow',
      initiated_by: 'system',
      original_date: service.scheduled_date || null,
      original_window: service.window_start ? `${service.window_start}-${service.window_end}` : null,
      notes: reason || 'skip',
    });

    return this.evaluateThreshold(customerId, reason);
  }

  /**
   * Count distinct missed occurrences in the last 90 days and park the
   * outreach recommendation at 2+. Split from onSkip so a writer that
   * already logged the occurrence itself — the soft Quick Move no-show logs
   * customer_noshow through the rebooker — can run the threshold without
   * inserting the occurrence a second time (codex r2 on #3110).
   */
  async evaluateThreshold(customerId, reason = 'no_show') {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return null;

    // Count distinct missed OCCURRENCES, not rows: a nightly-sweep flag and
    // a soft Quick Move of the same miss both log customer_noshow for the
    // same (service, slot) key and must count once, while a soft-moved
    // visit missed AGAIN — even later the same day — is a new occurrence
    // because the window differs. Legacy rows with NULL slot fields
    // collapse per-service, matching the old per-row behavior closely
    // enough for the 90-day window.
    const skipCount = await db('reschedule_log')
      .where({ customer_id: customerId, reason_code: 'customer_noshow' })
      .where('created_at', '>', db.raw("NOW() - INTERVAL '90 days'"))
      .select(db.raw("count(distinct (scheduled_service_id, coalesce(original_date, '1970-01-01'::date), coalesce(original_window, ''))) as count"))
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
