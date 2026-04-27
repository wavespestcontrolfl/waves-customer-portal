/**
 * unassigned-overdue-detector — second dispatch alert generator.
 * Runs every 5 minutes via initScheduledJobs (gated by GATE_CRON_JOBS).
 * Finds jobs whose window_start (in America/New_York) has passed by
 * ≥ 15 min while technician_id IS NULL and the job hasn't moved to
 * on_site / completed / cancelled / skipped, and creates an
 * `unassigned_overdue` dispatch_alert via createAlert(). The Action
 * Queue surfaces the row in real time because createAlert emits
 * `dispatch:alert` to dispatch:admins post-commit.
 *
 * Severity bands (frozen at insert time, same as tech_late):
 *   15–29 min  → warn
 *   ≥ 30 min   → critical
 *
 * Scope distinction vs tech-late-detector:
 *   - tech_late:           technician_id IS NOT NULL (the tech
 *                          we sent is running behind)
 *   - unassigned_overdue:  technician_id IS NULL    (no tech has
 *                          been assigned and the window is slipping)
 * Both can fire for the same window if the dispatcher assigns a
 * tech to an already-overdue unassigned job — the existing
 * unassigned_overdue stays open until the dispatcher resolves it
 * (or it's auto-resolved on a terminal status), and tech_late will
 * fire on the next tick with the new tech_id.
 *
 * Idempotency is enforced at TWO layers:
 *   1. Read-side NOT EXISTS in the SELECT — drops 99% of duplicate
 *      candidates before any INSERT.
 *   2. DB-level partial unique index
 *      idx_dispatch_alerts_unassigned_overdue_one_unresolved
 *      (migration 20260427000003) — closes the race window where
 *      two concurrent ticks (Railway zero-downtime deploy overlap,
 *      future multi-replica scaling) both pass NOT EXISTS. The
 *      losing INSERT throws unique_violation (23505), which we
 *      catch and treat as a clean skip — winning tick already
 *      broadcast.
 *
 * No in-place updates — alerts are append-only. After the dispatcher
 * resolves a warn (or after a tech gets assigned and the dispatcher
 * manually resolves), if the job is still unassigned and overdue on
 * the next tick, a fresh critical fires.
 */
const db = require('../models/db');
const logger = require('./logger');
const { createAlert } = require('./dispatch-alerts');

// In-process mutex matches dashboard-alerts-cron.js + tech-late-detector.js.
let isRunning = false;

async function runUnassignedOverdueCheck() {
  if (isRunning) {
    logger.info('[unassigned-overdue-detector] previous tick still running, skipping this fire');
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
        s.window_start,
        s.scheduled_date,
        EXTRACT(EPOCH FROM (
          NOW() - ((s.scheduled_date + s.window_start) AT TIME ZONE 'America/New_York')
        )) / 60 AS delay_minutes
      FROM scheduled_services s
      WHERE s.scheduled_date >= ((NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '1 day')
        AND s.scheduled_date <= ((NOW() AT TIME ZONE 'America/New_York')::date)
        AND s.status NOT IN ('on_site', 'completed', 'cancelled', 'skipped')
        AND s.technician_id IS NULL
        AND s.window_start IS NOT NULL
        AND ((s.scheduled_date + s.window_start) AT TIME ZONE 'America/New_York')
              < NOW() - INTERVAL '15 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_alerts a
          WHERE a.type = 'unassigned_overdue'
            AND a.job_id = s.id
            AND a.resolved_at IS NULL
        )
    `);
    rows = result.rows || [];
  } catch (err) {
    logger.error(`[unassigned-overdue-detector] query failed: ${err.message}`);
    return { created: 0, error: err.message };
  }

  let created = 0;
  let suppressed = 0;
  for (const row of rows) {
    const delayMin = Math.floor(Number(row.delay_minutes) || 0);
    const severity = delayMin >= 30 ? 'critical' : 'warn';
    try {
      await createAlert({
        type: 'unassigned_overdue',
        severity,
        techId: null,
        jobId: row.job_id,
        payload: {
          delay_minutes: delayMin,
          window_start: row.window_start,
          scheduled_date: row.scheduled_date,
        },
      });
      created += 1;
    } catch (err) {
      // 23505 = unique_violation. Concurrent process beat us between
      // our NOT EXISTS read and our insert; winning tick already
      // broadcast. Silently no-op.
      if (err && err.code === '23505') {
        suppressed += 1;
        continue;
      }
      logger.error(`[unassigned-overdue-detector] createAlert failed for job ${row.job_id}: ${err.message}`);
    }
  }

  if (created > 0 || suppressed > 0) {
    logger.info(`[unassigned-overdue-detector] created ${created} unassigned_overdue alert(s)${suppressed ? ` (${suppressed} suppressed by unique index — concurrent race)` : ''}`);
  }
  return { created, suppressed, scanned: rows.length };
}

module.exports = { runUnassignedOverdueCheck };
