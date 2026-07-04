const db = require('../models/db');
const SmartRebooker = require('./rebooker');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { etDateString } = require('../utils/datetime-et');

async function sendAppointmentSms({ to, body, customerId, messageType }) {
  const result = await sendCustomerMessage({
    to,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment',
    customerId,
    identityTrustLevel: 'phone_matches_customer',
    metadata: { original_message_type: messageType },
  });
  if (result.blocked || result.sent === false) {
    throw new Error(`appointment SMS blocked: ${result.code || result.reason || 'unknown'}`);
  }
  return result;
}

class RescheduleSMS {
  async sendRescheduleRequest(serviceId, reasonCode, reasonText) {
    const service = await db('scheduled_services')
      .where('scheduled_services.id', serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.id as cust_id')
      .first();

    if (!service) throw new Error('Service not found');

    const options = await SmartRebooker.findRescheduleOptions(serviceId, reasonCode);
    const opt1 = options[0];
    const opt2 = options[1] || options[0];

    // scheduled_date is a Postgres DATE — node-postgres returns it as a JS Date
    // at UTC midnight, and formatting that in ET names the previous day.
    // Recover the calendar date string and anchor at noon instead.
    const originalDateStr = service.scheduled_date instanceof Date
      ? service.scheduled_date.toISOString().split('T')[0]
      : String(service.scheduled_date).split('T')[0];
    const originalDate = new Date(originalDateStr + 'T12:00:00')
      .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    const serviceType = (service.service_type || 'service').toLowerCase();
    const option1 = `${opt1.displayDate}, ${opt1.suggestedWindow.display}`;
    const option2 = `${opt2.displayDate}, ${opt2.suggestedWindow.display}`;

    const templateContext = { workflow: 'reschedule_options', entity_type: 'scheduled_service', entity_id: serviceId };
    let smsBody;
    let templateKey;
    if (reasonCode.startsWith('weather')) {
      templateKey = 'reschedule_options_weather';
      smsBody = await renderSmsTemplate(templateKey, {
        first_name: service.first_name, service_type: serviceType, original_date: originalDate, option_1: option1, option_2: option2,
      }, templateContext);
    } else if (reasonCode === 'customer_noshow' || reasonCode === 'gate_locked') {
      const accessIssue = reasonCode === 'gate_locked' ? 'the gate was locked' : "couldn't access the property";
      templateKey = 'reschedule_options_access';
      smsBody = await renderSmsTemplate(templateKey, {
        first_name: service.first_name, service_type: serviceType, access_issue: accessIssue, option_1: option1, option_2: option2,
      }, templateContext);
    } else {
      templateKey = 'reschedule_options_general';
      smsBody = await renderSmsTemplate(templateKey, {
        first_name: service.first_name, service_type: serviceType, original_date: originalDate, reason_text: reasonText ? ` ${reasonText}` : '', option_1: option1, option_2: option2,
      }, templateContext);
    }
    if (!smsBody) {
      logger.warn(`[reschedule-sms] template ${templateKey} missing/disabled — service ${serviceId}`);
      return { success: false, reason: 'missing_template', templateKey };
    }

    await sendAppointmentSms({
      to: service.phone,
      body: smsBody,
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
        option2: { date: opt2.date, window: opt2.suggestedWindow },
      }),
    }).returning('id');

    logger.info(`Reschedule SMS sent for customer ${service.cust_id || service.customer_id} for service ${serviceId}`);
    return { success: true, options: [opt1, opt2], logId: logEntry.id || logEntry };
  }

  async handleRescheduleReply(customerId, messageBody) {
    // Offers expire: with no age limit, a customer texting "1" weeks later
    // matched whatever pending offer row existed and booked its (possibly
    // long-past) date. 7 days comfortably covers a real reschedule
    // conversation.
    const pending = await db('reschedule_log')
      .where({ customer_id: customerId })
      .whereNull('customer_response')
      .where('created_at', '>', new Date(Date.now() - 7 * 86400000))
      .orderBy('created_at', 'desc')
      .first();

    if (!pending) return null;

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
      selectedOption = options.option2;
      responseType = 'option_2';
    } else if (reply.includes('call') || reply.includes('phone')) {
      responseType = 'call_requested';
    }

    // Offered dates can lapse between offer and reply — booking a past
    // date moves the job where no "upcoming" query finds it (rebooker
    // also rejects this; here we degrade to the call-requested flow so
    // the office follows up instead of the reply erroring out).
    if (selectedOption?.date && String(selectedOption.date) < etDateString()) {
      logger.warn(`[reschedule-sms] Customer ${customerId} picked an expired option (${selectedOption.date}) on log ${pending.id} — routing to office follow-up`);
      selectedOption = null;
      responseType = 'option_expired';
    }

    await db('reschedule_log').where({ id: pending.id }).update({
      customer_response: responseType,
      customer_response_text: messageBody,
      response_time_minutes: responseTime,
      sms_responded_at: db.fn.now(),
    });

    // Confirm-in-place: a rain-out already MOVED the appointment to option 1
    // before texting the customer, so "1 to confirm" (or a "2" that lands on the
    // same slot) is a pure confirmation — the visit is already booked there.
    // Re-running SmartRebooker.reschedule would re-validate it and, for a
    // same-day slot whose 1-hour internal window ticked past while the customer
    // was deciding, wrongly reject it as elapsed even though the reply arrived
    // inside the 2-hour window we quoted. Skip the re-book when the selection
    // already matches the live booking. The general reschedule flow offers only
    // FUTURE candidate dates the appointment isn't on yet, so this never short-
    // circuits a genuine move.
    let alreadyOnSlot = false;
    if (selectedOption) {
      const svc = await db('scheduled_services')
        .where({ id: pending.scheduled_service_id })
        .first('scheduled_date', 'window_start', 'status');
      const normTime = (t) => (t == null ? null : String(t).slice(0, 5));
      alreadyOnSlot = !!svc
        && String(svc.scheduled_date).slice(0, 10) === String(selectedOption.date).slice(0, 10)
        && normTime(svc.window_start) === normTime(selectedOption.window?.start)
        && !['completed', 'cancelled'].includes(svc.status);
    }

    if (selectedOption && !alreadyOnSlot) {
      try {
        await SmartRebooker.reschedule(
          pending.scheduled_service_id, selectedOption.date,
          selectedOption.window, pending.reason_code, 'customer_sms'
        );
      } catch (err) {
        // The offer was computed without a route check — rebooker can now
        // refuse it (tech conflict, window elapsed). The pending offer is
        // already marked responded above, so without a fallback the
        // customer would get silence. Degrade to the office-follow-up
        // flow below.
        if (err.isOperational || err.statusCode === 409 || err.statusCode === 400) {
          logger.warn(`[reschedule-sms] Selected option rejected for log ${pending.id} (${err.message}) — routing to office follow-up`);
          await db('reschedule_log').where({ id: pending.id }).update({ customer_response: 'option_unavailable' });
          selectedOption = null;
          responseType = 'option_expired';
        } else {
          throw err;
        }
      }
    }

    if (selectedOption) {
      const customer = await db('customers').where({ id: customerId }).first();
      const displayDate = new Date(selectedOption.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

      // Confirmation copy is inlined — the editable reschedule_confirmed_sms_reply
      // template was retired, but the customer must still get a confirmation the
      // moment their 1/2 reply lands (the appointment has already moved).
      const confirmedBody = `Confirmed. Your service is rescheduled for ${displayDate}, ${selectedOption.window.display}.\n\nWe'll remind you the day before.`;
      await sendAppointmentSms({
        to: customer.phone,
        body: confirmedBody,
        customerId,
        messageType: 'confirmation',
      });

      await db('reschedule_log').where({ id: pending.id }).update({
        new_date: selectedOption.date,
        new_window: `${selectedOption.window.start}-${selectedOption.window.end}`,
      });

      return { handled: true, action: 'rescheduled', newDate: selectedOption.date, smsSent: true };
    }

    // option_expired rides the call-requested flow: the customer picked a
    // date that lapsed before they replied, so the right outcome is the
    // same "we'll call you to find a time" SMS + handled:true — otherwise
    // the reply falls through to generic inbound handling after we already
    // closed the pending offer.
    if (responseType === 'call_requested' || responseType === 'option_expired') {
      const customer = await db('customers').where({ id: customerId }).first();
      // Inlined retired reschedule_call_requested copy so the customer still
      // gets an acknowledgement that we'll call them.
      const callBody = "No problem. We'll give you a call shortly.";
      await sendAppointmentSms({
        to: customer.phone,
        body: callBody,
        customerId,
        messageType: 'manual',
      });
      return { handled: true, action: responseType, smsSent: true };
    }

    return { handled: false, action: 'needs_review', reply: messageBody };
  }
}

module.exports = new RescheduleSMS();
