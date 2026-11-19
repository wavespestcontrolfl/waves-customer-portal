'use strict';

const { currentOrder, effectiveWindowRange } = require('../route-reorder-window-fit');
const { coVisitGroups, simulate } = require('./app-sim');
const { preferredFit, fitOfferedHour } = require('./close-gaps');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const {
  DEFAULT_EXCLUDE_STATUSES, findInterviewConflicts, listOccupiedWindows, occupiedRows, techScopedConfirmActive,
} = require('../scheduling/occupancy');
const { isHoldStop } = require('../scheduling/travel-gap');
const { etDateString } = require('../../utils/datetime-et');

const OFFER_RANK = Symbol('dispatch offer ranking');
const { DEFAULT_OPTIONS } = require('./planner');
const minute = t => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
const hasPin = r => r?.lat != null && r?.lng != null && Number.isFinite(Number(r.lat))
  && Number.isFinite(Number(r.lng)) && Number(r.lat) !== 0 && Number(r.lng) !== 0;

// loadDayStops has already removed expired holds. A public picker may be re-reading the hour held by this same
// estimate, so remove only that known hold; committed rows and every other estimate's live hold remain occupancy.
const isOwnEstimateHold = (row, ownEstimateId) => !!ownEstimateId && row.source_estimate_id != null
  && String(row.source_estimate_id) === String(ownEstimateId) && isHoldStop(row);

function withoutOwnEstimateHold(rows, ownEstimateId) {
  if (!ownEstimateId) return rows;
  return rows.filter(row => !isOwnEstimateHold(row, ownEstimateId));
}

const sameTech = (row, techId) => row.technician_id != null && String(row.technician_id) === String(techId);

// listOccupiedWindows supplies the writer-mirroring spans, including a v2 allocation's summed work and live
// make-room destinations. Keep those spans separate from the richer day-route rows: the latter carry the premise,
// route order and pin fields the travel simulation needs, while this map answers only which booked hours they hold.
function spanHours(row) {
  const start = Number(row.startMin);
  const end = Number(row.endMin);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return [];
  const first = Math.floor(start / 60);
  const last = Math.max(first, Math.ceil(end / 60) - 1);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function occupancyById(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = String(row.id);
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(row);
  }
  return byId;
}

function exactBlocks(rows) {
  return rows.map(row => ({ startMin: minute(row.window_start), endMin: minute(row.window_end) }))
    .filter(block => Number.isFinite(block.startMin) && Number.isFinite(block.endMin) && block.endMin > block.startMin);
}

function routeRowHours(row, byId, fallback) {
  const spans = byId.get(String(row.id));
  if (!spans?.length) return fallback(row);
  return [...new Set(spans.flatMap(spanHours))];
}

// The booking writer scopes occupancy to unassigned rows plus this technician when multi-tech confirmation is on;
// with the gate off, every other technician blocks too. A same-tech committed route row is handled by `groups`, but
// a hold, completed row or destination that is not in that route must still block its canonical occupied span.
function occupiedBlockedHours(rows, techId, techBlind, routeIds) {
  const hours = new Set();
  for (const row of rows) {
    const own = sameTech(row, techId);
    if (own && routeIds.has(String(row.id)) && !isHoldStop(row)) continue;
    if (!own && row.technician_id != null && !techBlind) continue;
    for (const hour of spanHours(row)) hours.add(hour);
  }
  return [...hours].sort((a, b) => a - b);
}

// All inputs are stored appointments, pins and local drive estimates. One read of the route per date and
// one of the calendar blocks per technician-date. Candidates come from the caller's own admitted hours.
async function assessOfferedHours(conn, offered, target, {
  now = new Date(), pref = null, calendar = new Map(), ownEstimateId = null,
} = {}) {
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
    const loaded = await read(date, () => replan.loadDayStops(conn, date));
    const rows = withoutOwnEstimateHold(loaded.filter(r => String(r.id) !== String(target.id)), ownEstimateId);
    // One canonical occupancy read per date/target is shared by every technician and, for new estimates, by the
    // morning matcher’s 20 estimates. Target exclusion also removes a make-room chain that moves this target, as the
    // writer does. Own estimate holds are filtered only after the cached read so different estimates can share it;
    // committed customer-linked rows from that estimate stay occupied even when a stale expiry stamp remains.
    const targetIds = target.id == null ? [] : [String(target.id)];
    const occupancyKey = `occupancy|${date}|${targetIds.join(',')}`;
    const listed = await read(occupancyKey, () => listOccupiedWindows({
      db: conn, dateFrom: date, dateTo: date, excludeServiceIds: targetIds,
      excludeStatuses: DEFAULT_EXCLUDE_STATUSES,
    }));
    // The reservation writer's interview guard is separate from listOccupiedWindows.
    // Read its actual buffered spans once for the whole calendar day; the morning
    // matcher shares `calendar` across all 20 estimates, so every estimate and
    // technician reuses this promise. Interviews are office-wide occupancy and
    // therefore intentionally carry no technician scope here.
    const interviews = await read(`interviews|${date}`, () => findInterviewConflicts({
      db: conn, date, windowStart: '00:00', windowEnd: '24:00',
    }));
    const interviewBlocks = exactBlocks(interviews);
    const occupancyRows = withoutOwnEstimateHold(occupiedRows(listed), ownEstimateId);
    const occupiedById = occupancyById(occupancyRows);
    for (const [techId, slots] of techs) {
      // A linked appointment with a leftover reservation stamp is committed, not a hold: route and simulate it.
      const own = rows.filter(r => sameTech(r, techId) && !isHoldStop(r));
      if (own.some(r => !r.window_start || !hasPin(r) || !['confirmed', 'pending'].includes(r.status))) continue;
      const ordered = currentOrder(own);
      if (ordered.some((r, i) => i && effectiveWindowRange(r).startMin < effectiveWindowRange(ordered[i - 1]).startMin)) continue;
      const groups = coVisitGroups(ordered);
      const blocks = await read(`${date}|${techId}`, () => replan.loadBlocks(conn, date, techId));
      const routeIds = new Set(own.map(row => String(row.id)));
      const blockedHours = occupiedBlockedHours(occupancyRows, techId, techBlind, routeIds);
      const rowHours = row => routeRowHours(row, occupiedById, replan.rowHours);
      const routeBlocks = [...blocks, ...interviewBlocks];
      const unavailable = [...routeBlocks, ...blockedHours.map(h => ({ startMin: h * 60, endMin: h * 60 + 60 }))];
      const origin = homeFromMap(homes, techId);
      const before = simulate(ordered, { origin, departureMin });
      if (!before) continue;
      const bounds = { openMin: DAY_OPEN, closeMin: DAY_CLOSE, departureMin, unavailable, driveBlocks: routeBlocks };
      for (const slot of slots) {
        const proposed = { ...target, id: target.id || '__new_booking__', technician_id: techId, window_start: slot.windowStart, window_end: slot.windowEnd };
        const group = [proposed];
        const fit = fitOfferedHour({ groups: [...groups, group], group, leaderId: proposed.id, pref,
          origin, marginMin: DEFAULT_OPTIONS.marginMin, bounds, blocks: routeBlocks, blockedHours, rowHours, requireClose: true },
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

module.exports = {
  assessOfferedHours, rankOfferedHours, observeOffers, OFFER_RANK,
  _internals: { withoutOwnEstimateHold },
};
