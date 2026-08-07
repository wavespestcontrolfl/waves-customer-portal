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
 *
 * Boundaries are ET wall-clock: sends allowed at/after 08:00 and strictly
 * before 20:00. DST is handled by etParts (Intl-based).
 */

const { etParts } = require('../../utils/datetime-et');

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
 * skip decision. Computed by stepping in UTC and re-reading ET wall-clock,
 * so a DST boundary between now and the target can't skew the hour.
 */
function nextSendWindowOpenET(date = new Date()) {
  const { hour } = etParts(date);
  // Start from the current instant and roll forward to the target ET date.
  let target = new Date(date.getTime());
  if (hour >= SEND_WINDOW_START_HOUR_ET) {
    // During or after today's window — next open is tomorrow.
    target = new Date(target.getTime() + 24 * 3600 * 1000);
  }
  // Snap to 08:00 ET on the target's ET calendar date. Iterate because a
  // DST transition can shift the wall-clock by an hour after arithmetic.
  for (let i = 0; i < 3; i++) {
    const p = etParts(target);
    const deltaMinutes = (SEND_WINDOW_START_HOUR_ET - p.hour) * 60 - p.minute;
    if (deltaMinutes === 0 && p.second === 0) break;
    target = new Date(target.getTime() + deltaMinutes * 60 * 1000 - p.second * 1000);
  }
  return target;
}

module.exports = {
  SEND_WINDOW_START_HOUR_ET,
  SEND_WINDOW_END_HOUR_ET,
  isWithinSendWindowET,
  nextSendWindowOpenET,
};
