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
 * Idempotency: skip jobs that already have an unresolved tech_late
 * alert. The partial index `idx_dispatch_alerts_unresolved` plus the
 * `WHERE a.type = 'tech_late' AND a.job_id = ...` filter keeps the
 * NOT EXISTS subquery cheap. No in-place updates — alerts are
 * append-only. After the dispatcher resolves a warn, if the job is
 * still late on the next tick a fresh critical fires; that's the
 * intended escalation path, not a missed-tick.
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
// busy day. Without the gate, two ticks could both pass the
// NOT EXISTS check for the same job and double-insert. Single-replica
// deploy makes a process-local flag enough; if Railway scales out,
// swap to a pg_advisory_lock keyed on a fixed bigint.
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
      // One bad row shouldn't poison the rest. Log and continue.
      logger.error(`[tech-late-detector] createAlert failed for job ${row.job_id}: ${err.message}`);
    }
  }

  if (created > 0) {
    logger.info(`[tech-late-detector] created ${created} tech_late alert(s)`);
  }
  return { created, scanned: rows.length };
}

module.exports = { runTechLateCheck };
