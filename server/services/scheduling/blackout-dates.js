/**
 * Owner blackout days — shared lookup for every surface that offers or
 * commits customer-facing dates (admin Settings → Scheduling → Blackout
 * days; table: schedule_blackout_dates).
 *
 * Consumers:
 *   - scheduling/find-time.js       (offer enumeration: /book, reschedule,
 *                                    estimate route-aware slots, AI searches)
 *   - estimate-slot-availability.js (ASAP capacity fallback enumerates its
 *                                    own dates)
 *   - rebooker.findRescheduleOptions (rain-out SMS alternates)
 *   - routes/booking.js /confirm + slot-reservation reserveSlot (REDEMPTION
 *     re-check: a signed offer minted before the blackout was added must not
 *     stay bookable)
 *
 * Both helpers FAIL OPEN (empty set / false) — an availability or commit
 * outage is worse than an offered day off; the office alert + dispatch board
 * still surface anything that slips through.
 */

const db = require('../../models/db');
const logger = require('../logger');

function toDateStr(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).split('T')[0];
}

// Set of YYYY-MM-DD blackout dates within [fromStr, toStr] (inclusive).
async function getBlackoutDates(fromStr, toStr) {
  try {
    const rows = await db('schedule_blackout_dates')
      .whereBetween('date', [fromStr, toStr])
      .select('date');
    return new Set(rows.map((r) => toDateStr(r.date)));
  } catch (err) {
    logger.warn(`[blackout-dates] range lookup failed (failing open): ${err.message}`);
    return new Set();
  }
}

// True when a single YYYY-MM-DD date is blacked out.
async function isBlackoutDate(dateStr) {
  try {
    const row = await db('schedule_blackout_dates')
      .where('date', String(dateStr).split('T')[0])
      .first('id');
    return !!row;
  } catch (err) {
    logger.warn(`[blackout-dates] date lookup failed (failing open): ${err.message}`);
    return false;
  }
}

module.exports = { getBlackoutDates, isBlackoutDate };
