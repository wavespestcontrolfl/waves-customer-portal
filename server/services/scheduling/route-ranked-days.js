/**
 * Route-checked staff day lists (GATE_ROUTE_CHECK_STAFF_LISTS, owner
 * 2026-10-29, "Route Check Everywhere" build 1).
 *
 * The staff lists of days (the Reschedule window's suggested days, the Quick
 * Move day buttons) used to rank days by day load, same zip and city, and how
 * soon, at the visit's own window, and never looked at drive time. This module
 * asks the dispatcher's arrival-window route check (find-time.js
 * findArrivalWindowSlots) one question for every candidate day, then ranks the
 * days by the engine's own answer (least added drive) at the engine's best
 * feasible start.
 *
 * Money and security: only an admin caller may buy Google road times, exactly
 * as the picker route does (pickerRoadCheck + roadSpender + a request budget;
 * the durable ceilings in picker-road-spend.js fail closed to the estimate).
 * Any other caller, or none, gets the estimate only: `providerTravel: false`,
 * no pickerRoadCheck, no spender, no budget. A technician never buys Google.
 *
 * The helper never throws. `null` means "use today's list": the gate is off,
 * the search failed, or no day could be checked at all.
 */
const logger = require('../logger');

function routeRankedDaysLive() {
  const arrival = require('./arrival-route');
  return typeof arrival.routeCheckStaffListsLive === 'function'
    && arrival.routeCheckStaffListsLive() === true
    && arrival.arrivalWindowRoutingEnabled() === true;
}

/**
 * The road-time options a staff list search passes to findAvailableSlots.
 * Estimate only unless the caller is an admin with a technician id to count
 * the spend against and the picker road check is live.
 */
function staffRoadCheckOptions(caller) {
  const out = { providerTravel: false };
  if (caller && caller.isAdmin === true && caller.technicianId) {
    const arrival = require('./arrival-route');
    if (typeof arrival.pickerRoadCheckLive === 'function' && arrival.pickerRoadCheckLive()) {
      const { createPickerBudget } = require('./hint-road-times');
      out.pickerRoadCheck = true;
      out.roadSpender = caller.technicianId;
      out.pickerBudget = createPickerBudget();
    }
  }
  return out;
}

const finite = (n) => (Number.isFinite(Number(n)) && n !== null ? Number(n) : Infinity);

function minutesOf(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function toHHMM(total) {
  const t = Math.min(Math.max(0, total), 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function clock12(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

/** A window object in the rebooker's own shape, for a route-checked start. */
function windowFor(start, durationMinutes) {
  const startMin = minutesOf(start);
  const end = toHHMM(startMin + durationMinutes);
  return { start, end, display: `${clock12(start)}-${clock12(end)}` };
}

const UNVERIFIED = 'route_unverified';

/** The one route-check search for every candidate day; null = keep today's list. */
async function searchDays({ serviceId, service, candidates, durationMinutes, caller }) {
  const lat = service.lat != null ? Number(service.lat) : NaN;
  const lng = service.lng != null ? Number(service.lng) : NaN;
  // Without coordinates or a technician there is no route to check; the
  // engine would also rank other technicians' routes the commit never uses.
  const routable = Boolean(service.technician_id) && Number.isFinite(lat) && Number.isFinite(lng);
  if (!routable || !candidates.length) return null;
  const dates = candidates.map((c) => c.dateStr).sort();
  const { findAvailableSlots } = require('./find-time');
  const result = await findAvailableSlots({
    techStartPoints: true,
    lat,
    lng,
    durationMinutes,
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    technicianId: service.technician_id,
    topN: Number.POSITIVE_INFINITY,
    excludeServiceIds: [String(serviceId)],
    arrivalWindow: { serviceId, unit: true },
    slotStepMinutes: 60,
    // Eligibility (blackout days, work days, season, round) is decided by the
    // caller before the search; weekends and blackout days stay visible here.
    includeBlackoutDates: true,
    includeWeekends: true,
    ...staffRoadCheckOptions(caller),
  });
  return result && !result.error && Array.isArray(result.slots) ? result : null;
}

function slotsByDate(slots) {
  const byDate = new Map();
  for (const slot of slots) byDate.set(slot.date, [...(byDate.get(slot.date) || []), slot]);
  return byDate;
}

/** The engine's best start on the day that the commit's overlap probe also clears. */
async function firstClearSlot(daySlots, { clashesAt, date, durationMinutes }) {
  for (const slot of daySlots) {
    const end = slot.end_time || toHHMM(minutesOf(slot.start_time) + durationMinutes);
    if (!(await clashesAt(date, slot.start_time, end))) return slot;
  }
  return null;
}

/**
 * Each candidate day is exactly one of:
 *   checked    - the check found a start the overlap probe clears
 *   refused    - the check certified the day unusable (no start fits, a
 *                refusal other than an unreadable route, or every start clashes)
 *   unverified - the check could not tell (only `route_unverified` refusals,
 *                or the engine never evaluated the day)
 */
async function classifyDay(candidate, { byDate, rejections, clashesAt, durationMinutes }) {
  const date = candidate.dateStr;
  const daySlots = byDate.get(date) || [];
  if (daySlots.length) {
    const slot = await firstClearSlot(daySlots, { clashesAt, date, durationMinutes });
    return slot ? { kind: 'checked', candidate, slot } : { kind: 'refused', candidate };
  }
  const reasons = Object.entries(rejections[date] || {}).filter(([, count]) => count > 0).map(([reason]) => reason);
  const onlyUnverified = reasons.every((reason) => reason === UNVERIFIED);
  return { kind: onlyUnverified ? 'unverified' : 'refused', candidate };
}

const bySoonest = (a, b) => b.score - a.score || (a.dateStr < b.dateStr ? -1 : 1);

// Least added drive first (the engine's own score), then its detour, then the old score.
const byEngineRank = (a, b) => finite(a.slot.score) - finite(b.slot.score)
  || finite(a.slot.detour_minutes) - finite(b.slot.detour_minutes) || bySoonest(a.candidate, b.candidate);

/**
 * Rank candidate days by the route check.
 *
 * @param {object} p
 * @param {string} p.serviceId
 * @param {object} p.service        the visit row (lat/lng already guarded)
 * @param {Array}  p.candidates     [{ dateStr, score, window, ... }] days that
 *                                  passed every eligibility filter
 * @param {number} p.durationMinutes the same span the occupancy probe tests
 * @param {object} [p.caller]       { isAdmin, technicianId }; none = estimate only
 * @param {Function} p.clashesAt    async (dateStr, start, end) => boolean, the
 *                                  commit's own occupancy probe
 * @returns {Promise<Array|null>} ranked entries [{ candidate, window,
 *   slot|null, routeChecked }], or null = keep today's list
 */
async function rankRouteCheckedDays({ serviceId, service, candidates, durationMinutes, caller = null, clashesAt }) {
  try {
    const result = await searchDays({ serviceId, service, candidates, durationMinutes, caller });
    if (!result) return null;
    const context = { byDate: slotsByDate(result.slots), rejections: result.rejections_by_date || {}, clashesAt, durationMinutes };
    const days = { checked: [], refused: [], unverified: [] };
    for (const candidate of candidates) {
      const day = await classifyDay(candidate, context);
      days[day.kind].push(day);
    }
    // Every day unverified: nothing was route-checked, so today's list stands.
    if (!days.checked.length && !days.refused.length) return null;

    const ranked = days.checked.sort(byEngineRank)
      .map(({ candidate, slot }) => ({ candidate, slot, window: windowFor(slot.start_time, durationMinutes), routeChecked: true }));
    // Unverified days keep today's behavior (the visit's own window, the
    // overlap probe) after every checked day.
    const unverified = days.unverified.map((day) => day.candidate).sort(bySoonest);
    for (const candidate of unverified) {
      const end = toHHMM(minutesOf(candidate.window.start) + durationMinutes);
      if (!(await clashesAt(candidate.dateStr, candidate.window.start, end))) {
        ranked.push({ candidate, slot: null, window: candidate.window, routeChecked: false });
      }
    }
    return ranked;
  } catch (err) {
    logger.warn(`[route-ranked-days] route check failed, keeping the old list: ${err.message}`);
    return null;
  }
}

/**
 * The find_available_slots (Intelligence Bar) search options for a new stop at
 * lat/lng, or null when the old gap search should run (gate off, arrival
 * routing off, or no coordinates). Same road-time rules as the day lists.
 */
function newStopRouteOptions({ lat, lng, durationMinutes, caller }) {
  const point = { lat: Number(lat), lng: Number(lng) };
  const usable = routeRankedDaysLive() && Number.isFinite(point.lat) && Number.isFinite(point.lng);
  if (!usable) return null;
  return {
    arrivalWindow: { prospective: { ...point, estimated_duration_minutes: durationMinutes } },
    ...staffRoadCheckOptions(caller),
  };
}

/**
 * The arrival search lists no searched days; give a route-checked result the
 * days asked about so describeSlotSearch still explains each one.
 */
function withSearchedDays(result, routeChecked, dateFrom, dateTo) {
  const enumerateDates = require('./find-time')._internals?.enumerateDates;
  if (!routeChecked || result.searched_dates || typeof enumerateDates !== 'function') return result;
  return { ...result, searched_dates: enumerateDates(dateFrom, dateTo, { includeWeekends: true }) };
}

module.exports = { routeRankedDaysLive, staffRoadCheckOptions, newStopRouteOptions, withSearchedDays, rankRouteCheckedDays, _internals: { windowFor } };
