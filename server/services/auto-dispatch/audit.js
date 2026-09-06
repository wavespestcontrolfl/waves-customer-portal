/**
 * Auto-dispatch run + per-service audit writers.
 *
 * auto_dispatch_runs   = one row per job run (counts + config snapshot + status)
 * auto_dispatch_audit_logs = one row per evaluated service (skip/no_change/
 *                            recommended/changed/failed) with before/after,
 *                            scores, preference + route-metric snapshots.
 * Also emits a single run-level row into the generic audit_log via recordAuditEvent.
 *
 * jsonb values are stringified — pg accepts a JSON string into a jsonb column,
 * and this avoids relying on driver auto-serialization.
 */
const db = require('../../models/db');
const { recordAuditEvent } = require('../audit-log');
const logger = require('./../logger');
const { toDateStr } = require('./dates');

function jsonb(value) {
  try { return JSON.stringify(value == null ? {} : value); } catch (_) { return '{}'; }
}

// A run whose process died mid-sweep (Railway container swap during the
// 4:10 tick — 2026-09-03, the GATE_PAY_PAGE_FAQ redeploy) never reaches
// completeRun, so its row stays 'running' forever: the Auto-Dispatch page
// shows a blue in-flight chip for a run that ended hours ago and the job
// watch pages "stuck" every morning. The advisory lock itself is freed by
// Postgres when the connection drops, so nothing blocks the next tick —
// only the ledger lies. Settle any prior 'running' row older than the
// longest plausible sweep before starting a new one. Best-effort: a failed
// settle must never stop a real run.
const STALE_RUNNING_MINUTES = 60;

async function settleAbandonedRuns() {
  try {
    const n = await db('auto_dispatch_runs')
      .where({ status: 'running' })
      .where('started_at', '<', new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000))
      .update({
        status: 'failed',
        completed_at: db.fn.now(),
        updated_at: db.fn.now(),
        error_message: `process exited mid-run (no completion recorded within ${STALE_RUNNING_MINUTES} min — deploy restart?)`,
      });
    if (n) logger.warn(`[auto-dispatch] settled ${n} abandoned run(s) still marked running`);
  } catch (e) {
    logger.warn(`[auto-dispatch] abandoned-run settle failed: ${e.message}`);
  }
}

async function startRun(config, triggeredBy = 'cron') {
  await settleAbandonedRuns();
  const [row] = await db('auto_dispatch_runs')
    .insert({
      status: 'running',
      mode: config.mode,
      config_snapshot: jsonb(config),
      triggered_by: triggeredBy,
    })
    .returning(['id']);
  return (row && (row.id || row)) || null;
}

/**
 * Insert one decision row. Fire-and-forget: a lost audit row must not abort the
 * run, but absence is logged.
 */
async function logDecision(runId, opts = {}) {
  const {
    action,
    service = null,
    reason_code = null,
    reason_description = null,
    oldPlacement = null,
    newPlacement = null,
    scores = null,
    prefsSnapshot = null,
    routeMetrics = null,
    constraints = null,
    appliedBy = null,
    error = null,
  } = opts;

  const svcDate = service ? toDateStr(service.scheduled_date) : null;
  const row = {
    auto_dispatch_run_id: runId,
    scheduled_service_id: (service && service.id) || null,
    customer_id: (service && service.customer_id) || null,
    recurring_parent_id: (service && service.recurring_parent_id) || null,
    action,
    reason_code,
    reason_description,
    old_scheduled_date: (oldPlacement && oldPlacement.date) || svcDate,
    old_window_start: (oldPlacement && oldPlacement.window_start) || (service && service.window_start) || null,
    old_window_end: (oldPlacement && oldPlacement.window_end) || (service && service.window_end) || null,
    old_technician_id: (oldPlacement && oldPlacement.technician_id) || (service && service.technician_id) || null,
    old_status: (oldPlacement && oldPlacement.status) || (service && service.status) || null,
    old_zone: (service && service.zone) || null,
    new_scheduled_date: (newPlacement && newPlacement.date) || null,
    new_window_start: (newPlacement && newPlacement.window_start) || null,
    new_window_end: (newPlacement && newPlacement.window_end) || null,
    new_technician_id: (newPlacement && newPlacement.technician_id) || null,
    new_status: (newPlacement && newPlacement.status) || null,
    new_zone: (newPlacement && newPlacement.zone) || null,
    old_score: scores ? scores.old : null,
    new_score: scores ? scores.new : null,
    score_improvement: scores ? scores.improvement : null,
    portal_preferences_snapshot: jsonb(prefsSnapshot),
    route_metrics_snapshot: jsonb(routeMetrics),
    constraints_checked: jsonb(constraints),
    applied_by: appliedBy,
    error_message: error,
  };

  try {
    await db('auto_dispatch_audit_logs').insert(row);
  } catch (e) {
    logger.error(`[auto-dispatch] audit insert failed (${action}/${reason_code}): ${e.message}`);
  }
}

async function completeRun(runId, { status, totals, error = null }) {
  try {
    await db('auto_dispatch_runs').where({ id: runId }).update({
      status,
      completed_at: db.fn.now(),
      updated_at: db.fn.now(),
      total_evaluated: totals.evaluated,
      total_skipped: totals.skipped,
      total_recommended: totals.recommended,
      total_changed: totals.changed,
      total_failed: totals.failed,
      error_message: error,
    });
  } catch (e) {
    logger.error(`[auto-dispatch] completeRun update failed for ${runId}: ${e.message}`);
  }

  try {
    await recordAuditEvent({
      actor_type: 'system',
      action: 'auto_dispatch.daily_run',
      resource_type: 'auto_dispatch_run',
      resource_id: runId,
      metadata: { status, ...totals, error },
    });
  } catch (_) { /* non-critical */ }
}

// Include skipped/locked rows: unplaced due dates must not disappear behind
// eligibility filters or the run cap. The existing bell dedupes repeated runs.
async function flagUnplacedVisits(config, nowDate = new Date()) {
  const { etDateString, addETDays } = require('../../utils/datetime-et');
  const { toDateStr } = require('./dates');
  // Retire obsolete content even if staff already acknowledged the card:
  // the shared deduper needs changed content to reopen a later recurrence.
  // Skip resolved cards so repeated recovery passes do not rewrite history.
  const resolvedTitle = 'Recurring placement alert resolved';
  await db('notifications')
    .where({ recipient_type: 'admin', category: 'schedule_conflict' })
    .whereNot('title', resolvedTitle)
    .whereRaw("metadata->>'dedupeKey' LIKE ?", ['recurring-dispatch:%'])
    .whereNotExists(function stillUnplaced() {
      this.select('s.id').from('scheduled_services as s')
        .join('customers as c', 'c.id', 's.customer_id')
        .where('c.active', true)
        .whereNull('c.deleted_at')
        .whereRaw("s.id::text = notifications.metadata->>'scheduledServiceId'")
        .whereRaw("s.recurring_dispatch_due_date::text = notifications.metadata->>'dueDate'")
        .whereNull('s.window_start')
        .whereIn('s.status', ['pending', 'confirmed']);
    })
    .update({
      read_at: nowDate,
      title: resolvedTitle,
      body: 'This visit is no longer awaiting placement for the recorded due date.',
    });
  const cutoff = etDateString(addETDays(nowDate, Math.max(14, config.lockWindowDays + 4)));
  const rows = await db('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .whereNotNull('s.recurring_dispatch_due_date')
    .whereNull('s.window_start')
    .whereIn('s.status', ['pending', 'confirmed'])
    .where('s.recurring_dispatch_due_date', '<=', cutoff)
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .select('s.id', 's.customer_id', 's.recurring_dispatch_due_date');
  const notifications = require('../notification-service');
  let flagged = 0;
  for (const row of rows) {
    const due = toDateStr(row.recurring_dispatch_due_date);
    const notice = await db.transaction(async (trx) => {
      // Pin placement through the shared notification dedupe/write. A staff
      // placement that won the row lock makes this a no-op; one that follows
      // us waits until the still-valid alert has committed.
      const current = await trx('scheduled_services as s')
        .join('customers as c', 'c.id', 's.customer_id')
        .where({ 's.id': row.id, 's.customer_id': row.customer_id, 's.recurring_dispatch_due_date': due, 'c.active': true })
        .whereNull('c.deleted_at')
        .whereNull('s.window_start')
        .whereIn('s.status', ['pending', 'confirmed'])
        .forNoKeyUpdate('s')
        .first('s.id');
      if (!current) return null;
      const inserted = await notifications.notifyAdmin(
        'schedule_conflict',
        'Recurring visit still needs a time',
        `A recurring visit due ${due} is still awaiting placement within three days of its due date. Review availability and customer preferences in dispatch.`,
        {
          bell: true,
          link: `/admin/dispatch?tab=schedule&date=${due}`,
          dedupeKey: `recurring-dispatch:${row.id}:${due}`,
          // Reopen a previously resolved card if this due date becomes unplaced
          // again; the shared deduper leaves acknowledged, unchanged cards alone.
          refreshOnDedupe: true,
          metadata: { scheduledServiceId: row.id, customerId: row.customer_id, dueDate: due },
          trx,
        },
      );
      if (!inserted) throw new Error(`Recurring placement exception could not be recorded for ${row.id}`);
      return inserted;
    });
    if (notice) flagged += 1;
  }
  return flagged;
}

module.exports = { startRun, logDecision, completeRun, settleAbandonedRuns, STALE_RUNNING_MINUTES, flagUnplacedVisits };
