/**
 * tech-late-detector — first dispatch alert generator. Runs every
 * 5 minutes via initScheduledJobs (gated by GATE_CRON_JOBS). Finds
 * jobs whose window_start (in America/New_York) has passed by
 * ≥ 15 min while the job hasn't moved to on_site / completed /
 * cancelled / skipped, and creates a `tech_late` dispatch_alert via
 * createAlert(). The Action Queue surfaces the row in real time
 * because createAlert emits `dispatch:alert` to dispatch:admins
 * post-commit.
 *
 * Severity bands (frozen at insert time):
 *   15–29 min  → warn
 *   ≥ 30 min   → critical
 *
 * Idempotency is enforced at TWO layers, on purpose:
 *   1. Read-side NOT EXISTS in the SELECT — drops 99% of duplicate
 *      candidates before we ever attempt an INSERT. Cheap; uses
 *      idx_dispatch_alerts_unresolved.
 *   2. DB-level partial unique index
 *      idx_dispatch_alerts_tech_late_one_unresolved (migration
 *      20260427000001) — closes the race window where two concurrent
 *      ticks (e.g. old + new container during a Railway zero-downtime
 *      deploy) both pass NOT EXISTS and both call createAlert. The
 *      losing INSERT throws unique_violation (23505), we catch it
 *      and treat it as a clean skip — the winning tick already
 *      broadcast the alert.
 *
 * No in-place updates — alerts are append-only. After the dispatcher
 * resolves a warn, if the job is still late on the next tick a fresh
 * critical fires; that's the intended escalation path, not a
 * missed-tick.
 *
 * Why scope to today + yesterday in ET?
 *   - "Today's route" is the actual operational window. A job
 *     scheduled three weeks ago that never got marked complete
 *     shouldn't keep generating alerts forever; that's a data
 *     hygiene problem, not a "tech is late" problem.
 *   - Yesterday is included so a job that ran past midnight ET
 *     (rare but possible during overruns) still gets one tick of
 *     coverage.
 *
 * Why skip technician_id IS NULL?
 *   - Unassigned-but-overdue jobs are a different signal kind
 *     (they need routing, not chasing). A future generator can
 *     emit `unassigned_overdue` with tech_id=null. tech_late means
 *     "the tech we sent is running behind."
 */
const db = require('../models/db');
const logger = require('./logger');
const { createAlert } = require('./dispatch-alerts');

// In-process mutex matches dashboard-alerts-cron.js. node-cron fires
// regardless of whether the prior tick finished, and the detector
// query + per-row createAlert chain can take a few seconds on a
// busy day. The mutex prevents a slow tick + the next scheduled tick
// from racing inside ONE Node process. Cross-process races (Railway's
// zero-downtime deploy overlap, or future multi-replica scaling) are
// covered by the partial unique index — see header.
let isRunning = false;

async function runTechLateCheck() {
  if (isRunning) {
    logger.info('[tech-late-detector] previous tick still running, skipping this fire');
    return { created: 0, skipped: true };
  }
  isRunning = true;
  try {
    return await runInner();
  } finally {
    isRunning = false;
  }
}

async function runInner() {
  let rows;
  try {
    const result = await db.raw(`
      SELECT
        s.id AS job_id,
        s.technician_id AS tech_id,
        s.window_start,
        s.scheduled_date,
        EXTRACT(EPOCH FROM (
          NOW() - ((s.scheduled_date + s.window_start) AT TIME ZONE 'America/New_York')
        )) / 60 AS delay_minutes
      FROM scheduled_services s
      WHERE s.scheduled_date >= ((NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '1 day')
        AND s.scheduled_date <= ((NOW() AT TIME ZONE 'America/New_York')::date)
        AND s.status NOT IN ('on_site', 'completed', 'cancelled', 'skipped')
        AND s.technician_id IS NOT NULL
        AND s.window_start IS NOT NULL
        AND ((s.scheduled_date + s.window_start) AT TIME ZONE 'America/New_York')
              < NOW() - INTERVAL '15 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_alerts a
          WHERE a.type = 'tech_late'
            AND a.job_id = s.id
            AND a.resolved_at IS NULL
        )
    `);
    rows = result.rows || [];
  } catch (err) {
    logger.error(`[tech-late-detector] query failed: ${err.message}`);
    return { created: 0, error: err.message };
  }

  let created = 0;
  let suppressed = 0;
  for (const row of rows) {
    const delayMin = Math.floor(Number(row.delay_minutes) || 0);
    const severity = delayMin >= 30 ? 'critical' : 'warn';
    try {
      await createAlert({
        type: 'tech_late',
        severity,
        techId: row.tech_id,
        jobId: row.job_id,
        payload: {
          delay_minutes: delayMin,
          window_start: row.window_start,
          scheduled_date: row.scheduled_date,
        },
      });
      created += 1;
    } catch (err) {
      // 23505 = unique_violation. The partial unique index
      // idx_dispatch_alerts_tech_late_one_unresolved fires when
      // another process (concurrent deploy overlap, second worker)
      // already inserted an unresolved tech_late for this job
      // between our NOT EXISTS read and our insert. The winning
      // tick already broadcast — we silently no-op.
      if (err && err.code === '23505') {
        suppressed += 1;
        continue;
      }
      // One bad row shouldn't poison the rest. Log and continue.
      logger.error(`[tech-late-detector] createAlert failed for job ${row.job_id}: ${err.message}`);
    }
  }

  if (created > 0 || suppressed > 0) {
    logger.info(`[tech-late-detector] created ${created} tech_late alert(s)${suppressed ? ` (${suppressed} suppressed by unique index — concurrent race)` : ''}`);
  }
  return { created, suppressed, scanned: rows.length };
}

module.exports = { runTechLateCheck };
