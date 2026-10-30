'use strict';

/**
 * GATE_ROUTE_WARNING_DETAIL (owner 2026-10-29, "ok go"; the Waves route-dispatcher audit,
 * fix B). A staff route warning says WHICH stop, its window, the arrival the route predicts and
 * the minutes it misses by, instead of one sentence for every day:
 *
 *   "Stop 6 (2–4 PM window) would arrive 4:12 PM, 12 min late."
 *   "Stop 1 (8–10 AM window) has no map pin."
 *
 * The words here are shared by every caller of a route check, technicians included
 * (rain-out slot-check), so they carry the stop NUMBER, its window, a time and minutes, never a
 * customer name. Read at call time; unset = today's strings, byte for byte. Warn only: the text
 * never blocks a save. Nothing here talks to a customer.
 */

const { gateEnvValue } = require('../../config/feature-gates');

function routeWarningDetailLive() {
  return typeof gateEnvValue === 'function' && gateEnvValue('GATE_ROUTE_WARNING_DETAIL') === true;
}

/** `{ detail: true }` on a staff check's `arrivalWindow` while the gate is on, else `{}`, so the
 *  object a caller builds is exactly today's with the gate off. */
function detailOption() {
  return routeWarningDetailLive() ? { detail: true } : {};
}

/** A visit auto-dispatch never moves: not a recurring child. With the gate on, its address-pin notice stays
 *  open when it is locked, excluded or customer-confirmed, because its pin serves the route check, not the
 *  night run (audit.js pinNoticeHeldOut, auto-dispatch/index.js stillLiveOn). */
function pinServesRouteCheckOnly(row) {
  return routeWarningDetailLive() && (row.is_recurring !== true || row.recurring_parent_id == null);
}

function clock(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const hour = Math.floor(total / 60) % 24;
  const minute = total % 60;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return { h12, minute, meridiem: hour < 12 ? 'AM' : 'PM' };
}

function clockText(minutes) {
  const c = clock(minutes);
  return `${c.h12}${c.minute ? `:${String(c.minute).padStart(2, '0')}` : ''} ${c.meridiem}`;
}

/** 2–4 PM, 11 AM–1 PM, 8:30–10:30 AM. */
function windowText(range) {
  if (!range || !Number.isFinite(range.startMin) || !Number.isFinite(range.endMin)) return '';
  const a = clock(range.startMin);
  const b = clock(range.endMin);
  const part = (c) => `${c.h12}${c.minute ? `:${String(c.minute).padStart(2, '0')}` : ''}`;
  return a.meridiem === b.meridiem
    ? `${part(a)}–${part(b)} ${b.meridiem}`
    : `${part(a)} ${a.meridiem}–${part(b)} ${b.meridiem}`;
}

/** "Stop 6 (2–4 PM window)"; "Stop 6" when the stop has no window; "This new visit (…)" for a
 *  visit that is not saved yet (no number). */
function stopLabel(number, range, { isNew = false } = {}) {
  const win = windowText(range);
  if (isNew || !Number.isFinite(number)) return win ? `This new visit (${win} window)` : 'This new visit';
  return win ? `Stop ${number} (${win} window)` : `Stop ${number}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One stop that misses its window: "Stop 6 (2–4 PM window) would arrive 4:12 PM, 12 min late." */
function lateSentence(label, arrivalMin, lateMinutes, { already = false } = {}) {
  return `${label} would ${already ? 'already ' : ''}arrive ${clockText(arrivalMin)}, ${lateMinutes} min late${already ? ' without this visit' : ''}.`;
}

/** A later stop that still arrives but with too little room before its window closes. */
function tightSentence(label, arrivalMin, minutesLeft) {
  return `${label} would arrive ${clockText(arrivalMin)}, only ${minutesLeft} min before its window closes.`;
}

function dayEndSentence(dayEndMin) {
  return `The route would run past ${clockText(dayEndMin)}, the end of the workday.`;
}

module.exports = {
  routeWarningDetailLive, detailOption, pinServesRouteCheckOnly, clockText, windowText, stopLabel, plural,
  lateSentence, tightSentence, dayEndSentence,
};
