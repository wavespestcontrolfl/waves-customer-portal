/**
 * tech-late-detector — first dispatch alert generator. Runs every
 * 5 minutes via initScheduledJobs (gated by GATE_CRON_JOBS). Finds
 * jobs whose arrival window due time (window_end, or window_start +
 * estimated duration fallback) has passed by ≥ 15 min while the job
 * hasn't moved to on_site / completed /
 * cancelled / skipped, and creates a `tech_late` dispatch_alert via
 * createAlert(). The Action Queue surfaces the row in real time
 * because createAlert emits `dispatch:alert` to dispatch:admins
 * post-commit.
 *
 * Severity bands (frozen at insert time):
 *   15–29 min after due time  → warn
 *   ≥ 30 min after due time   → critical
 *
 * Noise controls:
 *   - Do not fire at window_start. Most Waves jobs have an arrival
 *     window; warning 15 minutes after the start created noisy cards
 *     for normal in-window arrivals.
 *   - Do not create tech_late for stale pending jobs more than 3
 *     hours past due. Those are data hygiene / completion cleanup,
 *     not live dispatch signals.
 *   - Do not re-alert the same scheduled window after a dispatcher
 *     clears it. A cleared alert is treated as acknowledged only
 *     when its payload matches this job's scheduled_date/window_start/
 *     window_end, so a later reschedule can still alert if it slips.
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

const TECH_LATE_GRACE_MINUTES = 15;
const TECH_LATE_CRITICAL_MINUTES = 30;
const TECH_LATE_MAX_DELAY_MINUTES = 180;
const TECH_LATE_FALLBACK_DURATION_MINUTES = 60;

function normalizeDateOnly(value) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

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
      WITH candidates AS (
        SELECT
          s.id AS job_id,
          s.technician_id AS tech_id,
          s.window_start,
          s.window_end,
          s.scheduled_date,
          (
            CASE
              WHEN s.window_end IS NOT NULL
                THEN s.scheduled_date + s.window_end
              ELSE
                s.scheduled_date
                  + s.window_start
                  + make_interval(mins => COALESCE(NULLIF(s.estimated_duration_minutes, 0), ${TECH_LATE_FALLBACK_DURATION_MINUTES}))
            END
          ) AT TIME ZONE 'America/New_York' AS due_at
        FROM scheduled_services s
        WHERE s.scheduled_date >= ((NOW() AT TIME ZONE 'America/New_York')::date - INTERVAL '1 day')
          AND s.scheduled_date <= ((NOW() AT TIME ZONE 'America/New_York')::date)
          AND s.status NOT IN ('on_site', 'completed', 'cancelled', 'skipped')
          AND s.technician_id IS NOT NULL
          AND s.window_start IS NOT NULL
      )
      SELECT
        c.job_id,
        c.tech_id,
        c.window_start,
        c.window_end,
        c.scheduled_date,
        EXTRACT(EPOCH FROM (
          NOW() - c.due_at
        )) / 60 AS delay_minutes
      FROM candidates c
      WHERE c.due_at < NOW() - INTERVAL '${TECH_LATE_GRACE_MINUTES} minutes'
        AND c.due_at >= NOW() - INTERVAL '${TECH_LATE_MAX_DELAY_MINUTES} minutes'
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_alerts a
          WHERE a.type = 'tech_late'
            AND a.job_id = c.job_id
            AND (
              a.resolved_at IS NULL
              OR (
                LEFT(a.payload->>'scheduled_date', 10) = c.scheduled_date::text
                AND a.payload->>'window_start' = c.window_start::text
                AND COALESCE(a.payload->>'window_end', '') = COALESCE(c.window_end::text, '')
              )
            )
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
    const severity = delayMin >= TECH_LATE_CRITICAL_MINUTES ? 'critical' : 'warn';
    try {
      await createAlert({
        type: 'tech_late',
        severity,
        techId: row.tech_id,
        jobId: row.job_id,
        payload: {
          delay_minutes: delayMin,
          window_start: row.window_start,
          window_end: row.window_end,
          scheduled_date: normalizeDateOnly(row.scheduled_date),
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

module.exports = {
  runTechLateCheck,
  TECH_LATE_GRACE_MINUTES,
  TECH_LATE_CRITICAL_MINUTES,
  TECH_LATE_MAX_DELAY_MINUTES,
  TECH_LATE_FALLBACK_DURATION_MINUTES,
  _test: {
    normalizeDateOnly,
  },
};
