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
    if (!candidates.length) return null;
    const lat = service.lat != null ? Number(service.lat) : null;
    const lng = service.lng != null ? Number(service.lng) : null;
    // Without coordinates or a technician there is no route to check; the
    // engine would also rank other technicians' routes the commit never uses.
    if (!service.technician_id || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

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
    if (!result || result.error || !Array.isArray(result.slots)) return null;

    const slotsByDate = new Map();
    for (const slot of result.slots) {
      if (!slotsByDate.has(slot.date)) slotsByDate.set(slot.date, []);
      slotsByDate.get(slot.date).push(slot);
    }
    const rejections = result.rejections_by_date || {};

    const checked = [];
    const unchecked = [];
    let decided = 0; // days the check certified as unusable
    for (const candidate of candidates) {
      const daySlots = slotsByDate.get(candidate.dateStr) || [];
      if (daySlots.length) {
        let chosen = null;
        for (const slot of daySlots) {
          const end = slot.end_time || toHHMM(minutesOf(slot.start_time) + durationMinutes);
          if (!(await clashesAt(candidate.dateStr, slot.start_time, end))) { chosen = slot; break; }
        }
        if (chosen) checked.push({ candidate, slot: chosen, window: windowFor(chosen.start_time, durationMinutes), routeChecked: true });
        else decided++;
        continue;
      }
      // No feasible start. A day whose only refusal is an unverifiable route
      // (or that the engine never evaluated) was not checked: it is not
      // "full". Any other refusal reason is a certified no.
      const reasons = Object.keys(rejections[candidate.dateStr] || {}).filter((k) => rejections[candidate.dateStr][k] > 0);
      if (reasons.length && !reasons.every((k) => k === 'route_unverified')) decided++;
      else unchecked.push(candidate);
    }
    // Every day unverified: nothing was route-checked, so today's list stands.
    if (!checked.length && !decided) return null;

    const bySoonest = (a, b) => b.score - a.score || (a.dateStr < b.dateStr ? -1 : 1);
    checked.sort((a, b) => finite(a.slot.score) - finite(b.slot.score)
      || finite(a.slot.detour_minutes) - finite(b.slot.detour_minutes) || bySoonest(a.candidate, b.candidate));
    unchecked.sort(bySoonest);

    const ranked = [...checked];
    // Unchecked days keep today's behavior (the visit's own window, the
    // overlap probe) after every checked day.
    for (const candidate of unchecked) {
      if (await clashesAt(candidate.dateStr, candidate.window.start, toHHMM(minutesOf(candidate.window.start) + durationMinutes))) continue;
      ranked.push({ candidate, slot: null, window: candidate.window, routeChecked: false });
    }
    return ranked;
  } catch (err) {
    logger.warn(`[route-ranked-days] route check failed, keeping the old list: ${err.message}`);
    return null;
  }
}

module.exports = { routeRankedDaysLive, staffRoadCheckOptions, rankRouteCheckedDays, _internals: { windowFor } };
