/**
 * Time Tracking analytics math, kept out of the route so it is testable
 * without Express or a database.
 *
 * Planned minutes for a scheduled_services row come from workDuration in
 * route-reorder-window-fit.js, the one place the planners read "how long is
 * this stop expected to take" (owner planning minutes under
 * GATE_SCHEDULING_CAPACITY, else window span / estimated_duration_minutes /
 * 60). The old analytics queries selected scheduled_services.estimated_duration,
 * a column that only exists on dispatch_jobs, and the route answered 500.
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

// Scheduled rows that are still going to happen. Same exclusion list the
// reorder pass uses (route-reorder.js EXCLUDE_STATUSES) minus en_route and
// on_site: those stops are in progress, not finished.
const NOT_BOOKED_STATUSES = Object.freeze(['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show']);

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
function entryPlanned(row) {
  if (row.ss_id == null) return null;
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

/** avg_actual / job_count / avg_estimated groups. avg_estimated averages only
 *  entries that link to a scheduled row, null when none do. */
function groupEntryStats(rows, keyFn, extra) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    let g = groups.get(key);
    if (!g) {
      g = { ...extra(row), svc_type: svcTypeOf(row), actual: 0, count: 0, est: 0, estCount: 0 };
      groups.set(key, g);
    }
    g.actual += num(row.duration_minutes);
    g.count += 1;
    const planned = entryPlanned(row);
    if (planned != null) { g.est += planned; g.estCount += 1; }
  }
  return [...groups.values()].map(({ actual, count, est, estCount, ...rest }) => ({
    ...rest,
    avg_actual: count ? actual / count : null,
    job_count: count,
    avg_estimated: estCount ? est / estCount : null,
  }));
}

function buildServiceTypeStats(rows) {
  return groupEntryStats(rows, svcTypeOf, () => ({}))
    .sort((a, b) => (a.svc_type < b.svc_type ? -1 : a.svc_type > b.svc_type ? 1 : 0));
}

function buildComparison(rows) {
  const out = groupEntryStats(
    rows,
    (r) => `${r.technician_id}\u0000${svcTypeOf(r)}`,
    (r) => ({ tech_name: r.tech_name ?? null, technician_id: r.technician_id }),
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
 * Per technician: budget (planned minutes of the linked, non-voided job
 * entries) over the clocked shift. shiftRows are the utilizationByTech rows
 * (technician_id, tech_name, total_shift).
 */
function buildEfficiencyByTech(entryRows, shiftRows) {
  const techs = new Map();
  const get = (id, name) => {
    if (!techs.has(id)) {
      techs.set(id, { technician_id: id, tech_name: name ?? null, budget_minutes: 0, job_minutes: 0, shift_minutes: 0, jobs: 0, jobs_with_budget: 0 });
    }
    const t = techs.get(id);
    if (t.tech_name == null && name != null) t.tech_name = name;
    return t;
  };
  for (const row of entryRows) {
    const t = get(row.technician_id, row.tech_name);
    t.jobs += 1;
    const planned = entryPlanned(row);
    if (planned != null) {
      t.jobs_with_budget += 1;
      t.budget_minutes += planned;
      t.job_minutes += num(row.duration_minutes);
    }
  }
  for (const row of shiftRows) {
    get(row.technician_id, row.tech_name).shift_minutes += num(row.total_shift);
  }
  return [...techs.values()]
    .map((t) => ({ ...t, efficiency_pct: efficiencyPct(t.budget_minutes, t.shift_minutes) }))
    .sort((a, b) => {
      if (a.tech_name == null) return 1;
      if (b.tech_name == null) return -1;
      return a.tech_name < b.tech_name ? -1 : a.tech_name > b.tech_name ? 1 : 0;
    });
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

/** rows carry sched_day (YYYY-MM-DD) plus the columns workDuration reads. */
function buildLoadAhead(rows, now = new Date()) {
  const starts = loadAheadWeekStarts(now);
  const weeks = starts.map((week_start) => ({ week_start, stops: 0, planned_minutes: 0 }));
  const byStart = new Map(weeks.map((w) => [w.week_start, w]));
  for (const row of rows) {
    const w = byStart.get(weekStartOf(row.sched_day));
    if (!w) continue;
    w.stops += 1;
    w.planned_minutes += plannedMinutes(row);
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
    avg_job_minutes_per_week: n ? Math.round(sum('job') / n) : null,
    avg_shift_minutes_per_week: n ? Math.round(sum('shift') / n) : null,
  };
}

module.exports = {
  EFFICIENCY_BANDS,
  NOT_BOOKED_STATUSES,
  LOAD_AHEAD_WEEKS,
  TRAILING_WEEKS,
  plannedMinutes,
  efficiencyPct,
  efficiencyBand,
  buildServiceTypeStats,
  buildComparison,
  buildEfficiencyByTech,
  loadAheadWeekStarts,
  buildLoadAhead,
  buildTrailing,
};
