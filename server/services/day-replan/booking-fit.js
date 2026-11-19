'use strict';

const { currentOrder, promisedWindowOrder, staleOrderReasons } = require('../route-reorder-window-fit');
const { coVisitGroups, simulate, promisesKept } = require('./app-sim');
const { openTime, fitOfferedHour, serviceBlocks } = require('./close-gaps');
const { loadTechStartPoints, homeFromMap } = require('../scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../scheduling/departure-time');
const { groupRouteStops } = require('../scheduling/arrival-route');
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

// Capacity routing is technician-specific even while the legacy hour writer
// is tech-blind: only unassigned work is a fixed route block. Make-room
// destinations are a separate writer guard and retain its own scope — all
// technicians while tech-blind, or this technician plus unassigned rows when
// multi-tech confirmation is active.
function capacityScopedOccupancy(rows, techId, techBlind) {
  return rows.filter((row) => {
    if (row.conflict_reason === 'make_room_destination') {
      return row.technician_id == null || techBlind || sameTech(row, techId);
    }
    return row.technician_id == null;
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
// `groups` are groupRouteStops' canonical capacity rows: a visit_id or v2
// allocation is represented by its leader and summed work, exactly as the
// writer certified it. The only unknown id must be its prospective marker.
// Added/removed leaders or duplicates make the evidence stale, so the
// advisory score is suppressed instead of inventing an order.
function certifiedSequence(slot, groups, proposed) {
  const proof = slot?.[CAPACITY_PLACEMENT];
  const actualDuration = Number(proposed.estimated_duration_minutes);
  if (!Array.isArray(groups) || proof?.routeMode !== 'arrival_windows' || !Array.isArray(proof.order)
      || proof.order.length !== groups.length + 1 || !(actualDuration > 0)
      || !(Number(proof.workMinutes) >= actualDuration)) return null;
  const byMember = new Map();
  for (const group of groups) {
    const id = String(group.id);
    if (byMember.has(id)) return null;
    byMember.set(id, group);
  }
  const seen = new Set();
  let candidate = 0;
  const orderedGroups = [];
  for (const rawId of proof.order) {
    const id = String(rawId);
    if (id === '__candidate__') {
      candidate += 1;
      orderedGroups.push(proposed);
      continue;
    }
    const group = byMember.get(id);
    if (!group || seen.has(group)) return null;
    seen.add(group);
    orderedGroups.push(group);
  }
  if (candidate !== 1 || seen.size !== groups.length) return null;
  return orderedGroups;
}

// Capacity windows may overlap nominally: their safety comes from the
// certified sequence and real work lengths, not from fixed-hour vacancy.
// Re-simulate that order against the current rows and exact blocks before
// using it as advisory ranking evidence.
function fitCertifiedCapacity(input, slot, proposed) {
  const startMin = minute(slot.windowStart);
  const offeredEndMin = minute(slot.windowEnd);
  if (!Number.isFinite(startMin) || !Number.isFinite(offeredEndMin) || !(offeredEndMin > startMin)
      || startMin < input.bounds.openMin || !prefOk(input.pref, startMin)) return null;
  // reserveSlot's recruiting-interview guard applies to the complete offered
  // interval before capacity routing. A route may otherwise wait until a
  // mid-window interview ends and still keep the two-hour arrival promise,
  // producing an advisory card the writer refuses. Boundaries remain valid
  // handoffs; the simulation below separately catches delayed actual work.
  const nominalGuards = [...(input.interviewBlocks || []), ...(input.makeRoomBlocks || [])];
  if (nominalGuards.some(block => startMin < block.endMin && offeredEndMin > block.startMin)) return null;
  // The public card's end is its reserved/display width. The scoring target
  // carries the catalog's actual expected work; a certified longer placement
  // may safely be re-simulated at that shorter duration, but never vice versa.
  const actual = { ...proposed, window_end: hhmm(startMin + Number(proposed.estimated_duration_minutes)) };
  const seq = certifiedSequence(slot, input.capacityGroups, actual);
  if (!seq) return null;
  const sim = simulate(seq, {
    origin: input.origin,
    departureMin: input.bounds.departureMin,
    blockedIntervals: serviceBlocks(input.capacityBlocks || input.blocks),
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
    blockedIntervals: serviceBlocks(input.capacityBlocks || input.blocks),
  });
  if (!baseline) return null;
  return {
    start: slot.windowStart, startMin, finishMin: arrival.departureMin,
    driveMin: figures.driveMin, waitMin: figures.waitMin, sellableMin: figures.sellableMin,
    biggestMin: figures.biggestMin, slots: figures.slots, baselineDriveMin: baseline.travelMin,
  };
}

const prefOk = (pref, startMin) => !pref || (startMin >= pref.startMin && startMin < pref.endMin);

function offeredByDateAndTech(offered, today) {
  const byDate = new Map();
  for (const slot of offered) {
    if (!slot.techId || !slot.date || slot.date <= today || !/^\d\d:00(?::00)?$/.test(slot.windowStart)
        || !(minute(slot.windowEnd) > minute(slot.windowStart)) || slot.makeRoom) continue;
    if (!byDate.has(slot.date)) byDate.set(slot.date, new Map());
    const techs = byDate.get(slot.date);
    if (!techs.has(slot.techId)) techs.set(slot.techId, []);
    techs.get(slot.techId).push(slot);
  }
  return byDate;
}

function calendarReader(calendar) {
  return (key, load) => {
    if (!calendar.has(key)) calendar.set(key, load());
    return calendar.get(key);
  };
}

// One current snapshot per date. The matcher shares it across technicians and
// the morning alert's estimate candidates, then removes only each estimate's
// own unclaimed hold from that immutable base.
async function loadDateProof({ conn, date, target, ownEstimateId, read, replan }) {
  const loaded = await read(date, () => replan.loadDayStops(conn, date, { includeClaimedBookings: true }));
  const rows = withoutOwnEstimateHold(loaded.filter(row => String(row.id) !== String(target.id)), ownEstimateId);
  const targetIds = target.id == null ? [] : [String(target.id)];
  const occupancyKey = `occupancy|${date}|${targetIds.join(',')}`;
  const listed = await read(occupancyKey, () => listOccupiedWindows({
    db: conn, dateFrom: date, dateTo: date, excludeServiceIds: targetIds,
    excludeStatuses: DEFAULT_EXCLUDE_STATUSES, includeClaimedBookings: true,
  }));
  const interviews = await read(`interviews|${date}`, () => findInterviewConflicts({
    db: conn, date, windowStart: '00:00', windowEnd: '24:00',
  }));
  const occupancyRows = withoutOwnEstimateHold(occupiedRows(listed), ownEstimateId);
  return { rows, occupancyRows, occupiedById: occupancyById(occupancyRows), interviewBlocks: exactBlocks(interviews) };
}

// Assemble the writer-mirroring route and occupancy inputs for one technician.
// A malformed/stale route returns null before any offered hour is scored.
async function technicianProof({ conn, date, techId, day, read, replan, homes, departureMin,
  techBlind, mayRepairStaleOrder, pref, dayOpen, dayClose }) {
  const own = day.rows.filter(row => sameTech(row, techId) && !isHoldStop(row));
  if (own.some(row => !row.window_start || !hasPin(row) || !['confirmed', 'pending'].includes(row.status))) return null;
  const { ordered } = routeOrderFor(own, mayRepairStaleOrder);
  if (!ordered) return null;

  const groups = coVisitGroups(ordered);
  const capacityRows = day.rows.filter(row => sameTech(row, techId));
  const capacityGroups = groupRouteStops(capacityRows);
  const blocks = await read(`${date}|${techId}`, () => replan.loadBlocks(conn, date, techId));
  const routeIds = new Set(own.map(row => String(row.id)));
  const blocked = scopedOccupancy(day.occupancyRows, techId, techBlind, routeIds);
  const blockedHours = occupiedBlockedHours(blocked);
  const occupancyBlocks = blocked.map(({ startMin, endMin }) => ({ startMin, endMin }));
  const routeBlocks = [...blocks, ...day.interviewBlocks, ...occupancyBlocks];
  const capacityFixed = capacityScopedOccupancy(day.occupancyRows, techId, techBlind);
  const capacityOccupancyBlocks = capacityFixed.map(({ startMin, endMin }) => ({ startMin, endMin }));
  const makeRoomBlocks = capacityFixed.filter(row => row.conflict_reason === 'make_room_destination')
    .map(({ startMin, endMin }) => ({ startMin, endMin }));
  const capacityBlocks = [...blocks, ...day.interviewBlocks, ...capacityOccupancyBlocks];
  const unavailable = [...routeBlocks, ...blockedHours.map(hour => ({ startMin: hour * 60, endMin: hour * 60 + 60 }))];
  const origin = homeFromMap(homes, techId);
  const before = simulate(ordered, { origin, departureMin });
  const bounds = { openMin: dayOpen, closeMin: dayClose, departureMin, unavailable, driveBlocks: routeBlocks };
  const rowHours = row => routeRowHours(row, day.occupiedById, replan.rowHours);
  return { before, groups, capacityGroups, pref, origin, bounds, routeBlocks, capacityBlocks, makeRoomBlocks,
    interviewBlocks: day.interviewBlocks, blockedHours, rowHours };
}

function fitOneOfferedSlot(slot, target, techId, proof) {
  const proposed = { ...target, id: target.id || '__new_booking__', technician_id: techId,
    window_start: slot.windowStart, window_end: slot.windowEnd };
  const group = [proposed];
  const input = { groups: proof.groups, capacityGroups: proof.capacityGroups, group, leaderId: proposed.id,
    pref: proof.pref, origin: proof.origin, marginMin: DEFAULT_OPTIONS.marginMin, bounds: proof.bounds,
    blocks: proof.routeBlocks, capacityBlocks: proof.capacityBlocks, interviewBlocks: proof.interviewBlocks,
    makeRoomBlocks: proof.makeRoomBlocks,
    blockedHours: proof.blockedHours, rowHours: proof.rowHours, requireClose: true };
  const capacityFit = fitCertifiedCapacity(input, slot, proposed);
  const fit = capacityFit || (slot?.[CAPACITY_PLACEMENT] ? null : (proof.before && fitOfferedHour(
    { ...input, groups: [...proof.groups, group] }, minute(slot.windowStart) / 60)));
  const baselineDriveMin = capacityFit?.baselineDriveMin ?? proof.before?.travelMin;
  return fit && Number.isFinite(baselineDriveMin)
    ? { ...fit, addedDriveMin: fit.driveMin - baselineDriveMin, slot } : null;
}

// All inputs are stored appointments, pins and local drive estimates. One read of the route per date and
// one of the calendar blocks per technician-date. Candidates come from the caller's own admitted hours.
async function assessOfferedHours(conn, offered, target, {
  now = new Date(), pref = null, calendar = new Map(), ownEstimateId = null, allowStaleOrderFallback = false,
} = {}) {
  if (!hasPin(target)) return [];
  const replan = require('./index')._internals;
  const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
  const byDate = offeredByDateAndTech(offered, etDateString(now));
  if (!byDate.size) return [];
  const read = calendarReader(calendar);
  const homes = await read('homes', () => loadTechStartPoints(conn));
  const departureMin = await read('departure', () => dayDepartureMinutes(conn));
  const techBlind = !techScopedConfirmActive();
  const mayRepairStaleOrder = allowStaleOrderFallback === true;
  const fits = [];
  for (const [date, techs] of byDate) {
    const day = await loadDateProof({ conn, date, target, ownEstimateId, read, replan });
    for (const [techId, slots] of techs) {
      const proof = await technicianProof({ conn, date, techId, day, read, replan, homes, departureMin,
        techBlind, mayRepairStaleOrder, pref, dayOpen: DAY_OPEN, dayClose: DAY_CLOSE });
      if (!proof) continue;
      fits.push(...slots.map(slot => fitOneOfferedSlot(slot, target, techId, proof)).filter(Boolean));
    }
  }
  return fits;
}

// Only identifiers, the existing API order and local forecasts enter the
// internal record. The public array is never re-ranked or mutated.
async function measureOffers(conn, shown, target, options) {
  const fits = target ? await assessOfferedHours(conn, shown, target, options) : [];
  const bySlot = new Map(fits.map(f => [f.slot, f]));
  return shown.map((slot, index) => {
    const fit = bySlot.get(slot);
    return { date: slot.date, techId: slot.techId || null, start: slot.windowStart, end: slot.windowEnd,
      apiRank: index + 1,
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
  observeOffers, OFFER_RANK, CAPACITY_PLACEMENT,
  _internals: { assessOfferedHours, withoutOwnEstimateHold, routeOrderFor, certifiedSequence, fitCertifiedCapacity },
};
