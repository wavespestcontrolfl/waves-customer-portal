/**
 * Auto-dispatch 05:00 catch-up (GATE_AUTO_DISPATCH_CATCH_UP, owner 2026-10-26).
 *
 * The 04:10 night run is cut off when a deploy restarts the server while it
 * runs (2026-09-03 and 2026-10-26: the run moved nothing, nothing re-ran it,
 * and its run row stayed 'running'). The 05:00 job in scheduler.js calls
 * runCatchUp() to close that gap: if today has no finished night run, it runs
 * the night tool once more with triggered_by = 'catch_up'.
 *
 * A finished night run is a 'cron' or 'catch_up' row started today (ET) with
 * status completed or completed_with_errors. A 'failed' or still-'running'
 * row does not count. At most one catch-up per ET day, so a run that fails
 * twice is not retried in a loop.
 *
 * Manual runs never count: an admin dry run is not the night's placement run.
 */
const logger = require('../logger');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const NIGHT_TRIGGERS = ['cron', 'catch_up'];
const FINISHED_STATUSES = ['completed', 'completed_with_errors'];

function etDayBounds(nowDate) {
  const today = etDateString(nowDate);
  const tomorrow = etDateString(addETDays(nowDate, 1));
  return {
    today,
    start: parseETDateTime(`${today}T00:00`),
    end: parseETDateTime(`${tomorrow}T00:00`),
  };
}

/**
 * Does today (ET date of nowDate) still need a night run?
 * Returns { needed: boolean, reason: string }.
 */
async function needsCatchUp(db, nowDate = new Date()) {
  const { today, start, end } = etDayBounds(nowDate);
  const rows = await db('auto_dispatch_runs')
    .whereIn('triggered_by', NIGHT_TRIGGERS)
    .where('started_at', '>=', start)
    .where('started_at', '<', end)
    .select('triggered_by', 'status');

  if (rows.some((r) => r.triggered_by === 'catch_up')) {
    return { needed: false, reason: `a catch-up run already started on ${today}` };
  }
  const finished = rows.find((r) => FINISHED_STATUSES.includes(r.status));
  if (finished) {
    return { needed: false, reason: `the night run on ${today} already finished (${finished.status})` };
  }
  if (rows.length === 0) {
    return { needed: true, reason: `no night run started on ${today}` };
  }
  if (rows.some((r) => r.status === 'running')) {
    return { needed: true, reason: `the night run on ${today} was cut off (still marked running)` };
  }
  return { needed: true, reason: `the night run on ${today} failed (${rows.map((r) => r.status).join(', ')})` };
}

/**
 * Settle cron run rows left 'running' by a process that died.
 *
 * Call ONLY while holding the 'auto-dispatch-recurring' advisory lock. Every
 * cron run holds that lock for its whole run, and Postgres frees it when the
 * process dies; so while the caller holds it, no cron run is alive and a
 * 'running' cron row is a dead one. Rows from any other triggered_by are left
 * alone (ops scripts may call runAutoDispatch outside the lock).
 *
 * Returns the number of rows settled.
 */
async function settleDeadCronRuns(db, nowDate = new Date()) {
  void nowDate;
  const n = await db('auto_dispatch_runs')
    .where({ status: 'running', triggered_by: 'cron' })
    .update({
      status: 'failed',
      completed_at: db.fn.now(),
      updated_at: db.fn.now(),
      error_message: 'process exited mid-run (settled by the 5:00 AM catch-up while it held the run lock)',
    });
  if (n) logger.warn(`[auto-dispatch] catch-up settled ${n} cron run(s) left running by a dead process`);
  return Number(n) || 0;
}

/**
 * Settle dead cron rows, then run the night tool once if today still needs it.
 * The caller holds the 'auto-dispatch-recurring' lock.
 * Returns { ran: false, reason, settled } or { ran: true, reason, settled, result }.
 */
async function runCatchUp({ nowDate = new Date(), db = require('../../models/db'), runAutoDispatch } = {}) {
  const settled = await settleDeadCronRuns(db, nowDate);
  const need = await needsCatchUp(db, nowDate);
  if (!need.needed) return { ran: false, reason: need.reason, settled };
  logger.info(`[auto-dispatch] catch-up needed: ${need.reason}`);
  const run = runAutoDispatch || require('./index').runAutoDispatch;
  const result = await run({ triggeredBy: 'catch_up' });
  return { ran: true, reason: need.reason, settled, result };
}

module.exports = { needsCatchUp, settleDeadCronRuns, runCatchUp, NIGHT_TRIGGERS, FINISHED_STATUSES };
