'use strict';

/**
 * GATE_DAY_ONLY_PROMISE part B2 (owner 2026-11-05 "D2 a", 2026-11-06 "office"): a MOVE notice promises only the new DAY
 * until the 24-hour reminder. The senders (admin-schedule sendRescheduleNoticeForVisit, appointment-reminders
 * handleReschedule, rain-out sendMovedSms, admin-dispatch applySeriesMoveEffects) share these helpers so each keeps its
 * own already-large function small. With the gate off every function here answers "today's copy" and reads nothing.
 *
 * The decision is time-promise.js dayOnlyMoveDecision (gate, the DATE changes, more than 24.25 h out, the customer's
 * 24-hour reminder will really go out, and the intent). A day-only send records DAY_PROMISE_META (promise_level 'day',
 * no slot) beside its guard fields, so the no-show reader reads it as a day promise and a bounced text can be rebuilt.
 * A missing, disabled or unrenderable day row sends today's window copy: a customer always gets a message, and the
 * window text is the safe side.
 */

const db = require('../models/db');
const logger = require('./logger');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { formatETDay, formatETDate, etDateString } = require('../utils/datetime-et');

const DAY_RESCHEDULED_KEY = 'appointment_rescheduled_day_v1';
const DAY_RAIN_KEY = 'rain_out_moved_day_v1';
const DAY_SERIES_KEYS = Object.freeze({
  appointment_series_rescheduled: 'appointment_series_rescheduled_day_v1',
  appointment_recurring_placement_confirmed: 'appointment_recurring_placement_confirmed_day_v1',
});

/** The placeholders a day row must keep (admin-sms-templates REQUIRED_TEMPLATE_PLACEHOLDERS), so a gutted row falls back. */
function requiredFor(templateKey) {
  try {
    return require('../routes/admin-sms-templates').REQUIRED_TEMPLATE_PLACEHOLDERS?.[templateKey];
  } catch {
    return undefined;
  }
}

/** Renders one day row, or null when it is missing, disabled or did not render (the caller then sends today's copy). */
async function renderDayRow(templateKey, vars, context) {
  try {
    const required = requiredFor(templateKey);
    const body = await renderSmsTemplate(templateKey, vars, context, required ? { requiredVars: required } : {});
    if (body) return body;
  } catch { /* fall through */ }
  logger.warn(`[day-only-move] ${templateKey} is missing, disabled or did not render - sending the window copy`);
  return null;
}

/**
 * May this move notice promise only the new day? Never throws; false on any failure. `ids` (or `serviceId`) are the visits
 * whose recorded intent decides when `intent` is absent. Gate off: false, nothing read.
 */
async function moveNoticeDayOnly({ serviceId, ids = null, customerId, newStartAt, oldDate, newDate, intent }) {
  try {
    const timePromise = require('./time-promise');
    if (!timePromise.dayOnlyPromiseOn()) return false;
    const reminders = require('./appointment-reminders');
    const prefs = await reminders.getReminderPrefs(customerId, { scheduledServiceId: serviceId });
    return await timePromise.dayOnlyMoveDecision(db, {
      id: serviceId, ids, newStartAt, oldDate, newDate, reminder24hEnabled: reminders.reminder24hWillSend(prefs), intent,
    });
  } catch (err) {
    logger.warn(`[day-only-move] decision failed for ${serviceId} (${err.message}) - sending the window copy`);
    return false;
  }
}

/** The slot (epoch ms) a notice is guarded on, or undefined when the time is missing or invalid. */
function slotMsOf(apptTime) {
  return apptTime && !Number.isNaN(apptTime.getTime()) ? apptTime.getTime() : undefined;
}

/** A customer move's decision (handleReschedule): only the choice "any time that day" (timePromise 'day') on a move with a
 *  real window can promise only the day. 'set_time', no choice, or a windowless move: false (today's copy), nothing read. */
async function customerMoveDayOnly({ options, resolved, serviceId, customerId, newStartAt }) {
  if (options?.timePromise !== 'day' || resolved?.windowless) return false;
  return moveNoticeDayOnly({
    serviceId, customerId, newStartAt, oldDate: options.previousDate, newDate: etDateString(newStartAt), intent: 'day',
  });
}

/** The `dayOnly: true` argument of a move-notice EMAIL (a reschedule text only), or nothing. */
function moveEmailDayArg(dayOnly, kind) {
  return dayOnly === true && kind === 'rescheduled' ? { dayOnly: true } : {};
}

/** The metadata a day-only move send adds: the day marker (no slot is recorded) plus the occurrence fields a bounced text
 *  and the ABA guard read (guard_slot_ms, promised_date, move_notice_slot_ms). Never read as a promise. */
function dayMoveMeta(slotMs) {
  const { DAY_PROMISE_META } = require('./time-promise');
  return {
    ...DAY_PROMISE_META,
    ...(Number.isFinite(slotMs) ? { guard_slot_ms: slotMs, promised_date: etDateString(new Date(slotMs)), move_notice_slot_ms: slotMs } : {}),
  };
}

const DAY_META_KEYS = ['window_unknown', 'promise_level', 'guard_slot_ms', 'promised_date', 'move_notice_slot_ms'];

/** Puts the day marker on `meta` when the send was decided day-only, and remembers the object so a day row that fails to
 *  render can take it off again (dayFellBack). Returns `meta`. */
function withDayMeta(meta, state, slotMs) {
  state.meta = meta;
  if (state.dayOnly) Object.assign(meta, dayMoveMeta(slotMs));
  return meta;
}

/** The send fell back to today's window copy: the send is no longer day-only and its metadata loses the marker. A key the
 *  window send records by itself (move_notice_slot_ms of a windowless notice) is put back by `keep`. */
function dayFellBack(state, keep = {}) {
  state.dayOnly = false;
  if (state.meta) {
    for (const key of DAY_META_KEYS) delete state.meta[key];
    Object.assign(state.meta, keep);
  }
}

/** The `dayOnly: true` argument of an email leg, or nothing: the window email's call keeps its exact shape. */
function dayOnlyArg(state) {
  return state && state.dayOnly === true ? { dayOnly: true } : {};
}

/**
 * The day-only reschedule text body, or null (no day decision, or the row failed: `state` is then reset to the window copy
 * and the caller renders today's row). Same vars as today's row minus the window and time.
 */
async function renderDayRescheduled({ state, serviceId, customerId, firstName, serviceLabel, apptTime, keep }) {
  if (!state.dayOnly) return null;
  let body = null;
  try {
    const differentTimeLine = await require('./reschedule-link').rescheduledDayTextLine(serviceId, { customerId });
    body = await renderDayRow(DAY_RESCHEDULED_KEY, {
      first_name: firstName,
      service_type: serviceLabel,
      day: formatETDay(apptTime),
      date: formatETDate(apptTime),
      different_time_line: differentTimeLine,
    }, { workflow: 'appointment_rescheduled', entity_type: 'scheduled_service', entity_id: serviceId });
  } catch (err) {
    logger.warn(`[day-only-move] day reschedule text for ${serviceId} did not render (${err.message})`);
  }
  if (!body) dayFellBack(state, keep);
  return body;
}

/** The day-only series notice row key for a series template, or null for a template with no day twin. */
function seriesDayKey(templateKey) {
  return DAY_SERIES_KEYS[templateKey] || null;
}

module.exports = {
  DAY_RESCHEDULED_KEY,
  DAY_RAIN_KEY,
  DAY_SERIES_KEYS,
  DAY_META_KEYS,
  renderDayRow,
  moveNoticeDayOnly,
  customerMoveDayOnly,
  moveEmailDayArg,
  slotMsOf,
  dayMoveMeta,
  withDayMeta,
  dayFellBack,
  dayOnlyArg,
  renderDayRescheduled,
  seriesDayKey,
};
