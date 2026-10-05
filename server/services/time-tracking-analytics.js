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
      techs.set(id, {
        row: { technician_id: id, tech_name: name ?? null, budget_minutes: 0, job_minutes: 0, shift_minutes: 0, jobs: 0, jobs_with_budget: 0 },
        seenJobs: new Set(),
        budgetedJobs: new Set(),
      });
    }
    const t = techs.get(id);
    if (t.row.tech_name == null && name != null) t.row.tech_name = name;
    return t;
  };
  for (const entry of entryRows) {
    const t = get(entry.technician_id, entry.tech_name);
    // A stop worked in two segments (stop, then restart) is two time_entries
    // rows on ONE job_id: it is one job with one budget, and both segments'
    // minutes. An entry with no job_id is its own job.
    const jobKey = entry.job_id != null ? `job:${entry.job_id}` : null;
    if (jobKey == null || !t.seenJobs.has(jobKey)) {
      t.row.jobs += 1;
      if (jobKey) t.seenJobs.add(jobKey);
    }
    const planned = entryPlanned(entry);
    if (planned == null) continue;
    t.row.job_minutes += num(entry.duration_minutes);
    if (jobKey == null || !t.budgetedJobs.has(jobKey)) {
      if (jobKey) t.budgetedJobs.add(jobKey);
      t.row.jobs_with_budget += 1;
      t.row.budget_minutes += planned;
    }
  }
  for (const shift of shiftRows) {
    get(shift.technician_id, shift.tech_name).row.shift_minutes += num(shift.total_shift);
  }
  return [...techs.values()]
    .map(({ row }) => ({ ...row, shift_minutes: round1(row.shift_minutes), efficiency_pct: efficiencyPct(row.budget_minutes, row.shift_minutes) }))
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
    avg_job_minutes_per_week: n ? Math.round(sum('job') / n) : null,
    avg_shift_minutes_per_week: n ? Math.round(sum('shift') / n) : null,
  };
}

module.exports = {
  EFFICIENCY_BANDS,
  LOAD_AHEAD_WEEKS,
  TRAILING_WEEKS,
  plannedMinutes,
  efficiencyPct,
  efficiencyBand,
  buildServiceTypeStats,
  buildComparison,
  buildEfficiencyByTech,
  buildLiveShiftRows,
  loadAheadWeekStarts,
  buildLoadAhead,
  buildTrailing,
};
