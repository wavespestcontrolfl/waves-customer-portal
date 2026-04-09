const db = require('../../models/db');
const TwilioService = require('../twilio');
const logger = require('../logger');

const WAVES_ADMIN_PHONE = '+19413187612';

class MissedAppointment {
  /**
   * Handle a skipped/missed appointment. First skip is handled by reschedule
   * system. 2+ skips in 90 days triggers escalation.
   */
  async onSkip(scheduledServiceId, reason = 'no_show') {
    // Look up the scheduled service and customer
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

    // Log the skip in reschedule_log
    await db('reschedule_log').insert({
      customer_id: customerId,
      scheduled_service_id: scheduledServiceId,
      reason_code: 'customer_noshow',
      initiated_by: 'system',
      notes: reason || 'skip',
    });

    // Count skips in the last 90 days
    const skipCount = await db('reschedule_log')
      .where({ customer_id: customerId, reason_code: 'customer_noshow' })
      .where('created_at', '>', db.raw("NOW() - INTERVAL '90 days'"))
      .count('id as count')
      .first();

    const totalSkips = parseInt(skipCount.count, 10);

    // First skip — the reschedule system handles it
    if (totalSkips <= 1) {
      logger.info(`First skip for customer ${customerId} — handled by reschedule system`);
      return { action: 'reschedule_system', skips: totalSkips };
    }

    // 2+ skips — escalate
    logger.warn(`Customer ${customerId} has ${totalSkips} skips in 90 days — escalating`);

    // Notify Adam
    await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
      `MISSED APPT ALERT: ${customer.first_name} ${customer.last_name} ` +
      `has missed ${totalSkips} appointments in 90 days. ` +
      `Reason: ${reason}. Needs a call.`,
      { messageType: 'admin_alert' }
    );

    // Send direct SMS to customer
    await TwilioService.sendSMS(customer.phone,
      `Hi ${customer.first_name}, we've noticed we've missed you a few times recently. ` +
      `We want to make sure your home stays protected. ` +
      `Can we find a better day/time that works for you? ` +
      `Reply with your preferred day or call us. - Waves Pest Control`,
      {
        customerId,
        messageType: 'missed_appointment',
        customerLocationId: customer.location_id,
      }
    );

    // Create follow-up task on customer record
    await db('customer_interactions').insert({
      customer_id: customerId,
      type: 'task',
      channel: 'internal',
      subject: `Follow-up: ${totalSkips} missed appointments`,
      notes: `Customer has skipped ${totalSkips} times in 90 days. Last reason: ${reason}. Needs phone call to re-engage.`,
      status: 'pending',
    });

    await db('customer_interactions').insert({
      customer_id: customerId,
      type: 'sms_outbound',
      channel: 'sms',
      subject: 'Missed appointment outreach',
      notes: `Auto-sent after ${totalSkips} skips in 90 days`,
    });

    return { action: 'escalated', skips: totalSkips };
  }
}

module.exports = new MissedAppointment();
