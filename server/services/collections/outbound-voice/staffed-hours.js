/**
 * Staffed-hours check for the collections voice lane — 9:00–17:59 ET,
 * Monday–Friday, read from the SAME constants the contact policy enforces
 * (one source of truth: server/services/collections/contact-policy.js).
 * Inside the window a press-0 / "human" escape warm-transfers to the office;
 * outside it the caller gets a callback task instead. The escape hatch
 * itself is ALWAYS available — only the transfer-vs-callback branch moves.
 */

const { etParts } = require('../../../utils/datetime-et');
const { CALL_WINDOW_START_HOUR, CALL_WINDOW_END_HOUR } = require('../contact-policy');

function isStaffedHours(now = new Date()) {
  const et = etParts(now);
  const weekday = et.dayOfWeek >= 1 && et.dayOfWeek <= 5;
  return weekday && et.hour >= CALL_WINDOW_START_HOUR && et.hour < CALL_WINDOW_END_HOUR;
}

module.exports = { isStaffedHours };
