/**
 * Route engine summary (GATE_ROUTE_ENGINE_SUMMARY): what the nightly
 * auto-dispatch run did over the last few ET nights. Read-only; one block on
 * the admin Day Scorecard payload. Nothing here writes or sends.
 *
 *   summarizeRouteEngine({ runs, rows, today, nights })  pure, no DB
 *   buildRouteEngineSummary(conn, { nights, now })       reads, then summarizes
 *
 * runs: auto_dispatch_runs rows (id, started_at, status, config_snapshot) for
 *   the night triggers ('cron', 'catch_up').
 * rows: auto_dispatch_audit_logs rows (auto_dispatch_run_id,
 *   scheduled_service_id, action, reason_code, route_metrics_snapshot,
 *   created_at).
 *
 * estDriveMinutesSaved is the model's own NET estimate (route_metrics_snapshot.
 * drive_saving_minutes on each applied move, summed with its sign: a move that
 * adds driving, e.g. an overlap fix, subtracts), not measured driving.
 */
const defaultDb = require('../../models/db');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { NIGHT_TRIGGERS } = require('../auto-dispatch/catch-up');

const DEFAULT_NIGHTS = 7;
const HELD_CODE = 'MAX_CHANGES_REACHED';
// Best status per night, lowest to highest: a finished run beats one still
// running, which beats one with errors, which beats a failed one.
const STATUS_BY_RANK = ['no_run', 'failed', 'with_errors', 'running', 'finished'];

function windowDates(today, nights) {
  const anchor = parseETDateTime(`${today}T12:00`);
  const dates = [];
  for (let i = nights - 1; i >= 0; i -= 1) dates.push(etDateString(addETDays(anchor, -i)));
  return dates;
}

// 'running' is a run still in progress (the nightly run, or its catch-up),
// never a failure: a run that dies is marked 'failed' by the stale-run sweep.
function runRank(status) {
  if (status === 'completed') return 4;
  if (status === 'running') return 3;
  if (status === 'completed_with_errors') return 2;
  return 1;
}

function asObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

function timeOf(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// Earliest / latest ET night (YYYY-MM-DD strings sort as dates).
function earlier(a, b) { return a === undefined || b < a ? b : a; }
function later(a, b) { return a === undefined || b > a ? b : a; }

// Best run status per ET night (see STATUS_BY_RANK). Also maps each run id to
// its night.
function indexRuns(runs, dates) {
  const best = new Map(dates.map((date) => [date, 0]));
  const nightOfRun = new Map();
  for (const run of runs) {
    const date = etDateString(new Date(run.started_at));
    if (!best.has(date)) continue;
    nightOfRun.set(String(run.id), date);
    best.set(date, Math.max(best.get(date), runRank(run.status)));
  }
  return { best, nightOfRun };
}

function capFrom(runs, nightOfRun) {
  const inWindow = runs.filter((run) => nightOfRun.has(String(run.id)));
  if (!inWindow.length) return null;
  const latest = inWindow.reduce((a, b) => (timeOf(b.started_at) > timeOf(a.started_at) ? b : a));
  const cap = Number(asObject(latest.config_snapshot).maxChangesPerRun);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

function savingMinutes(row) {
  const n = Number(asObject(row.route_metrics_snapshot).drive_saving_minutes);
  return Number.isFinite(n) ? n : null;
}

function tallyRows(rows, nightOfRun, dates) {
  const moves = new Map(dates.map((date) => [date, 0]));
  const heldByNight = new Map(dates.map((date) => [date, new Set()]));
  // Compared by ET NIGHT, not clock time: a hold and a move in the same night
  // (a cut-off run, then its catch-up) is not "moved on a later night".
  const firstHeld = new Map(); // service id -> earliest night it was held
  const lastChanged = new Map(); // service id -> latest night it was moved
  let minutes = null;
  for (const row of rows) {
    const date = nightOfRun.get(String(row.auto_dispatch_run_id));
    if (!date) continue;
    const id = row.scheduled_service_id;
    if (row.action === 'changed') {
      moves.set(date, moves.get(date) + 1);
      if (id) lastChanged.set(id, later(lastChanged.get(id), date));
      const saved = savingMinutes(row);
      if (saved !== null) minutes = (minutes || 0) + saved;
    } else if (row.reason_code === HELD_CODE && id) {
      heldByNight.get(date).add(id);
      firstHeld.set(id, earlier(firstHeld.get(id), date));
    }
  }
  return { moves, heldByNight, firstHeld, lastChanged, minutes };
}

function summarizeRouteEngine({ runs = [], rows = [], today, nights = DEFAULT_NIGHTS } = {}) {
  const dates = windowDates(today, nights);
  const { best, nightOfRun } = indexRuns(runs, dates);
  const tally = tallyRows(rows, nightOfRun, dates);

  const nightList = dates.map((date) => ({
    date,
    status: STATUS_BY_RANK[best.get(date)],
    movesMade: tally.moves.get(date),
    held: tally.heldByNight.get(date).size,
  }));
  const count = (status) => nightList.filter((n) => n.status === status).length;
  const heldIds = [...tally.firstHeld.keys()];

  return {
    nights: nightList,
    totals: {
      finishedNights: count('finished'),
      withErrorsNights: count('with_errors'),
      failedNights: count('failed'),
      runningNights: count('running'),
      noRunNights: count('no_run'),
      movesMade: nightList.reduce((sum, n) => sum + n.movesMade, 0),
      heldVisits: heldIds.length,
      heldThenMoved: heldIds.filter((id) => (tally.lastChanged.get(id) || '') > tally.firstHeld.get(id)).length,
      estDriveMinutesSaved: tally.minutes === null ? null : Math.round(tally.minutes),
    },
    cap: capFrom(runs, nightOfRun),
    windowNights: nights,
  };
}

async function buildRouteEngineSummary(conn = defaultDb, { nights = DEFAULT_NIGHTS, now = new Date() } = {}) {
  const today = etDateString(now);
  const dates = windowDates(today, nights);
  const start = parseETDateTime(`${dates[0]}T00:00`);
  const end = parseETDateTime(`${etDateString(addETDays(now, 1))}T00:00`);
  const runs = await conn('auto_dispatch_runs')
    .whereIn('triggered_by', NIGHT_TRIGGERS)
    .where('started_at', '>=', start)
    .where('started_at', '<', end)
    .select('id', 'started_at', 'status', 'config_snapshot');
  const rows = runs.length
    ? await conn('auto_dispatch_audit_logs')
      .whereIn('auto_dispatch_run_id', runs.map((run) => run.id))
      .where((q) => q.where('action', 'changed').orWhere('reason_code', HELD_CODE))
      .select('auto_dispatch_run_id', 'scheduled_service_id', 'action', 'reason_code', 'route_metrics_snapshot', 'created_at')
    : [];
  return summarizeRouteEngine({ runs, rows, today, nights });
}

module.exports = { summarizeRouteEngine, buildRouteEngineSummary };
