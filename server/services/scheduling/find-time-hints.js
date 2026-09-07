/**
 * Hint-mode policy for POST /admin/schedule/find-time — the advisory
 * "best times" lines under the admin date/time pickers (useBestTimes).
 *
 * The engine (find-time.js) ranks route gaps per technician. This module
 * turns that list into what a picker may SAY: which hours survive the
 * tech-blind occupancy guard and the picker's own same-day floor, and what
 * the hour already in the picker costs. Everything here is advisory —
 * every failure path keeps the engine's answer or withholds a verdict;
 * nothing blocks a save (the commit's locked occupancy check is the
 * enforcer).
 */

const logger = require('../logger');
const { loadOccupancy, conflictsForTarget } = require('../rain-out');
const { checkArrivalPlacement } = require('./arrival-route');
const { DAY_START_HOUR, DAY_END_HOUR } = require('./find-time');
const { ADMIN_DAY_END_MINUTES } = require('./window-rules');
const { etParts } = require('../../utils/datetime-et');

function toMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Request-shape check for the picker-hint params. Returns an error message
 * or null.
 *   pickedStart     — the hour already in the picker (HH:MM), so the answer
 *                     can say what THAT hour costs, not only which rank best.
 *   pickedEnd       — the edit form's window end (HH:MM); set independently
 *                     of the service duration, so the picked hour is scored
 *                     over the WHOLE window, like the live conflict check.
 *   sameDayFloorMin — the picker's own same-day floor (next top of the hour,
 *                     or the running-late target) in minutes from midnight,
 *                     applied inside the candidate walk so a topN:1 range
 *                     answer is the best hour that clears it. The engine's
 *                     now+30 lead still applies underneath.
 */
function validateHintParams({ pickedStart, pickedEnd, sameDayFloorMin }) {
  if (pickedStart !== undefined && !HHMM.test(String(pickedStart))) return 'pickedStart must be HH:MM';
  if (pickedEnd !== undefined && !HHMM.test(String(pickedEnd))) return 'pickedEnd must be HH:MM';
  if (sameDayFloorMin !== undefined && !(Number.isInteger(sameDayFloorMin) && sameDayFloorMin >= 0 && sameDayFloorMin <= 24 * 60)) {
    return 'sameDayFloorMin must be an integer number of minutes within the day';
  }
  return null;
}

function toHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * A leg to or from a coordless anchor scores as zero drive in the engine
 * (its gaps stay offered) and is reported as a null leg; the detour built
 * on such a leg is equally unknown — null it too so no surface can claim
 * "no added drive" for a route it could not price (Codex #4120 r3).
 */
function markUnknownDetours(slots) {
  return slots.map((s) => (
    s.drive_in_minutes === null || s.drive_out_minutes === null ? { ...s, detour_minutes: null } : s
  ));
}

/**
 * The engine walks per-technician routes, so a scheduled row with NO
 * assigned tech occupies no route and is invisible to it — an hour it
 * recommends can sit on an unassigned visit the commit will still reject.
 * Mirror the dispatch slot-check occupancy guard (tech-blind, same overlap
 * predicate, excludeServiceIds honored) and veto those hours. The engine
 * emits only the EARLIEST start per route gap, so a vetoed candidate must
 * not discard its whole gap — walk the gap through latest_start_min at the
 * request's step and keep the first clear start (detour is
 * position-independent within a gap). The picker's own same-day floor
 * (next top-of-hour / running-late target) starts the walk, so a
 * single-answer range search returns the best hour that clears it. Then
 * dedupe technician/time pairs by day+start (the list is rank-sorted,
 * first wins) BEFORE slicing, or the chips row collapses below the
 * requested count. Fail-open like checkSlots: a snapshot failure keeps the
 * engine's answer, minus hours the picker itself would refuse.
 */
async function guardHintSlots(slots, { today, sameDayFloorMin, step, spanMin, excluded, topN }) {
  const floorFor = (date) => (date === today && Number.isInteger(sameDayFloorMin) ? sameDayFloorMin : 0);
  let guarded = slots;
  try {
    const occupancyByDate = new Map();
    await Promise.all([...new Set(slots.map((s) => s.date))].map(async (d) => {
      occupancyByDate.set(d, await loadOccupancy({ dateFrom: d, dateTo: d }));
    }));
    guarded = slots.flatMap((s) => {
      const floorMin = floorFor(s.date);
      // The full arrival simulation already checked every actual work span
      // against unassigned/other-tech work and live holds. Comparing its
      // promise to nominal work blocks here would recreate the bug.
      if (s.route_mode === 'arrival_windows') return toMin(s.start_time) >= floorMin ? [s] : [];
      const baseMin = toMin(s.start_time);
      if (baseMin == null) return [];
      const latest = Number.isFinite(s.latest_start_min) ? s.latest_start_min : baseMin;
      for (let m = Math.max(baseMin, Math.ceil(floorMin / step) * step); m <= latest; m += step) {
        const window = { start: toHHMM(m), end: toHHMM(m + spanMin) };
        const clear = conflictsForTarget(
          occupancyByDate.get(s.date), null, s.date, window, { excludeServiceIds: excluded },
        ).length === 0;
        if (clear) return [m === baseMin ? s : { ...s, start_time: window.start, end_time: window.end }];
      }
      return [];
    });
  } catch (guardErr) {
    logger.warn('[find-time] hint occupancy guard failed (fail-open):', guardErr.message);
    guarded = slots.filter((s) => (toMin(s.start_time) ?? 0) >= floorFor(s.date));
  }
  const seenStarts = new Set();
  return guarded.filter((s) => {
    const key = `${s.date}|${s.start_time}`;
    if (seenStarts.has(key)) return false;
    seenStarts.add(key);
    return true;
  }).slice(0, topN);
}

// Hours the engine never enumerates are absent from its list for bounds
// reasons, not route reasons, so they get no verdict: a same-day hour
// before its now+30 lead, an hour before its day open, or a window ending
// after its day close (the arrival simulation runs later than the gap walk).
// The edit picker allows all of these.
function pickedUnscorable({ from, today, pickedMin, pickedEndMin, useArrivalWindows }) {
  const nowEt = etParts();
  const dayEndMin = useArrivalWindows ? ADMIN_DAY_END_MINUTES : DAY_END_HOUR * 60;
  return (from === today && pickedMin < nowEt.hour * 60 + nowEt.minute + 30)
    || pickedMin < DAY_START_HOUR * 60
    || pickedEndMin > dayEndMin;
}

// Arrival-window mode: the arrival simulation answers "unverified" for
// grouped visits, coordless stops, and in-progress routes, and the
// recommendation list simply omits those — so an empty list proves
// nothing. Ask the shared checker (the edit save-probe's) about THIS hour
// and reserve fits:false for a verified miss. It scores the whole route,
// so there is no single insertion leg to name. With no technician
// selected (visit set to Unassigned) the checker would fall back to the
// SAVED technician while the recommendations rank every technician — a
// verdict on a different pool than the chips: no technician, no verdict.
async function pickedByArrivalChecker({ pickedWindow, spanMin, from, serviceId, technicianId, excludeServiceIds }) {
  if (!technicianId) return undefined;
  try {
    const fit = await checkArrivalPlacement({
      serviceId, date: from, technicianId, excludeServiceIds,
      windowStart: pickedWindow.start, windowEnd: pickedWindow.end, durationMinutes: spanMin,
    });
    if (fit.feasible) {
      return {
        start: pickedWindow.start, fits: true, detour_minutes: fit.detourMinutes ?? null,
        drive_in_minutes: null, from_home_base: null, from_name: null, technician: null,
      };
    }
    return fit.reason === 'route_unverified' ? undefined : { start: pickedWindow.start, fits: false };
  } catch (checkErr) {
    logger.warn('[find-time] picked-hour arrival check failed (no verdict):', checkErr.message);
    return undefined;
  }
}

// Gap mode: each engine slot is a route gap (earliest aligned start ..
// latest_start_min, detour constant across it), so the picked window's gap
// is the first ranked slot whose bounds contain it — latest_start_min is
// the last start whose END (start + the searched duration) still clears
// the drive out, so the picked window's end is compared against that same
// ceiling. No gap = the hour doesn't fit that day's route; a gap the
// tech-blind occupancy snapshot vetoes = same answer (fail-open on a
// snapshot error, like the chips guard).
async function pickedByGap({ rawSlots, pickedWindow, pickedMin, pickedEndMin, spanMin, from, excluded }) {
  const gap = rawSlots.find((s) => {
    if (s.date !== from) return false;
    const lo = toMin(s.start_time);
    const hi = Number.isFinite(s.latest_start_min) ? s.latest_start_min : lo;
    return lo != null && lo <= pickedMin && pickedEndMin <= hi + spanMin;
  });
  if (!gap) return { start: pickedWindow.start, fits: false };
  let clear = true;
  try {
    clear = conflictsForTarget(
      await loadOccupancy({ dateFrom: from, dateTo: from }), null, from, pickedWindow, { excludeServiceIds: excluded },
    ).length === 0;
  } catch (guardErr) {
    logger.warn('[find-time] picked-hour occupancy guard failed (fail-open):', guardErr.message);
  }
  if (!clear) return { start: pickedWindow.start, fits: false };
  return {
    start: pickedWindow.start,
    fits: true,
    detour_minutes: gap.detour_minutes ?? null,
    drive_in_minutes: gap.drive_in_minutes ?? null,
    from_home_base: !gap.insertion?.after_stop_id,
    from_name: gap.insertion?.after_name || null,
    technician: gap.technician || null,
  };
}

/**
 * What the hour already in the picker costs on `from`. The edit form's
 * window end is set independently of the service duration, so the scored
 * window is max(end, start + duration) — the same window the live conflict
 * check and the save probe use. Returns undefined when there is nothing
 * honest to say (see pickedUnscorable / the arrival rules above).
 */
async function scorePickedHour({
  rawSlots, from, today, useArrivalWindows, pickedStart, pickedEnd, spanMin,
  serviceId, technicianId, excludeServiceIds, excluded,
}) {
  const pickedMin = toMin(pickedStart);
  const pickedEndMin = Math.max(pickedMin + spanMin, pickedEnd !== undefined ? toMin(pickedEnd) : 0);
  if (pickedUnscorable({ from, today, pickedMin, pickedEndMin, useArrivalWindows })) return undefined;
  const pickedWindow = { start: pickedStart, end: toHHMM(pickedEndMin) };
  return useArrivalWindows
    ? pickedByArrivalChecker({ pickedWindow, spanMin, from, serviceId, technicianId, excludeServiceIds })
    : pickedByGap({ rawSlots, pickedWindow, pickedMin, pickedEndMin, spanMin, from, excluded });
}

module.exports = { validateHintParams, markUnknownDetours, guardHintSlots, scorePickedHour };
