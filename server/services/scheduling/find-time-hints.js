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
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// A date that exists: 2026-09-31 matches the shape and sorts inside a
// September–October range, but names no day.
function realYmd(value) {
  if (typeof value !== 'string' || !YMD.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

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
function validateHintParams({ pickedStart, pickedEnd, sameDayFloorMin, summary, pickedDate }) {
  if (summary !== undefined && typeof summary !== 'boolean') return 'summary must be a boolean';
  if (pickedDate !== undefined && !realYmd(pickedDate)) return 'pickedDate must be a real YYYY-MM-DD date';
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
 * Mirror the dispatch slot-check occupancy guard (tech-blind BY DESIGN —
 * one active field technician, so every overlap is a real clash and every
 * commit gate is tech-blind too; see scheduling/occupancy.js — same overlap
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
 *
 * `every` (summary mode) also answers a second question from the SAME pass —
 * not "the best start in this gap" but "every start that fits": each gap is
 * walked to latest_start_min and every clear start kept, so a free
 * 09:00–12:00 gap lists 09:00, 10:00 and 11:00 for a one-hour visit. The
 * ranked answer is unchanged by it: one start per gap, deduped, sliced.
 */
async function guardHintStarts(slots, { today, sameDayFloorMin, step, spanMin, excluded, topN, every = false }) {
  const floorFor = (date) => (date === today && Number.isInteger(sameDayFloorMin) ? sameDayFloorMin : 0);
  const restart = (s, m) => (m === toMin(s.start_time) ? s : { ...s, start_time: toHHMM(m), end_time: toHHMM(m + spanMin) });
  // A gap's starts at the request's step, from the picker's floor through
  // the last start whose end still clears the drive out. The full arrival
  // simulation already checked every actual work span against unassigned/
  // other-tech work and live holds — comparing its promise to nominal work
  // blocks would recreate the bug — so such a slot is its own single start.
  const gapStarts = (s) => {
    const baseMin = toMin(s.start_time);
    if (baseMin == null) return [];
    if (s.route_mode === 'arrival_windows') return baseMin >= floorFor(s.date) ? [baseMin] : [];
    let latest = Number.isFinite(s.latest_start_min) ? s.latest_start_min : baseMin;
    // A gap ending at an after-hours stop runs past the day's close.
    if (Number.isFinite(s.day_close_min)) latest = Math.min(latest, s.day_close_min - spanMin);
    const starts = [];
    for (let m = Math.max(baseMin, Math.ceil(floorFor(s.date) / step) * step); m <= latest; m += step) starts.push(m);
    return starts;
  };
  // Per gap, in rank order: the starts that survive. Fail-open keeps the
  // engine's own start (minus hours the picker itself would refuse) for the
  // ranked answer, and every start in the gap for the summary.
  let keptPerGap;
  try {
    const occupancyByDate = new Map();
    await Promise.all([...new Set(slots.map((s) => s.date))].map(async (d) => {
      occupancyByDate.set(d, await loadOccupancy({ dateFrom: d, dateTo: d }));
    }));
    const clearAt = (s, m) => s.route_mode === 'arrival_windows' || conflictsForTarget(
      occupancyByDate.get(s.date), null, s.date, { start: toHHMM(m), end: toHHMM(m + spanMin) }, { excludeServiceIds: excluded },
    ).length === 0;
    keptPerGap = slots.map((s) => {
      const kept = [];
      for (const m of gapStarts(s)) {
        if (!clearAt(s, m)) continue;
        kept.push(restart(s, m));
        if (!every) break;
      }
      return kept;
    });
  } catch (guardErr) {
    logger.warn('[find-time] hint occupancy guard failed (fail-open):', guardErr.message);
    keptPerGap = slots.map((s) => {
      if (every) return gapStarts(s).map((m) => restart(s, m));
      return (toMin(s.start_time) ?? 0) >= floorFor(s.date) ? [s] : [];
    });
  }
  const dedupe = (list) => {
    const seenStarts = new Set();
    return list.filter((s) => {
      const key = `${s.date}|${s.start_time}`;
      if (seenStarts.has(key)) return false;
      seenStarts.add(key);
      return true;
    });
  };
  return {
    ranked: dedupe(keptPerGap.flatMap((kept) => kept.slice(0, 1))).slice(0, topN),
    every: every ? dedupe(keptPerGap.flat()) : null,
  };
}

// Hours the engine never enumerates are absent from its list for bounds
// reasons, not route reasons, so they get no verdict: a same-day hour
// before its now+30 lead, an hour before its day open, or a window ending
// after its day close (the arrival simulation runs later than the gap walk).
// The edit picker allows all of these. An off-hour start (09:15 typed into
// the edit form's free time input) is also never enumerated, and the save
// validator refuses it outright (window-rules: appointment windows start on
// the hour), so a verdict on it could endorse a window that cannot be saved
// (Codex #4120 r4 P1). The window END may land off-hour and is never
// rejected — only the start is checked. A caller's own same-day floor
// (Quick Move running-late: the target must follow the current window) is
// the same kind of bound — the picker marks an earlier hour invalid, so no
// verdict may call it a fit (Codex #4120 r5 P2).
function pickedUnscorable({ from, today, sameDayFloorMin, pickedMin, pickedEndMin, useArrivalWindows }) {
  const nowEt = etParts();
  const { capacityEnabled, SHIFT } = require('./policy');
  const dayEndMin = capacityEnabled() ? SHIFT.endMinutes : (useArrivalWindows ? ADMIN_DAY_END_MINUTES : DAY_END_HOUR * 60);
  // Real (start, end) admission only — no flat headroom margin. A
  // `pickedMin + SHIFT.arrivalMinutes (120) > SHIFT.endMinutes` check lived
  // here (mirroring policy.js's placementFitsShift before Codex r1 P1 on
  // #4663 removed it there) — the recommendation list already dropped the
  // same margin, so a picker offering 17:00 for a 60-minute job (ending
  // exactly at the 18:00 close) returned NO VERDICT the moment the operator
  // actually picked it, an offer/verdict break identical to the one r1
  // fixed for offer/commit. `pickedEndMin > dayEndMin` below already
  // enforces the real close. Codex r4 P2 on #4663.
  return pickedMin % 60 !== 0
    || (from === today && pickedMin < nowEt.hour * 60 + nowEt.minute + 30)
    || (from === today && Number.isInteger(sameDayFloorMin) && pickedMin < sameDayFloorMin)
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
// `changes` is the caller's pending edit (duration, re-picked address);
// the picked window joins it so the checker's context is the row the save
// would write — the save probe passes `changes: updates` the same way, and
// derives the work span from THAT window, not the stored one (r7 P2).
async function pickedByArrivalChecker({ pickedWindow, spanMin, from, serviceId, technicianId, excludeServiceIds, changes, withReason }) {
  // Summary mode names WHY there is no verdict, so the strip can say
  // "can't check this day" instead of going silent; the three-line hint
  // keeps its no-verdict contract (undefined).
  const noVerdict = (reason) => (withReason ? { start: pickedWindow.start, fits: null, reason } : undefined);
  if (!technicianId) return noVerdict('no_technician');
  try {
    const fit = await checkArrivalPlacement({
      serviceId, date: from, technicianId, excludeServiceIds,
      changes: { ...changes, window_start: pickedWindow.start, window_end: pickedWindow.end },
      windowStart: pickedWindow.start, windowEnd: pickedWindow.end, durationMinutes: spanMin,
    });
    if (fit.feasible) {
      return {
        start: pickedWindow.start, fits: true, detour_minutes: fit.detourMinutes ?? null,
        drive_in_minutes: null, from_home_base: null, from_name: null, technician: null,
      };
    }
    if (fit.reason === 'route_unverified') return noVerdict('route_unverified');
    return { start: pickedWindow.start, fits: false, ...(withReason ? { reason: fit.reason || 'arrival_window' } : {}) };
  } catch (checkErr) {
    logger.warn('[find-time] picked-hour arrival check failed (no verdict):', checkErr.message);
    return noVerdict('route_unverified');
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
async function pickedByGap({ rawSlots, pickedWindow, pickedMin, pickedEndMin, spanMin, from, excluded, withReason }) {
  const miss = (reason) => ({ start: pickedWindow.start, fits: false, ...(withReason ? { reason } : {}) });
  const gap = rawSlots.find((s) => {
    if (s.date !== from) return false;
    const lo = toMin(s.start_time);
    const hi = Number.isFinite(s.latest_start_min) ? s.latest_start_min : lo;
    return lo != null && lo <= pickedMin && pickedEndMin <= hi + spanMin;
  });
  if (!gap) return miss('no_gap');
  let clear = true;
  try {
    clear = conflictsForTarget(
      await loadOccupancy({ dateFrom: from, dateTo: from }), null, from, pickedWindow, { excludeServiceIds: excluded },
    ).length === 0;
  } catch (guardErr) {
    logger.warn('[find-time] picked-hour occupancy guard failed (fail-open):', guardErr.message);
  }
  if (!clear) return miss('occupied');
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
 * check and the save probe use. An explicit end at or before the start is
 * an inverted window the save rejects outright — no verdict may normalize
 * it into a fit (Codex #4120 r6 P2). Returns undefined when there is
 * nothing honest to say (see pickedUnscorable / the arrival rules above).
 */
async function scorePickedHour({
  rawSlots, from, today, sameDayFloorMin, useArrivalWindows, pickedStart, pickedEnd, spanMin,
  serviceId, technicianId, excludeServiceIds, excluded, changes, withReason = false,
}) {
  const pickedMin = toMin(pickedStart);
  // `withReason` (summary mode): an hour no verdict can cover still gets a
  // reason — fits stays null, never false, so no surface reads it as a miss.
  const uncheckable = withReason ? { start: pickedStart, fits: null, reason: 'not_checkable' } : undefined;
  if (pickedEnd !== undefined && toMin(pickedEnd) <= pickedMin) return uncheckable;
  const pickedEndMin = Math.max(pickedMin + spanMin, pickedEnd !== undefined ? toMin(pickedEnd) : 0);
  if (pickedUnscorable({ from, today, sameDayFloorMin, pickedMin, pickedEndMin, useArrivalWindows })) return uncheckable;
  const pickedWindow = { start: pickedStart, end: toHHMM(pickedEndMin) };
  return useArrivalWindows
    ? pickedByArrivalChecker({ pickedWindow, spanMin, from, serviceId, technicianId, excludeServiceIds, changes, withReason })
    : pickedByGap({ rawSlots, pickedWindow, pickedMin, pickedEndMin, spanMin, from, excluded, withReason });
}

// Summary mode (GATE_RESCHEDULE_AVAILABILITY): the availability strip shows
// a run of days around the picked one, so the search is bounded here rather
// than by the 90-day ceiling the ranged Find-a-Time button gets.
const SUMMARY_MAX_DAYS = 14;

function nextYmd(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * What one find-time request searches, for every caller: the range, the date
 * the picked hour's verdict is scored on, and the start step. The plain hint
 * and the ranged button get back exactly what they asked for. A summary
 * request (hint + summary:true + the gate) is narrowed three ways:
 *   - it starts today at the earliest — the gap engine still walks past
 *     dates, and a past hour must not be ranked, listed or called a fit;
 *   - it covers at most SUMMARY_MAX_DAYS, so a debounced picker hint cannot
 *     become a 90-day full enumeration;
 *   - it is hourly whatever step was sent: the summary lists EVERY start in
 *     a gap, and the save refuses a window that does not start on the hour.
 * Throws a 400 for a range or picked date a summary cannot answer.
 */
function summaryRequestError(message) {
  const err = new Error(message);
  err.status = 400;
  err.statusCode = 400;
  err.isOperational = true;
  return err;
}

function hintSearchPlan({ hint, summary, summaryEnabled, from, to, maxTo, today, pickedStart, pickedDate, slotStepMinutes }) {
  const step = slotStepMinutes !== undefined ? Number(slotStepMinutes) : undefined;
  if (!(hint && summary === true && summaryEnabled)) {
    return { summary: false, from, to: maxTo && to > maxTo ? maxTo : to, verdictDate: from, step };
  }
  // The legacy ceiling (maxTo) is measured from the asked `from`; a summary
  // caps its own length from the today-clamped start instead, so a long-
  // overdue dateFrom still searches the days ahead.
  const start = from < today ? today : from;
  if (to < start) throw summaryRequestError('a summary search cannot end before today');
  const end = summaryRangeEnd(start, to);
  // A summary search starts days before the pick, so the pick names its date
  // (documented default: dateFrom, not the clamped start — a past pick is
  // out of range, never scored against today's route). With no picked hour
  // there is no verdict to place.
  if (!pickedStart) return { summary: true, from: start, to: end, verdictDate: start, step: 60 };
  const verdictDate = pickedDate !== undefined ? pickedDate : from;
  if (verdictDate < start || verdictDate > end) throw summaryRequestError('pickedDate must be inside the searched range');
  return { summary: true, from: start, to: end, verdictDate, step: 60 };
}

/** Last date a summary search may cover: `from` + SUMMARY_MAX_DAYS - 1. */
function summaryRangeEnd(from, to) {
  let last = from;
  for (let i = 1; i < SUMMARY_MAX_DAYS && last < to; i++) last = nextYmd(last);
  return last;
}

// Why a day has no hour to offer. The capacity engine counts each refused
// candidate by reason per date; a day where the ONLY reason is an
// unverifiable route (in progress, coordless stop) was never checked, which
// is a different statement from "nothing fits". Engines that report no
// reasons (gap mode, the pre-capacity arrival finder) leave it at 'full'.
function emptyDayStatus(reasons) {
  const keys = Object.keys(reasons || {}).filter((key) => reasons[key] > 0);
  if (!keys.length) return 'full';
  if (keys.every((key) => key === 'route_unverified')) return 'unverified';
  if (keys.includes('day_overcommitted')) return 'overcommitted';
  return 'full';
}

/**
 * The guarded slot list as one row per date in [from, to] — every date is
 * present, including the ones with nothing to offer, so the strip can say
 * "full" rather than leave a hole. `slots` is guardHintStarts' `every` list:
 * with no topN cap: already vetted against occupancy and the same-day floor
 * and deduped by day + start (best-ranked technician wins). Hours are in
 * clock order; ranking by added drive is the consumer's call.
 */
function summarizeHintDays(slots, { from, to, rejectionsByDate, closedDates, offDates }) {
  const byDate = new Map();
  for (let date = from; date <= to; date = nextYmd(date)) byDate.set(date, []);
  for (const slot of slots) {
    const hours = byDate.get(slot.date);
    if (!hours) continue;
    hours.push({
      start_time: slot.start_time,
      end_time: slot.end_time,
      detour_minutes: slot.detour_minutes ?? null,
      estimated_arrival: slot.estimated_arrival || null,
      stops_that_day: slot.stops_that_day ?? null,
      technician: slot.technician ? { id: slot.technician.id, name: slot.technician.name } : null,
    });
  }
  return [...byDate].map(([date, hours]) => ({
    date,
    // 'off' = the searched technician is marked absent (the engine skips the
    // day before any candidate, so it would otherwise read as 'full').
    status: hours.length ? 'open' : (offDates?.has(date) ? 'off' : emptyDayStatus(rejectionsByDate?.[date])),
    // A day the business does not normally work. Staff may still book it,
    // so its hours stay listed; the strip labels it and never offers it as
    // the "closest" alternative.
    ...(closedDates?.has(date) ? { closed: true } : {}),
    hours: hours.sort((a, b) => a.start_time.localeCompare(b.start_time)),
  }));
}

/**
 * What the calendar says about each summary day, beyond the route: closed
 * days (owner blackout dates, weekly days off, and Sundays — the day every
 * customer surface skips) and, for a search scoped to one technician, that
 * technician's absences. Advisory labels only: any lookup failure leaves the
 * set empty and the summary answers as before.
 */
async function loadSummaryDayFacts(plan, technicianId) {
  const closedDates = new Set();
  const offDates = new Set();
  if (!plan.summary) return { closedDates, offDates };
  for (let date = plan.from; date <= plan.to; date = nextYmd(date)) {
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 0) closedDates.add(date);
  }
  try {
    const { getBlackoutDates } = require('./blackout-dates');
    for (const date of await getBlackoutDates(plan.from, plan.to)) closedDates.add(date);
  } catch (err) {
    logger.warn(`[find-time] summary blackout lookup failed (no closed labels): ${err.message}`);
  }
  if (technicianId) {
    try {
      const { absentTechDays } = require('../technician-eligibility');
      const absent = await absentTechDays(require('../../models/db'), {
        dateFrom: plan.from, dateTo: plan.to, technicianIds: [technicianId],
      });
      for (const key of absent) offDates.add(String(key).slice(String(key).lastIndexOf(':') + 1));
    } catch (err) {
      logger.warn(`[find-time] summary absence lookup failed (no off labels): ${err.message}`);
    }
  }
  return { closedDates, offDates };
}

// Budget for the strip's eleven days (the plain hint's range search covers
// four). Logged so the first week of use says whether the range must shrink.
const SUMMARY_SLOW_MS = 1500;

/** The response's `summary` for a summary plan; undefined for any other. */
function buildHintSummary(plan, everyStart, { rejectionsByDate, startedAt, closedDates, offDates }) {
  if (!plan.summary) return undefined;
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > SUMMARY_SLOW_MS) {
    logger.warn(`[find-time] summary search slow: ${elapsedMs}ms for ${plan.from}..${plan.to}`);
  }
  return {
    days: summarizeHintDays(everyStart || [], { from: plan.from, to: plan.to, rejectionsByDate, closedDates, offDates }),
    elapsed_ms: elapsedMs,
  };
}

module.exports = {
  validateHintParams, markUnknownDetours, guardHintStarts, scorePickedHour,
  hintSearchPlan, buildHintSummary, summarizeHintDays, summaryRangeEnd, SUMMARY_MAX_DAYS, loadSummaryDayFacts,
};
