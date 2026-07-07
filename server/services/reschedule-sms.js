const db = require('../models/db');
const SmartRebooker = require('./rebooker');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { etDateString, etParts, addETDays } = require('../utils/datetime-et');
const { ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');

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
  // sendRescheduleRequest removed 2026-07-06 — it had no callers and its
  // reschedule_options_* templates never fired in prod; the rain-out engine
  // owns weather moves with its own template. handleRescheduleReply below
  // stays: it serves the live reply-1/2 webhook flow (rain-out, tech-track).

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
        .first('scheduled_date', 'window_start', 'window_end', 'status');
      // pg/Knex can return scheduled_date as a JS Date OR a 'YYYY-MM-DD' string —
      // normalize both (mirrors track-transitions.isFutureScheduledDate) so a Date
      // doesn't stringify to 'Sat Jul 04' and silently miss the match.
      const toYmd = (v) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));
      const normTime = (t) => (t == null ? null : String(t).slice(0, 5));
      const toMin = (t) => {
        const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
        return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
      };
      // Confirm in place only while the reply is still inside the 2-hour arrival
      // window we quoted the customer. A same-day reply after that window has
      // passed must fall through to SmartRebooker.reschedule, which rejects the
      // elapsed slot and routes to office follow-up — the pre-shortcut behavior.
      const optStartMin = toMin(selectedOption.window?.start);
      const sameDay = toYmd(selectedOption.date) === etDateString();
      const now = etParts(new Date());
      const withinQuotedWindow = !sameDay
        || (optStartMin != null && (now.hour * 60 + now.minute) < optStartMin + ARRIVAL_WINDOW_MINUTES);
      // Match date + FULL window (start AND end) so a slot that was manually
      // widened/edited off the reply option still re-books to the tight target
      // instead of being silently confirmed as-is. Exclude every non-live status
      // (completed/cancelled/skipped) so a reply can't "confirm" a dead visit.
      alreadyOnSlot = !!svc
        && toYmd(svc.scheduled_date) === toYmd(selectedOption.date)
        && normTime(svc.window_start) === normTime(selectedOption.window?.start)
        && normTime(svc.window_end) === normTime(selectedOption.window?.end)
        && !['completed', 'cancelled', 'skipped'].includes(svc.status)
        && withinQuotedWindow;
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

      // SmartRebooker moves the visit but never touches appointment_reminders,
      // so without this sync the reminder row keeps the OLD slot's time and the
      // day-before reminder for the new date never fires (the dispatch rain-out
      // route does the same sync after its own moves — see
      // syncRescheduleReminder in routes/admin-dispatch.js). sendNotification
      // false: the confirmation SMS below is the customer notice;
      // coverDueWindows keeps the 15-min cron from firing a duplicate
      // day-before text for a window that notice already covers.
      if (selectedOption) {
        try {
          const AppointmentReminders = require('./appointment-reminders');
          await AppointmentReminders.handleReschedule(
            pending.scheduled_service_id,
            `${selectedOption.date}T${selectedOption.window?.start || '08:00'}`,
            { sendNotification: false, coverDueWindows: true },
          );
        } catch (err) {
          logger.warn(`[reschedule-sms] Reminder sync failed for ${pending.scheduled_service_id}: ${err.message}`);
        }
      }
    }

    if (selectedOption) {
      const customer = await db('customers').where({ id: customerId }).first();
      const displayDate = new Date(selectedOption.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

      // The copy varies by how far out the confirmed slot is, because the
      // closing line must only promise what the reminder cron will actually
      // do: the day-before (24h) reminder only fires for appointments at least
      // two days out, so for a same-day or next-day slot "we'll remind you the
      // day before" is a promise that is already impossible to keep.
      const todayEt = etDateString();
      const tomorrowEt = etDateString(addETDays(new Date(), 1));
      const optDate = String(selectedOption.date);
      const closingLine = optDate === todayEt
        ? 'See you today.'
        : optDate === tomorrowEt
          ? 'See you tomorrow.'
          : "We'll remind you the day before.";
      const templateKey = optDate === todayEt
        ? 'reschedule_confirmed_today'
        : optDate === tomorrowEt
          ? 'reschedule_confirmed_tomorrow'
          : 'reschedule_confirmed_future';

      // Admin-editable template first (sms_templates, appointments category);
      // the inlined copy is the fail-safe. This confirmation is transactional —
      // the visit has already moved when the reply lands — so a missing or
      // disabled template must revert to stock copy, never silence the send.
      const confirmedBody = (await renderSmsTemplate(
        templateKey,
        { date: displayDate, time: selectedOption.window.display },
        { workflow: 'reschedule_reply', entity_type: 'scheduled_service', entity_id: pending.scheduled_service_id },
      )) || `Confirmed. Your service is rescheduled for ${displayDate}, ${selectedOption.window.display}.\n\n${closingLine}`;
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
      // Admin-editable template first; inlined copy is the fail-safe so the
      // customer always gets an acknowledgement that we'll call them.
      const callBody = (await renderSmsTemplate(
        'reschedule_call_requested',
        {},
        { workflow: 'reschedule_reply', entity_type: 'scheduled_service', entity_id: pending.scheduled_service_id },
      )) || "No problem. We'll give you a call shortly.";
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
