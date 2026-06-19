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

function jsonb(value) {
  try { return JSON.stringify(value == null ? {} : value); } catch (_) { return '{}'; }
}

async function startRun(config, triggeredBy = 'cron') {
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

  const svcDate = service && service.scheduled_date ? String(service.scheduled_date).split('T')[0] : null;
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

module.exports = { startRun, logDecision, completeRun };
