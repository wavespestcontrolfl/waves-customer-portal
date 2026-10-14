/**
 * Time Tracking analytics math, kept out of the route so it is testable
 * without Express or a database.
 *
 * Planned minutes for a scheduled_services row come from workDuration in
 * route-reorder-window-fit.js, the one place the planners read "how long is
 * this stop expected to take" (owner planning minutes under
 * GATE_SCHEDULING_CAPACITY, else window span / estimated_duration_minutes /
 * 60). The old analytics queries selected scheduled_services.estimated_duration,
 * a column scheduled_services does not have, and the route answered 500.
 */
const { workDuration } = require('./route-reorder-window-fit');
const { etWeekStart, etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

// Mike Andes' bands for budgeted minutes divided by clocked shift minutes.
// Lower bound inclusive: 50 is weak, 70 is normal, 90 is elite.
const EFFICIENCY_BANDS = Object.freeze([
  Object.freeze({ key: 'broken', label: 'Broken', min: 0, max: 50 }),
  Object.freeze({ key: 'weak', label: 'Weak', min: 50, max: 70 }),
  Object.freeze({ key: 'normal', label: 'Normal', min: 70, max: 90 }),
  Object.freeze({ key: 'elite', label: 'Elite', min: 90, max: null }),
]);

const LOAD_AHEAD_WEEKS = 3;
const TRAILING_WEEKS = 4;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round1 = (n) => Math.round(n * 10) / 10;

/** Planned minutes for one scheduled_services-shaped row. */
function plannedMinutes(row) {
  return workDuration({
    service_type: row.service_type,
    is_recurring: row.is_recurring,
    is_callback: row.is_callback,
    window_start: row.window_start,
    window_end: row.window_end,
    estimated_duration_minutes: row.estimated_duration_minutes,
  });
}

/** budget / shift * 100, one decimal. Null when either side is 0. */
function efficiencyPct(budgetMinutes, shiftMinutes) {
  const budget = num(budgetMinutes);
  const shift = num(shiftMinutes);
  if (!(shift > 0) || !(budget > 0)) return null;
  return round1((budget / shift) * 100);
}

function efficiencyBand(pct) {
  if (pct == null) return null;
  return EFFICIENCY_BANDS.find((b) => pct >= b.min && (b.max == null || pct < b.max)).key;
}

// Entry rows come from time_entries LEFT JOIN scheduled_services with the
// scheduled_services columns aliased ss_*. ss_id is null when the entry has
// no linked scheduled row.
// A grouped visit (visit_id) runs on ONE timer whose job_id is the primary
// member, so the budget is the whole visit's on-site minutes
// (ss_group_minutes, resolved by the route from every live member with
// day-quality's coVisitOnSiteMinutes), not the primary member's alone.
function entryPlanned(row) {
  if (row.ss_id == null) return null;
  if (row.ss_group_minutes != null) return num(row.ss_group_minutes);
  return plannedMinutes({
    service_type: row.ss_service_type,
    is_recurring: row.ss_is_recurring,
    is_callback: row.ss_is_callback,
    window_start: row.ss_window_start,
    window_end: row.ss_window_end,
    estimated_duration_minutes: row.ss_estimated_duration_minutes,
  });
}

const svcTypeOf = (row) => row.service_type || row.ss_service_type || 'Unknown';

/**
 * THE one place timer rows become physical stops. Every table on the tab
 * (actual vs estimated, the per-tech comparison, efficiency) reads these, so
 * none can count a stop differently from another.
 *
 * One stop per technician + grouped visit (visit_id), else per technician +
 * scheduled row (job_id); an entry with no job_id is its own stop. A stop
 * the technician paused and restarted, or timed on two members of one visit,
 * is ONE stop: its segments' minutes are summed and its planned minutes are
 * counted once.
 *
 * Returns { technician_id, tech_name, svc_type, actual_minutes,
 * planned_minutes (null when unlinked), linked, segments }.
 */
function collapseEntriesToStops(entryRows) {
  const stops = new Map();
  let unlinked = 0;
  for (const row of entryRows) {
    let stopKey;
    if (row.ss_visit_id != null) stopKey = `visit:${row.ss_visit_id}`;
    else if (row.job_id != null) stopKey = `job:${row.job_id}`;
    else { unlinked += 1; stopKey = `unlinked:${unlinked}`; }
    const key = `${row.technician_id}\u0000${stopKey}`;
    let stop = stops.get(key);
    if (!stop) {
      stop = {
        technician_id: row.technician_id,
        tech_name: row.tech_name ?? null,
        svc_type: svcTypeOf(row),
        actual_minutes: 0,
        planned_minutes: null,
        linked: row.job_id != null,
        segments: 0,
      };
      stops.set(key, stop);
    }
    if (stop.tech_name == null && row.tech_name != null) stop.tech_name = row.tech_name;
    stop.actual_minutes += num(row.duration_minutes);
    stop.segments += 1;
    if (stop.planned_minutes == null) stop.planned_minutes = entryPlanned(row);
  }
  return [...stops.values()];
}

/** avg_actual / job_count / avg_estimated over STOPS. avg_estimated averages
 *  only stops that carry a plan, null when none do. */
function groupStopStats(stops, keyFn, extra) {
  const groups = new Map();
  for (const stop of stops) {
    const key = keyFn(stop);
    let g = groups.get(key);
    if (!g) {
      g = { ...extra(stop), svc_type: stop.svc_type, actual: 0, count: 0, est: 0, estCount: 0 };
      groups.set(key, g);
    }
    g.actual += stop.actual_minutes;
    g.count += 1;
    if (stop.planned_minutes != null) { g.est += stop.planned_minutes; g.estCount += 1; }
  }
  return [...groups.values()].map(({ actual, count, est, estCount, ...rest }) => ({
    ...rest,
    avg_actual: count ? actual / count : null,
    job_count: count,
    avg_estimated: estCount ? est / estCount : null,
  }));
}

/** By service type, over stops linked to a scheduled row (the plan side
 *  needs one). */
function buildServiceTypeStats(stops) {
  return groupStopStats(stops.filter((stop) => stop.linked), (stop) => stop.svc_type, () => ({}))
    .sort((a, b) => (a.svc_type < b.svc_type ? -1 : a.svc_type > b.svc_type ? 1 : 0));
}

/** By technician and service type, over every stop (unlinked ones show with
 *  a null estimate, as before). */
function buildComparison(stops) {
  const out = groupStopStats(
    stops,
    (stop) => `${stop.technician_id}\u0000${stop.svc_type}`,
    (stop) => ({ tech_name: stop.tech_name, technician_id: stop.technician_id }),
  );
  // ORDER BY technicians.name, svc_type: Postgres puts NULL names last.
  return out.sort((a, b) => {
    if (a.tech_name !== b.tech_name) {
      if (a.tech_name == null) return 1;
      if (b.tech_name == null) return -1;
      return a.tech_name < b.tech_name ? -1 : 1;
    }
    return a.svc_type < b.svc_type ? -1 : a.svc_type > b.svc_type ? 1 : 0;
  });
}

/**
 * Per technician: budget (planned minutes of the stops done) over the
 * clocked shift. `jobs` counts EVERY stop, linked or not, so
 * `jobs_with_budget` shows real coverage. shiftRows: { technician_id,
 * tech_name, total_shift }.
 */
function buildEfficiencyByTech(stops, shiftRows) {
  const techs = new Map();
  const get = (id, name) => {
    if (!techs.has(id)) {
      techs.set(id, { technician_id: id, tech_name: name ?? null, budget_minutes: 0, job_minutes: 0, shift_minutes: 0, jobs: 0, jobs_with_budget: 0 });
    }
    const t = techs.get(id);
    if (t.tech_name == null && name != null) t.tech_name = name;
    return t;
  };
  for (const stop of stops) {
    const t = get(stop.technician_id, stop.tech_name);
    t.jobs += 1;
    if (stop.planned_minutes == null) continue;
    t.jobs_with_budget += 1;
    t.budget_minutes += stop.planned_minutes;
    t.job_minutes += stop.actual_minutes;
  }
  for (const shift of shiftRows) {
    get(shift.technician_id, shift.tech_name).shift_minutes += num(shift.total_shift);
  }
  return [...techs.values()]
    .map((t) => ({ ...t, shift_minutes: round1(t.shift_minutes), efficiency_pct: efficiencyPct(t.budget_minutes, t.shift_minutes) }))
    .sort((x, y) => {
      if (x.tech_name == null) return 1;
      if (y.tech_name == null) return -1;
      return x.tech_name < y.tech_name ? -1 : x.tech_name > y.tech_name ? 1 : 0;
    });
}

/**
 * Live shift minutes per technician from shift time_entries rows
 * (technician_id, tech_name, duration_minutes, clock_in, status). A shift
 * still open has no duration yet, so it counts from clock_in to now: today's
 * finished jobs must never sit over a denominator that is missing today's
 * shift (the daily summary is only written at clock-out or overnight).
 */
function buildLiveShiftRows(shiftEntries, now = new Date()) {
  const byTech = new Map();
  for (const e of shiftEntries) {
    let minutes = e.duration_minutes != null ? num(e.duration_minutes) : null;
    if (minutes == null) {
      const start = e.clock_in ? new Date(e.clock_in).getTime() : NaN;
      minutes = Number.isFinite(start) ? Math.max(0, (now.getTime() - start) / 60000) : 0;
    }
    const t = byTech.get(e.technician_id) || { technician_id: e.technician_id, tech_name: e.tech_name ?? null, total_shift: 0 };
    t.total_shift += minutes;
    byTech.set(e.technician_id, t);
  }
  return [...byTech.values()];
}

/**
 * Stamp ss_group_minutes onto entry rows from Map(visit_id -> minutes).
 * Rows with no visit_id, or a visit with no resolved members, are left alone
 * and keep their own row's planned minutes.
 */
function applyVisitGroupMinutes(entryRows, minutesByVisit) {
  for (const row of entryRows) {
    if (row.ss_visit_id == null) continue;
    const minutes = minutesByVisit.get(row.ss_visit_id);
    if (minutes != null && minutes > 0) row.ss_group_minutes = minutes;
  }
  return entryRows;
}

/** The next LOAD_AHEAD_WEEKS ET Monday date strings, starting with this week. */
function loadAheadWeekStarts(now = new Date()) {
  const first = etWeekStart(now);
  const anchor = parseETDateTime(`${first}T12:00`);
  return Array.from({ length: LOAD_AHEAD_WEEKS }, (_, i) => etDateString(addETDays(anchor, i * 7)));
}

/** Monday of the ET week holding a YYYY-MM-DD date. */
function weekStartOf(dateStr) {
  return etWeekStart(parseETDateTime(`${String(dateStr).slice(0, 10)}T12:00`));
}

/**
 * Weeks from the scheduler's own day-quality measurement
 * (scheduling/day-quality.js getScheduleQualityMeasurements with
 * includeStopExtras): physical stops and co-visit-aware on-site minutes per
 * technician-day, plus the day's unallocated visits. A grouped visit or a
 * same-property pair is ONE stop with its shared time, exactly as the route
 * scorecard counts it. technicianId narrows to that technician's rows and
 * drops the unallocated work (it belongs to nobody yet).
 */
function buildLoadAhead(days, now = new Date(), { technicianId = null } = {}) {
  const starts = loadAheadWeekStarts(now);
  const weeks = starts.map((week_start) => ({ week_start, stops: 0, planned_minutes: 0 }));
  const byStart = new Map(weeks.map((w) => [w.week_start, w]));
  for (const day of days || []) {
    const w = byStart.get(weekStartOf(day.date));
    if (!w) continue;
    for (const tech of day.byTech || []) {
      if (technicianId && tech.technicianId !== technicianId) continue;
      w.stops += num(tech.physicalStops);
      w.planned_minutes += num(tech.coVisitOnSiteMinutes);
    }
    if (!technicianId) {
      w.stops += num(day.unallocatedVisits);
      w.planned_minutes += num(day.unallocatedServiceMinutes);
    }
  }
  return weeks;
}

/** Last TRAILING_WEEKS of time_weekly_summary: average clocked job and shift
 *  minutes per week (summed over techs per week, averaged over weeks seen). */
function buildTrailing(weeklyRows) {
  const byWeek = new Map();
  for (const r of weeklyRows) {
    const key = String(r.week_start).slice(0, 10);
    const w = byWeek.get(key) || { job: 0, shift: 0 };
    w.job += num(r.total_job_minutes);
    w.shift += num(r.total_shift_minutes);
    byWeek.set(key, w);
  }
  const n = byWeek.size;
  const sum = (k) => [...byWeek.values()].reduce((s, w) => s + w[k], 0);
  return {
    weeks: TRAILING_WEEKS,
    weeks_with_data: n,
    // Over the full TRAILING_WEEKS calendar weeks: a week nobody clocked (a
    // closure) is a zero week, not a missing one, or the average overstates
    // a normal week. Null only when there is no data at all.
    avg_job_minutes_per_week: n ? Math.round(sum('job') / TRAILING_WEEKS) : null,
    avg_shift_minutes_per_week: n ? Math.round(sum('shift') / TRAILING_WEEKS) : null,
  };
}

module.exports = {
  EFFICIENCY_BANDS,
  LOAD_AHEAD_WEEKS,
  TRAILING_WEEKS,
  plannedMinutes,
  efficiencyPct,
  efficiencyBand,
  collapseEntriesToStops,
  buildServiceTypeStats,
  buildComparison,
  buildEfficiencyByTech,
  buildLiveShiftRows,
  applyVisitGroupMinutes,
  loadAheadWeekStarts,
  buildLoadAhead,
  buildTrailing,
};
