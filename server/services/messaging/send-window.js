/**
 * Customer SMS send window (owner ruling 2026-08-07): automated customer/
 * lead-facing texts go out between 8:00 AM and 8:00 PM ET only. The trigger
 * incident: an evening schedule change put two visits inside the 24h
 * reminder window and the 15-minute reminder cron texted both customers at
 * 9:15 PM. The window matches the dropped-call SMS fence and Florida's FTSA
 * solicitation hours.
 *
 * This module is the single source of the window boundaries. Consumers:
 *   - validators/send-window.js — the canonical-path fence (every
 *     sendCustomerMessage SMS).
 *   - appointment-reminders.js — pre-send guard so a blocked reminder
 *     defers/skips deliberately instead of falling through to the email
 *     fallback + no-reachable-channel alert.
 *   - dropped-call-sms.js — its pre-existing 8/20 fence (live regardless of
 *     GATE_SMS_SEND_WINDOW) delegates here so the hours have one owner.
 *   - invoice.js processScheduledSends — pre-claim guard that moves a due
 *     scheduled send to the window open instead of burning retry attempts.
 *
 * Boundaries are ET wall-clock: sends allowed at/after 08:00 and strictly
 * before 20:00. DST is handled by etParts (Intl-based).
 */

const { etParts, etDateString, parseETDateTime } = require('../../utils/datetime-et');

const SEND_WINDOW_START_HOUR_ET = 8; // inclusive — sends allowed from 08:00 ET
const SEND_WINDOW_END_HOUR_ET = 20; // exclusive — no sends at/after 20:00 ET

function isWithinSendWindowET(date = new Date()) {
  const { hour } = etParts(date);
  return hour >= SEND_WINDOW_START_HOUR_ET && hour < SEND_WINDOW_END_HOUR_ET;
}

/**
 * The next instant the window opens: today 08:00 ET when called before the
 * window, tomorrow 08:00 ET when called during or after it. Callers use it
 * for `nextAllowedAt` on deferred results (review requests already
 * reschedule themselves from that field) and for the reminders' same-day
 * skip decision.
 *
 * The target is an ET CALENDAR date, never "now + 24 hours" (codex r26 P1):
 * from a late evening before the spring DST transition, +24 absolute hours
 * crosses TWO ET calendar dates (23:30 EST + 24h = 00:30 EDT two dates
 * later) and every held SMS would slip an extra day. Advancing from a noon
 * anchor is DST-proof — noon plus 24 hours lands at 11:00 or 13:00 on the
 * next ET date in the worst case, never on the date after it — and
 * parseETDateTime composes 08:00 on that date with the correct offset for
 * that specific day.
 */
function nextSendWindowOpenET(date = new Date()) {
  const { hour } = etParts(date);
  let targetYmd = etDateString(date);
  if (hour >= SEND_WINDOW_START_HOUR_ET) {
    // During or after today's window — next open is tomorrow (ET calendar).
    const noonET = parseETDateTime(`${targetYmd}T12:00:00`);
    targetYmd = etDateString(new Date(noonET.getTime() + 24 * 3600 * 1000));
  }
  return parseETDateTime(`${targetYmd}T08:00:00`);
}

module.exports = {
  SEND_WINDOW_START_HOUR_ET,
  SEND_WINDOW_END_HOUR_ET,
  isWithinSendWindowET,
  nextSendWindowOpenET,
};
