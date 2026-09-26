/** Refresh affected future routes after a committed schedule change.
 * The durable intent is registered after the outer commit and before any
 * discovery, repair, or measurement. Failures never reject the source write. */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays, validCalendarDate } = require('../../utils/datetime-et');
const { toDateStr } = require('../auto-dispatch/dates');
const { commitPromiseOf } = require('../../utils/trx-commit-promise');
const { getScheduleQualityMeasurements } = require('./day-quality');
const queue = require('./quality-refresh-queue');

function repairEnabled() {
  return ['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'].every(gateEnvValue);
}
const enabled = () => gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS') || repairEnabled();
const parsePayload = payload => typeof payload === 'string' ? JSON.parse(payload) : (payload || {});

function requestPayload({ jobId, customerIds = [], dates = [] }) {
  return {
    jobId: jobId || null,
    customerIds: [...new Set(customerIds.filter(Boolean).map(String))],
    dates: [...new Set(dates.map(toDateStr).filter(Boolean))],
  };
}

async function resolveAffectedDates(payload, now, conn) {
  const today = etDateString(now);
  const lastDate = etDateString(addETDays(now, 30));
  if (Array.isArray(payload.resolvedDates)) {
    return payload.resolvedDates.filter(date => validCalendarDate(date) && date > today && date <= lastDate).sort();
  }
  return conn.transaction(async snapshot => {
    const job = payload.jobId
      ? await snapshot('scheduled_services').where('id', payload.jobId).first('scheduled_date')
      : null;
    const customerStops = payload.customerIds?.length ? await snapshot('scheduled_services')
      .whereIn('customer_id', payload.customerIds)
      .whereBetween('scheduled_date', [today, lastDate])
      .whereNotIn('status', require('./day-quality').QUALITY_EXCLUDED_STATUSES)
      .distinct('scheduled_date') : [];
    return [...new Set([...(payload.dates || []), job?.scheduled_date, ...customerStops.map(row => row.scheduled_date)]
      .map(toDateStr))].filter(date => validCalendarDate(date) && date > today && date <= lastDate).sort();
  });
}

async function runRefreshOperation(job, now, conn) {
  try {
    if (!enabled()) return { status: 'gate_off' };
    const payload = parsePayload(job.payload);
    job.payload = payload;
    const affectedDates = await resolveAffectedDates(payload, now || new Date(), conn);
    if (!Array.isArray(payload.resolvedDates)) await queue.captureResolvedDates(job, affectedDates, conn);
    if (!affectedDates.length) return { status: 'outside_planning_horizon' };

    // Repair owns its serializable transactions. Never invoke the writer
    // inside a measurement snapshot or the original booking transaction.
    const repair = repairEnabled()
      ? await require('../route-reorder').runRouteRepairAfterChange({ dates: affectedDates, now }, conn) : null;
    if (!enabled()) return { status: 'gate_off' };
    if (!gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS')) {
      return { status: 'repair_checked', dates: affectedDates, repair };
    }
    const recorded = await conn.transaction(async snapshot => {
      const capturedAt = now || new Date();
      const measurements = [];
      for (const date of affectedDates) {
        const result = await getScheduleQualityMeasurements({ date }, snapshot, capturedAt);
        if (result.error) throw new Error('Schedule measurement rejected the affected date');
        for (const day of result.days) {
          // Names belong on interactive results, never in the planning ledger.
          for (const { technicianId, technician: _name, ...quality } of day.byTech) {
            measurements.push({ date: day.date, technician_id: technicianId, as_of: capturedAt.toISOString(),
              snapshot_phase: 'schedule_change', drive_model: result.driveModel, ...quality });
          }
        }
      }
      if (!gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS')) return { status: 'gate_off' };
      const [ledger] = await snapshot('route_optimization_planner_runs').insert({
        run_type: 'schedule_quality_change', status: 'completed',
        start_date: affectedDates[0], end_date: affectedDates.at(-1),
        technician_ids: JSON.stringify([...new Set(measurements.map(row => row.technician_id))]),
        service_types: JSON.stringify([]),
        constraints: JSON.stringify({ gate: 'GATE_SCHEDULE_QUALITY_MEASUREMENTS', day_quality_version: 2,
          code_revision: process.env.RAILWAY_GIT_COMMIT_SHA || null }),
        result: JSON.stringify({ trigger_job_id: payload.jobId || null, route_quality: measurements }),
        applied_count: 0, skipped_count: 0, failed_count: 0,
      }).returning('id');
      return { status: 'recorded', ledgerId: ledger.id, dates: affectedDates };
    }, { isolationLevel: 'repeatable read' });
    if (recorded.status === 'gate_off') return recorded;
    const alerts = await require('./quality-alerts').refreshScheduleQualityAlerts({ dates: affectedDates, now }, conn);
    if (alerts.status === 'failed') return { ...recorded, status: 'recorded_with_alert_error', repair, alerts };
    if (alerts.status === 'reconciled') {
      logger.info(`[schedule-quality] refresh ${job.id} reconciled alerts created=${alerts.created} resolved=${alerts.resolved}`);
    }
    return repair ? { ...recorded, repair } : recorded;
  } catch (error) {
    const payload = parsePayload(job.payload);
    logger.error(`[schedule-quality] post-change check failed for ${payload.jobId || 'affected-dates'} (${error.code || 'check_or_ledger_failure'})`);
    return { status: 'failed' };
  }
}

function retryReason(result) {
  if (result.status === 'failed' || result.status === 'recorded_with_alert_error') return result.errorCode || result.status;
  if (result.repair?.status === 'failed' || result.repair?.status === 'completed_with_errors' || Number(result.repair?.failed) > 0) {
    return `route_repair_${result.repair.status || 'returned_failures'}`;
  }
  return null;
}

async function settleQueueIntent(job, result, now, conn) {
  if (result.status === 'gate_off' || !enabled()) return 'gate_off';
  const reason = retryReason(result);
  const changed = reason
    ? await queue.retryQualityRefresh(job, reason, now, conn)
    : await queue.completeQualityRefresh(job, conn);
  if (!changed) throw Object.assign(new Error('Schedule quality refresh claim was superseded'), { code: 'STALE_REFRESH_CLAIM' });
  return reason ? 'retry' : 'completed';
}

async function refreshScheduleQualityAfterChange({ jobId, customerIds = [], dates = [], trx = null, now } = {}, conn = db) {
  if (!enabled()) return { status: 'gate_off' };
  if (trx) {
    const committed = commitPromiseOf(trx);
    if (!committed) return { status: 'commit_unverified' };
    try { await committed; } catch { return { status: 'rolled_back' }; }
  }
  if (!enabled()) return { status: 'gate_off' };
  const changedAt = now || new Date();
  let job;
  try {
    job = await queue.registerQualityRefresh(requestPayload({ jobId, customerIds, dates }), changedAt, conn);
  } catch (error) {
    logger.error(`[schedule-quality] durable refresh registration failed (${error.code || 'queue_insert_failure'})`);
    return { status: 'failed' };
  }
  const result = await runRefreshOperation(job, now, conn);
  try {
    await settleQueueIntent(job, result, now ? changedAt : new Date(), conn);
  } catch (error) {
    logger.error(`[schedule-quality] refresh ${job.id} queue settlement failed (${error.code || 'queue_settlement_failure'})`);
  }
  return result;
}

async function retryScheduleQualityRefreshes({ now, limit = 10 } = {}, conn = db) {
  const summary = { status: 'completed', processed: 0, succeeded: 0, failed: 0 };
  if (!enabled()) return { ...summary, status: 'gate_off' };
  while (summary.processed < limit) {
    if (!enabled()) return { ...summary, status: 'gate_off' };
    const attemptAt = now || new Date();
    const job = await queue.claimQualityRefresh(attemptAt, conn);
    if (!job) break;
    summary.processed += 1;
    const result = await runRefreshOperation(job, now, conn);
    let settlementFailed = false;
    let settlement;
    try { settlement = await settleQueueIntent(job, result, now || new Date(), conn); }
    catch (error) {
      settlementFailed = true;
      logger.error(`[schedule-quality] retry ${job.id} queue settlement failed (${error.code || 'queue_settlement_failure'})`);
    }
    if (result.status === 'gate_off' || settlement === 'gate_off') return { ...summary, status: 'gate_off' };
    if (settlementFailed || retryReason(result)) summary.failed += 1;
    else summary.succeeded += 1;
  }
  if (summary.failed) summary.status = 'failed';
  return summary;
}

module.exports = { refreshScheduleQualityAfterChange, retryScheduleQualityRefreshes };
