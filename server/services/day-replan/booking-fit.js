'use strict';

const { currentOrder, promisedWindowOrder, staleOrderReasons } = require('../route-reorder-window-fit');
const { coVisitGroups, simulate, promisesKept } = require('./app-sim');
const { openTime, preferredFit, fitOfferedHour, serviceBlocks } = require('./close-gaps');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const {
  DEFAULT_EXCLUDE_STATUSES, findInterviewConflicts, listOccupiedWindows, occupiedRows, techScopedConfirmActive,
} = require('../scheduling/occupancy');
const { isHoldStop } = require('../scheduling/travel-gap');
const { etDateString } = require('../../utils/datetime-et');

const OFFER_RANK = Symbol('dispatch offer ranking');
// find-time's capacity result has already certified one insertion order. The
// estimate picker carries that evidence only in-process: Symbols survive the
// picker spreads but are omitted from the public JSON response.
const CAPACITY_PLACEMENT = Symbol.for('waves.dispatch.certifiedCapacityPlacement');
const { DEFAULT_OPTIONS } = require('./planner');
const minute = t => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
const hhmm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
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
// a hold, completed row or make-room destination that is not in that route remains an exact unavailable interval.
function scopedOccupancy(rows, techId, techBlind, routeIds) {
  return rows.filter((row) => {
    const own = sameTech(row, techId);
    if (own && routeIds.has(String(row.id)) && !isHoldStop(row)) return false;
    return !(!own && row.technician_id != null && !techBlind);
  });
}

function occupiedBlockedHours(rows) {
  const hours = new Set(rows.flatMap(spanHours));
  return [...hours].sort((a, b) => a - b);
}

// Future-day route numbers are authoritative only when they form one complete, unique, promise-ordered sequence.
// The live arrival-route writer is allowed to repair a stale sequence; callers outside that policy must suppress the
// uncertain measurement rather than score a route nobody has certified.
function routeOrderFor(rows, allowStaleOrderFallback) {
  const staleReasons = staleOrderReasons(rows, rows, { futureDay: true });
  if (!staleReasons.length) return { ordered: currentOrder(rows), staleReasons };
  return { ordered: allowStaleOrderFallback ? promisedWindowOrder(rows) : null, staleReasons };
}

// Rebuild one freshly loaded route in the capacity picker's certified order.
// The only unknown id must be its prospective marker. Added/removed stops,
// duplicate ids, or a grouping shape we cannot map exactly make the evidence
// stale, so the advisory score is suppressed instead of inventing an order.
function certifiedSequence(slot, groups, proposed) {
  const proof = slot?.[CAPACITY_PLACEMENT];
  const actualDuration = Number(proposed.estimated_duration_minutes);
  if (proof?.routeMode !== 'arrival_windows' || !Array.isArray(proof.order)
      || proof.order.length !== groups.length + 1 || !(actualDuration > 0)
      || !(Number(proof.durationMinutes) >= actualDuration)) return null;
  const byMember = new Map();
  for (const group of groups) {
    for (const row of group) {
      const id = String(row.id);
      if (byMember.has(id)) return null;
      byMember.set(id, group);
    }
  }
  const seen = new Set();
  let candidate = 0;
  const orderedGroups = [];
  for (const rawId of proof.order) {
    const id = String(rawId);
    if (id === '__candidate__') {
      candidate += 1;
      orderedGroups.push([proposed]);
      continue;
    }
    const group = byMember.get(id);
    if (!group || seen.has(group)) return null;
    seen.add(group);
    orderedGroups.push(group);
  }
  if (candidate !== 1 || seen.size !== groups.length) return null;
  return orderedGroups.flat();
}

// Capacity windows may overlap nominally: their safety comes from the
// certified sequence and real work lengths, not from fixed-hour vacancy.
// Re-simulate that order against the current rows and exact blocks before
// using it as advisory ranking evidence.
function fitCertifiedCapacity(input, slot, proposed) {
  const startMin = minute(slot.windowStart);
  if (!Number.isFinite(startMin) || startMin < input.bounds.openMin || !prefOk(input.pref, startMin)) return null;
  // The public card's end is its reserved/display width. The scoring target
  // carries the catalog's actual expected work; a certified longer placement
  // may safely be re-simulated at that shorter duration, but never vice versa.
  const actual = { ...proposed, window_end: hhmm(startMin + Number(proposed.estimated_duration_minutes)) };
  const seq = certifiedSequence(slot, input.groups, actual);
  if (!seq) return null;
  const sim = simulate(seq, {
    origin: input.origin,
    departureMin: input.bounds.departureMin,
    blockedIntervals: serviceBlocks(input.blocks),
  });
  if (!sim || !promisesKept(sim, seq, input.marginMin)
      || (input.requireClose && sim.serviceFinishMin > input.bounds.closeMin)) return null;
  const figures = openTime(sim, input.bounds);
  const arrival = sim.arrivals.find(row => String(row.id) === String(actual.id));
  if (!figures || !arrival) return null;
  const baselineSeq = seq.filter(row => String(row.id) !== String(actual.id));
  const baseline = simulate(baselineSeq, {
    origin: input.origin,
    departureMin: input.bounds.departureMin,
    blockedIntervals: serviceBlocks(input.blocks),
  });
  if (!baseline) return null;
  return {
    start: slot.windowStart, startMin, finishMin: arrival.departureMin,
    driveMin: figures.driveMin, waitMin: figures.waitMin, sellableMin: figures.sellableMin,
    biggestMin: figures.biggestMin, slots: figures.slots, baselineDriveMin: baseline.travelMin,
  };
}

const prefOk = (pref, startMin) => !pref || (startMin >= pref.startMin && startMin < pref.endMin);

// All inputs are stored appointments, pins and local drive estimates. One read of the route per date and
// one of the calendar blocks per technician-date. Candidates come from the caller's own admitted hours.
async function assessOfferedHours(conn, offered, target, {
  now = new Date(), pref = null, calendar = new Map(), ownEstimateId = null, allowStaleOrderFallback = false,
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
  const mayRepairStaleOrder = allowStaleOrderFallback === true;
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
      const { ordered } = routeOrderFor(own, mayRepairStaleOrder);
      if (!ordered) continue;
      const groups = coVisitGroups(ordered);
      const blocks = await read(`${date}|${techId}`, () => replan.loadBlocks(conn, date, techId));
      const routeIds = new Set(own.map(row => String(row.id)));
      const blocked = scopedOccupancy(occupancyRows, techId, techBlind, routeIds);
      const blockedHours = occupiedBlockedHours(blocked);
      const rowHours = row => routeRowHours(row, occupiedById, replan.rowHours);
      // The whole-hour set mirrors the writer for nominal offered windows. Exact spans additionally protect a
      // route-delayed service: a 10 AM card that actually runs until 11:30 may not cross an 11 AM rival hold.
      // The simulator's strict overlap rule preserves a handoff exactly at either interval boundary.
      const occupancyBlocks = blocked.map(({ startMin, endMin }) => ({ startMin, endMin }));
      const routeBlocks = [...blocks, ...interviewBlocks, ...occupancyBlocks];
      const unavailable = [...routeBlocks, ...blockedHours.map(h => ({ startMin: h * 60, endMin: h * 60 + 60 }))];
      const origin = homeFromMap(homes, techId);
      const before = simulate(ordered, { origin, departureMin });
      const bounds = { openMin: DAY_OPEN, closeMin: DAY_CLOSE, departureMin, unavailable, driveBlocks: routeBlocks };
      for (const slot of slots) {
        const proposed = { ...target, id: target.id || '__new_booking__', technician_id: techId, window_start: slot.windowStart, window_end: slot.windowEnd };
        const group = [proposed];
        const input = { groups, group, leaderId: proposed.id, pref, origin,
          marginMin: DEFAULT_OPTIONS.marginMin, bounds, blocks: routeBlocks, blockedHours, rowHours, requireClose: true };
        const capacityFit = fitCertifiedCapacity(input, slot, proposed);
        const fit = capacityFit || (slot?.[CAPACITY_PLACEMENT] ? null : (before && fitOfferedHour(
          { ...input, groups: [...groups, group] }, minute(slot.windowStart) / 60)));
        const baselineDriveMin = capacityFit?.baselineDriveMin ?? before?.travelMin;
        if (fit && Number.isFinite(baselineDriveMin)) fits.push({ ...fit, addedDriveMin: fit.driveMin - baselineDriveMin, slot });
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

// Only identifiers, offered times and local forecasts enter the internal record. These ranks describe the API slot
// array, not rendered card positions: customer pickers may truncate or rearrange that array. The Symbol is copied by
// the in-process cache and omitted by JSON when Express answers the public request.
async function measureOffers(conn, shown, target, options) {
  const fits = target ? await assessOfferedHours(conn, shown, target, options) : [];
  const ranks = rankOfferedHours(shown, fits, options);
  const bySlot = new Map(fits.map(f => [f.slot, f]));
  return shown.map((slot, index) => {
    const fit = bySlot.get(slot);
    return { date: slot.date, techId: slot.techId || null, start: slot.windowStart, end: slot.windowEnd,
      apiRank: index + 1, proposedApiRank: ranks.indexOf(slot) + 1,
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
  assessOfferedHours, rankOfferedHours, observeOffers, OFFER_RANK, CAPACITY_PLACEMENT,
  _internals: { withoutOwnEstimateHold, routeOrderFor, certifiedSequence, fitCertifiedCapacity },
};
