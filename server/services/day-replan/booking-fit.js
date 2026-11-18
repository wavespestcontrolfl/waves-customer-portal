'use strict';

const { currentOrder, effectiveWindowRange } = require('../route-reorder-window-fit');
const { coVisitGroups, simulate } = require('./app-sim');
const { preferredFit, fitOfferedHour } = require('./close-gaps');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const { techScopedConfirmActive } = require('../scheduling/occupancy');
const { etDateString } = require('../../utils/datetime-et');

const OFFER_RANK = Symbol('dispatch offer ranking');
const { DEFAULT_OPTIONS } = require('./planner');
const minute = t => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
const hasPin = r => r?.lat != null && r?.lng != null && Number.isFinite(Number(r.lat))
  && Number.isFinite(Number(r.lng)) && Number(r.lat) !== 0 && Number(r.lng) !== 0;

// All inputs are stored appointments, pins and local drive estimates. One read of the route per date and
// one of the calendar blocks per technician-date. Candidates come from the caller's own admitted hours.
async function assessOfferedHours(conn, offered, target, { now = new Date(), pref = null, calendar = new Map() } = {}) {
  if (!hasPin(target)) return [];
  const replan = require('./index')._internals;
  const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
  const byDate = new Map();
  const today = etDateString(now);
  for (const slot of offered) {
    if (!slot.techId || !slot.date || slot.date <= today || !/^\d\d:00(?::00)?$/.test(slot.windowStart)
        || !(minute(slot.windowEnd) > minute(slot.windowStart)) || slot.makeRoom) continue;
    if (!byDate.has(slot.date)) byDate.set(slot.date, new Map());
    const techs = byDate.get(slot.date);
    if (!techs.has(slot.techId)) techs.set(slot.techId, []);
    techs.get(slot.techId).push(slot);
  }
  if (!byDate.size) return [];
  const read = (key, fn) => {
    if (!calendar.has(key)) calendar.set(key, fn());
    return calendar.get(key);
  };
  const homes = await read('homes', () => loadTechStartPoints(conn));
  const departureMin = await read('departure', () => dayDepartureMinutes(conn));
  const techBlind = !techScopedConfirmActive();
  const fits = [];
  for (const [date, techs] of byDate) {
    const rows = (await read(date, () => replan.loadDayStops(conn, date))).filter(r => r.id !== target.id);
    for (const [techId, slots] of techs) {
      const own = rows.filter(r => r.technician_id === techId && !r.reservation_expires_at);
      if (own.some(r => !r.window_start || !hasPin(r) || !['confirmed', 'pending'].includes(r.status))) continue;
      const ordered = currentOrder(own);
      if (ordered.some((r, i) => i && effectiveWindowRange(r).startMin < effectiveWindowRange(ordered[i - 1]).startMin)) continue;
      const groups = coVisitGroups(ordered);
      const blocks = await read(`${date}|${techId}`, () => replan.loadBlocks(conn, date, techId));
      const blockedHours = [...new Set([...replan.blockedHoursFor(rows, techId, techBlind),
        ...rows.filter(r => r.technician_id === techId && r.reservation_expires_at).flatMap(replan.rowHours)])];
      const unavailable = [...blocks, ...blockedHours.map(h => ({ startMin: h * 60, endMin: h * 60 + 60 }))];
      const origin = homeFromMap(homes, techId);
      const before = simulate(ordered, { origin, departureMin });
      if (!before) continue;
      const bounds = { openMin: DAY_OPEN, closeMin: DAY_CLOSE, departureMin, unavailable, driveBlocks: blocks };
      for (const slot of slots) {
        const proposed = { ...target, id: target.id || '__new_booking__', technician_id: techId, window_start: slot.windowStart, window_end: slot.windowEnd };
        const group = [proposed];
        const fit = fitOfferedHour({ groups: [...groups, group], group, leaderId: proposed.id, pref,
          origin, marginMin: DEFAULT_OPTIONS.marginMin, bounds, blocks, blockedHours, rowHours: replan.rowHours, requireClose: true },
        minute(slot.windowStart) / 60);
        if (fit) fits.push({ ...fit, addedDriveMin: fit.driveMin - before.travelMin, slot });
      }
    }
  }
  return fits;
}

// Keep the existing day spread, soonest card, scarcity pins and rain priorities. Within each technician-date
// and rain tier, only hours checked successfully may exchange positions.
function rankOfferedHours(slots, fits, { pinned = 0, rainTierOf = null } = {}) {
  const checked = new Map(fits.map(f => [f.slot, f]));
  const positions = new Map();
  slots.forEach((slot, index) => {
    if (index < pinned || !checked.has(slot)) return;
    const key = [slot.date, slot.techId, rainTierOf?.(slot) ?? '', !!(slot.routeOptimal && slot.nearbyJob)].join('|');
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key).push(index);
  });
  const ranked = [...slots];
  for (const indexes of positions.values()) {
    const pool = indexes.map(i => checked.get(slots[i]));
    for (const index of indexes) {
      const best = preferredFit(pool);
      ranked[index] = best.slot;
      pool.splice(pool.indexOf(best), 1);
    }
  }
  return ranked;
}

// Only identifiers, offered times and local forecasts enter the internal record. The Symbol is
// copied by the in-process cache and omitted by JSON when Express answers the public request.
async function measureOffers(conn, shown, target, options) {
  const fits = target ? await assessOfferedHours(conn, shown, target, options) : [];
  const ranks = rankOfferedHours(shown, fits, options);
  const bySlot = new Map(fits.map(f => [f.slot, f]));
  return shown.map((slot, index) => {
    const fit = bySlot.get(slot);
    return { date: slot.date, techId: slot.techId || null, start: slot.windowStart, end: slot.windowEnd,
      displayed: index + 1, proposed: ranks.indexOf(slot) + 1,
      ...(fit ? { driveMin: fit.driveMin, addedDriveMin: fit.addedDriveMin, finishMin: fit.finishMin, slots: fit.slots, waitMin: fit.waitMin } : {}) };
  });
}

// The picker returns immediately. Only the internal morning check or a real customer page read
// starts the route calculations. Requests served from one picker cache entry share one calculation.
function observeOffers(conn, shown, target, options = {}) {
  let pending;
  return () => {
    if (!pending) pending = measureOffers(conn, shown, target, options).catch(err => {
      require('../logger').warn(`[booking-fit] scoring unavailable (${err.message})`);
      return measureOffers(conn, shown, null, options);
    });
    return pending;
  };
}

module.exports = { assessOfferedHours, rankOfferedHours, observeOffers, OFFER_RANK };
