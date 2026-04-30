const db = require('../models/db');
const SmartRebooker = require('./rebooker');
const TwilioService = require('./twilio');
const RULES = require('../config/reschedule-rules');
const logger = require('./logger');
const { parseETDateTime, etDateString } = require('../utils/datetime-et');

// "Friday, May 1" — ET-safe. Accepts a YYYY-MM-DD string or a Date.
// Schedule dates are ET wall-clock; Railway runs UTC, so .toISOString()
// + naive Date parsing can shift the day across midnight. Route both
// shapes through the ET helpers and format from the resulting absolute
// Date with timeZone: 'America/New_York'.
function formatDayDate(input) {
  if (!input) return '';
  const ymd = typeof input === 'string' ? input.split('T')[0] : etDateString(input);
  const dt = parseETDateTime(ymd + 'T12:00');
  return dt.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    timeZone: 'America/New_York',
  });
}

// "08:00:00" or "08:00" → "8:00 AM"
function formatTime12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map((p) => parseInt(p, 10));
  if (Number.isNaN(h)) return '';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ap = h < 12 ? 'AM' : 'PM';
  return `${h12}:${String(m || 0).padStart(2, '0')} ${ap}`;
}

// "08:00-09:00" → "08:00", or pass through if already an object/HH:MM.
function extractWindowStart(w) {
  if (!w) return '';
  if (typeof w === 'object') return w.start || '';
  const m = String(w).match(/^(\d{1,2}:\d{2})/);
  return m ? m[1] : '';
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

    const originalDate = new Date(typeof service.scheduled_date === 'string' ? service.scheduled_date + 'T12:00:00' : service.scheduled_date)
      .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

    let smsBody;
    if (reasonCode.startsWith('weather')) {
      smsBody = `Hi ${service.first_name}, due to weather your ${service.service_type.toLowerCase()} on ${originalDate} needs to move.\n\nWe have:\n1️⃣ ${opt1.displayDate}, ${opt1.suggestedWindow.display}\n2️⃣ ${opt2.displayDate}, ${opt2.suggestedWindow.display}\n\nReply 1 or 2, or suggest a day. — Waves 🌊`;
    } else if (reasonCode === 'customer_noshow' || reasonCode === 'gate_locked') {
      smsBody = `Hi ${service.first_name}, we stopped by for your ${service.service_type.toLowerCase()} but ${reasonCode === 'gate_locked' ? 'the gate was locked' : "couldn't access the property"}. We can come back:\n\n1️⃣ ${opt1.displayDate}, ${opt1.suggestedWindow.display}\n2️⃣ ${opt2.displayDate}, ${opt2.suggestedWindow.display}\n\nReply 1 or 2. — Adam, Waves`;
    } else {
      smsBody = `Hi ${service.first_name}, your ${service.service_type.toLowerCase()} on ${originalDate} needs to be rescheduled.${reasonText ? ' ' + reasonText : ''}\n\n1️⃣ ${opt1.displayDate}, ${opt1.suggestedWindow.display}\n2️⃣ ${opt2.displayDate}, ${opt2.suggestedWindow.display}\n\nReply 1 or 2. — Waves`;
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
        option2: { date: opt2.date, window: opt2.suggestedWindow },
      }),
    }).returning('id');

    logger.info(`Reschedule SMS sent to ${service.first_name} for service ${serviceId}`);
    return { success: true, options: [opt1, opt2], logId: logEntry.id || logEntry };
  }

  // Notify-only SMS sent AFTER the admin has already committed the
  // reschedule via the drag-drop flow. No 1️⃣/2️⃣ options, no pending
  // reschedule_log row — the customer already has their answer (the
  // new date/time). Replies fall through to the regular comms inbox.
  //
  // Mirrors the existing "Appointment Cancelled" template structure
  // (Hello {first_name}! Your {service_type}…) so reschedule + cancel
  // SMS read consistently.
  async sendRescheduleNotification(serviceId, originalDate, originalWindowStart, newDate, newWindow) {
    const service = await db('scheduled_services')
      .where('scheduled_services.id', serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(
        'scheduled_services.id',
        'scheduled_services.customer_id',
        'scheduled_services.service_type',
        'customers.first_name',
        'customers.phone',
        'customers.id as cust_id',
      )
      .first();

    if (!service) throw new Error('Service not found');
    if (!service.phone) {
      logger.warn(`[reschedule-sms] No phone on customer for service ${serviceId} — skipping notify SMS`);
      return { sent: false, reason: 'no_phone' };
    }

    const oldDay = formatDayDate(originalDate);
    const oldTime = formatTime12(originalWindowStart);
    const newDay = formatDayDate(newDate);
    const newTime = formatTime12(extractWindowStart(newWindow));

    const smsBody =
      `Hello ${service.first_name}! Your ${service.service_type} with Waves originally scheduled for ${oldDay}` +
      (oldTime ? ` at ${oldTime}` : '') +
      ` has been rescheduled to ${newDay}` +
      (newTime ? ` at ${newTime}` : '') +
      `.\n\nNeed to make a change? Reply here and we'll work it out.`;

    await TwilioService.sendSMS(service.phone, smsBody, {
      customerId: service.cust_id || service.customer_id,
      messageType: 'reschedule_notify',
    });

    logger.info(`Reschedule notify SMS sent to ${service.first_name} for service ${serviceId}`);
    return { sent: true };
  }

  async handleRescheduleReply(customerId, messageBody) {
    const pending = await db('reschedule_log')
      .where({ customer_id: customerId })
      .whereNull('customer_response')
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
