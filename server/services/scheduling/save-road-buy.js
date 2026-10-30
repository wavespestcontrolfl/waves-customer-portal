'use strict';

/**
 * GATE_SAVE_ROAD_BUY (owner 2026-10-28 design, "ok go" 2026-10-29): the entry
 * points an ADMIN staff save calls BEFORE it opens its transaction, so the
 * save's route check and its route number read the same Google road times the
 * Edit dialog's slot check bought (arrival-route.js buySaveRoads).
 *
 *  - Gate off (unset): every function returns null before any read or call.
 *  - Never throws, never blocks a save, never sends a customer message.
 *  - Call it outside any transaction, lock or row lock. It refuses to run on
 *    a transaction handle.
 *  - Admin callers only: pass `spender` = the staff user's id ONLY for an
 *    admin request. A technician, a customer page, the voice agent and the
 *    automatic writers pass none, and buy nothing.
 */

const logger = require('../logger');

function arrivalRoute() {
  const route = require('./arrival-route');
  return typeof route.buySaveRoads === 'function' && typeof route.saveRoadBuyLive === 'function' ? route : null;
}

const hhmm = (value) => (value ? String(value).slice(0, 5) : null);
const day = (value) => (value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : null);

/** Buys the legs for a placement the caller already knows (date, technician,
 *  start, end, plus `serviceId` + `changes` for a visit that exists, or
 *  `prospective` for one about to be created). Returns the purchase result, or
 *  null when the gate is off. */
async function buyRoadsBeforeSave(args = {}) {
  try {
    const route = arrivalRoute();
    if (!route || !route.saveRoadBuyLive()) return null;
    return await route.buySaveRoads(args);
  } catch (error) {
    logger.warn(`[save-road-buy] skipped: ${error.message}`);
    return null;
  }
}

/** The same, for a pending edit of an existing visit (`changes` = the fields
 *  the save will write): the destination date, technician and window are read
 *  from the stored row and the changes, as the save's own check derives them. */
async function buyRoadsForVisitSave({ spender, serviceId, changes = {}, excludeServiceIds = [], conn, check = true } = {}) {
  try {
    const route = arrivalRoute();
    const db = conn || require('../../models/db');
    if (!route?.saveRoadBuyLive() || !spender || !serviceId || db.isTransaction) return null;
    const stored = await db('scheduled_services').where({ id: serviceId })
      .first('scheduled_date', 'technician_id', 'window_start', 'window_end', 'estimated_duration_minutes');
    if (!stored) return null;
    // One view of the visit as the save leaves it: the stored row under the
    // pending changes. A new start with no new end leaves the stored end stale.
    const pending = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    const saved = { ...stored, ...pending, ...(pending.window_start && !pending.window_end ? { window_end: null } : {}) };
    const windowStart = hhmm(saved.window_start);
    let windowEnd = hhmm(saved.window_end);
    if (windowStart && !(windowEnd > windowStart)) {
      const [h, m] = windowStart.split(':').map(Number);
      const end = Math.min(h * 60 + m + (parseInt(saved.estimated_duration_minutes, 10) || 60), 23 * 60 + 59);
      windowEnd = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
    }
    return await route.buySaveRoads({
      spender, serviceId, changes, date: day(saved.scheduled_date), technicianId: saved.technician_id,
      windowStart, windowEnd, excludeServiceIds, conn: db, check,
    });
  } catch (error) {
    logger.warn(`[save-road-buy] skipped: ${error.message}`);
    return null;
  }
}

module.exports = { buyRoadsBeforeSave, buyRoadsForVisitSave };
