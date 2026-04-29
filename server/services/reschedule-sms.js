const db = require('../models/db');
const SmartRebooker = require('./rebooker');
const TwilioService = require('./twilio');
const RULES = require('../config/reschedule-rules');
const logger = require('./logger');

// How long after sending a request we still consider it "pending" for the
// purposes of matching customer replies. Older rows are treated as expired
// and never auto-handled — operator can still see the message in the inbox.
const RESPONSE_WINDOW_HOURS = RULES.escalation.customer_response_timeout_hours;

// How long after sending we treat another send for the same service as a
// duplicate and skip Twilio. Guards against admin double-click and any
// short-window retry (transient 5xx, scheduler re-fire).
const DUPLICATE_SEND_WINDOW_MINUTES = 30;

class RescheduleSMS {
  async sendRescheduleRequest(serviceId, reasonCode, reasonText) {
    const service = await db('scheduled_services')
      .where('scheduled_services.id', serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.id as cust_id')
      .first();

    if (!service) throw new Error('Service not found');

    // Idempotency guard: if we already sent a reschedule request for this
    // service in the last DUPLICATE_SEND_WINDOW_MINUTES that's still pending
    // (no customer response yet), don't send again. Returns the existing
    // log row so the caller can surface that to the operator.
    const recentPending = await db('reschedule_log')
      .where({ scheduled_service_id: serviceId })
      .whereNull('customer_response')
      .where('sms_sent_at', '>', db.raw(`NOW() - INTERVAL '${DUPLICATE_SEND_WINDOW_MINUTES} minutes'`))
      .orderBy('sms_sent_at', 'desc')
      .first();

    if (recentPending) {
      logger.info(`[reschedule-sms] Skipping duplicate send for service ${serviceId} — pending log ${recentPending.id} sent at ${recentPending.sms_sent_at}`);
      return { success: true, skipped: 'duplicate_within_window', logId: recentPending.id };
    }

    const options = await SmartRebooker.findRescheduleOptions(serviceId, reasonCode);
    if (!options || !options.length) {
      logger.warn(`[reschedule-sms] No reschedule options available for service ${serviceId} (reason ${reasonCode})`);
      return { success: false, reason: 'no_options_available' };
    }

    const opt1 = options[0];
    const opt2 = options[1] || null; // explicit null — never duplicate opt1

    const originalDate = new Date(typeof service.scheduled_date === 'string' ? service.scheduled_date + 'T12:00:00' : service.scheduled_date)
      .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

    // Build the option block — single-option layout when only one slot is available.
    const optionsBlock = opt2
      ? `1️⃣ ${opt1.displayDate}, ${opt1.suggestedWindow.display}\n2️⃣ ${opt2.displayDate}, ${opt2.suggestedWindow.display}`
      : `1️⃣ ${opt1.displayDate}, ${opt1.suggestedWindow.display}`;

    const replyPrompt = opt2
      ? 'Reply 1 or 2'
      : 'Reply 1 to confirm';

    let smsBody;
    if (reasonCode.startsWith('weather')) {
      smsBody = `Hi ${service.first_name}, due to weather your ${service.service_type.toLowerCase()} on ${originalDate} needs to move.\n\nWe have:\n${optionsBlock}\n\n${replyPrompt}, or suggest a day. — Waves 🌊`;
    } else if (reasonCode === 'customer_noshow' || reasonCode === 'gate_locked') {
      smsBody = `Hi ${service.first_name}, we stopped by for your ${service.service_type.toLowerCase()} but ${reasonCode === 'gate_locked' ? 'the gate was locked' : "couldn't access the property"}. We can come back:\n\n${optionsBlock}\n\n${replyPrompt}. — Adam, Waves`;
    } else {
      smsBody = `Hi ${service.first_name}, your ${service.service_type.toLowerCase()} on ${originalDate} needs to be rescheduled.${reasonText ? ' ' + reasonText : ''}\n\n${optionsBlock}\n\n${replyPrompt}. — Waves`;
    }

    await TwilioService.sendSMS(service.phone, smsBody, {
      customerId: service.cust_id || service.customer_id,
      messageType: 'reschedule',
    });

    const [logEntry] = await db('reschedule_log').insert({
      scheduled_service_id: serviceId,
      customer_id: service.cust_id || service.customer_id,
      original_date: service.scheduled_date,
      reason_code: reasonCode,
      initiated_by: reasonCode.startsWith('weather') ? 'weather_auto' : 'admin',
      sms_sent_at: db.fn.now(),
      notes: JSON.stringify({
        option1: { date: opt1.date, window: opt1.suggestedWindow },
        option2: opt2 ? { date: opt2.date, window: opt2.suggestedWindow } : null,
      }),
    }).returning('id');

    logger.info(`Reschedule SMS sent to ${service.first_name} for service ${serviceId} (${opt2 ? '2 options' : '1 option'})`);
    return { success: true, options: opt2 ? [opt1, opt2] : [opt1], logId: logEntry.id || logEntry };
  }

  async handleRescheduleReply(customerId, messageBody) {
    // Only match rows still inside the response window. Older pending rows
    // are treated as expired — a customer reply that arrives 5 days later
    // shouldn't silently re-trigger a reschedule from a forgotten thread.
    const pendingRows = await db('reschedule_log')
      .where({ customer_id: customerId })
      .whereNull('customer_response')
      .where('sms_sent_at', '>', db.raw(`NOW() - INTERVAL '${RESPONSE_WINDOW_HOURS} hours'`))
      .orderBy('sms_sent_at', 'desc');

    if (!pendingRows.length) return null;

    // Multiple simultaneously-pending requests for the same customer — e.g.,
    // two services rescheduled in quick succession. We can't reliably tell
    // which one a bare "1" reply refers to, so escalate to the operator
    // rather than guessing the most-recent.
    if (pendingRows.length > 1) {
      logger.warn(`[reschedule-sms] Customer ${customerId} has ${pendingRows.length} pending reschedule rows — needs operator disambiguation`);
      return {
        handled: false,
        action: 'needs_disambiguation',
        pending_count: pendingRows.length,
        reply: messageBody,
      };
    }

    const pending = pendingRows[0];

    let options = {};
    try {
      options = typeof pending.notes === 'string' ? JSON.parse(pending.notes) : (pending.notes || {});
    } catch (e) {
      logger.warn(`[reschedule-sms] Failed to parse notes for log ${pending.id}: ${e.message}`);
    }
    const reply = (messageBody || '').trim().toLowerCase();
    const responseTime = pending.sms_sent_at ? Math.round((Date.now() - new Date(pending.sms_sent_at).getTime()) / 60000) : null;

    let selectedOption = null;
    let responseType = 'freeform';

    if (reply === '1' || reply === 'one' || reply.startsWith('1 ') || reply.startsWith('1.')) {
      selectedOption = options.option1;
      responseType = 'option_1';
    } else if (reply === '2' || reply === 'two' || reply.startsWith('2 ') || reply.startsWith('2.')) {
      // Only honor "2" when option2 was actually offered. If we sent a
      // single-option SMS and the customer says "2" anyway, fall through
      // to freeform so the operator can sort it out.
      if (options.option2) {
        selectedOption = options.option2;
        responseType = 'option_2';
      }
    } else if (reply.includes('call') || reply.includes('phone')) {
      responseType = 'call_requested';
    }

    await db('reschedule_log').where({ id: pending.id }).update({
      customer_response: responseType,
      customer_response_text: messageBody,
      response_time_minutes: responseTime,
      sms_responded_at: db.fn.now(),
    });

    if (selectedOption) {
      await SmartRebooker.reschedule(
        pending.scheduled_service_id, selectedOption.date,
        selectedOption.window, pending.reason_code, 'customer_sms'
      );

      const customer = await db('customers').where({ id: customerId }).first();
      const displayDate = new Date(selectedOption.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

      await TwilioService.sendSMS(customer.phone,
        `Confirmed! Your service is rescheduled for ${displayDate}, ${selectedOption.window.display}. We'll remind you the day before. — Waves 🌊`,
        { customerId, messageType: 'confirmation' }
      );

      await db('reschedule_log').where({ id: pending.id }).update({
        new_date: selectedOption.date,
        new_window: `${selectedOption.window.start}-${selectedOption.window.end}`,
      });

      return { handled: true, action: 'rescheduled', newDate: selectedOption.date };
    }

    if (responseType === 'call_requested') {
      const customer = await db('customers').where({ id: customerId }).first();
      await TwilioService.sendSMS(customer.phone,
        `No problem! We'll give you a call shortly. — Waves`,
        { customerId, messageType: 'manual' }
      );
      return { handled: true, action: 'call_requested' };
    }

    return { handled: false, action: 'needs_review', reply: messageBody };
  }
}

module.exports = new RescheduleSMS();
