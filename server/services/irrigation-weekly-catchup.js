'use strict';

/**
 * Missed-tick catch-up for the Monday 7:00 ET irrigation weekly email sweep
 * (GATE_WATERING_CATCHUP, owner 2026-11-06 "jobs 1-6": "Monday catch-up runs
 * from 8:00 to 11:00. The send key blocks repeats.").
 *
 * The 7:00 tick is the sweep's only caller. A deploy restart on that minute,
 * node-cron dropping the tick, or a deploy killing the long sweep mid-run left
 * every customer it had not reached without that week's email. The cron lock
 * records every finished run of the job in job_health.last_success_at, so
 * "did this week's sweep finish" is that stamp being on or after this ET
 * week's Monday 00:00. No new table.
 *
 * Repeats are blocked where they always were: the sweep's per customer-week
 * checks (email_messages trigger_event_id / idempotency_key, the week-plan
 * snapshot) and the template library's idempotency key. The catch-up run also
 * skips a customer whose week email already went out BEFORE the weather and
 * forecast calls (skipDeliveredBeforeFetch), so a sweep killed half way does
 * not repeat those calls for the customers it already reached.
 *
 * The sweep reads the live clock per customer, so the noon plan cutoff
 * (PLAN_WINDOW_END_HOUR_ET in irrigation-weekly-email.js) applies unchanged:
 * a catch-up customer reached before noon gets this week's plan, one reached
 * after noon gets the pre-plan email.
 */
const logger = require('./logger');
const { etWeekStart, parseETDateTime } = require('../utils/datetime-et');

const JOB_NAME = 'irrigation-weekly-email';

/**
 * True when this ET week's sweep has NOT finished yet. THROWS when job_health
 * cannot be read. Code that runs under the job lock must use this form:
 * runExclusive records a resolved callback as a successful run, so a read
 * failure answered as "already ran" would stamp last_success_at with nothing
 * sent and hide the week from the next catch-up tick.
 */
async function readSweepWeekMissing({ now = new Date(), db } = {}) {
  const conn = db || require('../models/db');
  const row = await conn('job_health').where({ job_name: JOB_NAME }).first('last_success_at');
  const weekStartMs = parseETDateTime(`${etWeekStart(now)}T00:00`).getTime();
  const ranMs = row?.last_success_at ? new Date(row.last_success_at).getTime() : NaN;
  return !(Number.isFinite(ranMs) && ranMs >= weekStartMs);
}

/**
 * Pre-lock form for the cron tick: a read failure answers false (skip, take
 * no lock, record nothing; the next tick tries again), so a database blip
 * never starts a run.
 */
async function sweepWeekIsMissing(opts = {}) {
  try {
    return await readSweepWeekMissing(opts);
  } catch (err) {
    logger.warn(`[irrigation-weekly-email] catch-up check could not read job_health: ${err.message}`);
    return false;
  }
}

/**
 * The catch-up run. Meant to run inside runExclusive(JOB_NAME), the 7:00
 * tick's own lock: a sweep still running holds it, so the catch-up skips.
 * It checks again under that lock (a run that finished while this one waited
 * is not run twice); that read throws on failure, so the run is recorded as
 * failed, never as done. No `now` is passed to the sweep: it keeps the live
 * clock per customer, so the noon plan cutoff is judged per customer.
 */
async function runWeeklyIrrigationEmailCatchUp({ now = new Date(), db } = {}) {
  if (!(await readSweepWeekMissing({ now, db }))) return { skipped: 'already_ran' };
  const { runWeeklyIrrigationEmailSweep } = require('./irrigation-weekly-email');
  return runWeeklyIrrigationEmailSweep({ skipDeliveredBeforeFetch: true });
}

module.exports = { JOB_NAME, readSweepWeekMissing, sweepWeekIsMissing, runWeeklyIrrigationEmailCatchUp };
