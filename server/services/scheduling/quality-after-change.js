/** Refresh affected future routes after a committed schedule change.
 * Measurement and guarded order repair each keep their own opt-in gate.
 * A failed check must not turn an already committed booking into a failed
 * booking response. */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays, validCalendarDate } = require('../../utils/datetime-et');
const { toDateStr } = require('../auto-dispatch/dates');
const { commitPromiseOf } = require('../../utils/trx-commit-promise');
const { getScheduleQualityMeasurements } = require('./day-quality');

function repairEnabled() {
  return ['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR', 'GATE_DRIVE_TIME_CALIBRATION'].every(gateEnvValue);
}
const enabled = () => gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS') || repairEnabled();

async function refreshScheduleQualityAfterChange({ jobId, dates = [], trx = null, now } = {}, conn = db) {
  if (!enabled()) return { status: 'gate_off' };
  // Transactional writers call this without awaiting it inside their write.
  // A released savepoint is not a commit; a rollback creates no snapshot.
  if (trx) {
    const committed = commitPromiseOf(trx);
    if (!committed) return { status: 'commit_unverified' };
    try { await committed; } catch { return { status: 'rolled_back' }; }
  }
  if (!enabled()) return { status: 'gate_off' };
  try {
    const changedAt = now || new Date();
    const today = etDateString(changedAt);
    const lastDate = etDateString(addETDays(changedAt, 30));
    const affectedDates = await conn.transaction(async snapshot => {
      const job = jobId ? await snapshot('scheduled_services').where('id', jobId).first('scheduled_date') : null;
      return [...new Set([...dates, job?.scheduled_date].map(toDateStr))]
        .filter(date => validCalendarDate(date) && date > today && date <= lastDate).sort();
    });
    if (!affectedDates.length) return { status: 'outside_planning_horizon' };
    // Repair owns its serializable transactions. Never invoke the writer
    // inside a measurement snapshot or the original booking transaction.
    const repair = repairEnabled()
      ? await require('../route-reorder').runRouteRepairAfterChange({ dates: affectedDates, now }, conn) : null;
    if (!gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS')) return { status: 'repair_checked', dates: affectedDates, repair };
    const recorded = await conn.transaction(async snapshot => {
      const capturedAt = now || new Date();
      const measurements = [];
      for (const date of affectedDates) {
        const result = await getScheduleQualityMeasurements({ date }, snapshot, capturedAt);
        if (result.error) throw new Error('Schedule measurement rejected the affected date');
        for (const day of result.days) {
          // Never copy technician names from the interactive reader into the
          // ledger. Empty routes are intentional: removing a day's last job
          // must supersede the previous nonempty planning snapshot too.
          for (const { technicianId, technician: _name, ...quality } of day.byTech) {
            measurements.push({ date: day.date, technician_id: technicianId, as_of: capturedAt.toISOString(),
              snapshot_phase: 'schedule_change', drive_model: result.driveModel, ...quality });
          }
        }
      }
      // A kill during the reads also prevents a new ledger write.
      if (!gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS')) return { status: 'gate_off' };
      const [ledger] = await snapshot('route_optimization_planner_runs').insert({
        run_type: 'schedule_quality_change', status: 'completed',
        start_date: affectedDates[0], end_date: affectedDates.at(-1),
        technician_ids: JSON.stringify([...new Set(measurements.map(row => row.technician_id))]),
        service_types: JSON.stringify([]),
        constraints: JSON.stringify({ gate: 'GATE_SCHEDULE_QUALITY_MEASUREMENTS', day_quality_version: 2,
          code_revision: process.env.RAILWAY_GIT_COMMIT_SHA || null }),
        result: JSON.stringify({ trigger_job_id: jobId || null, route_quality: measurements }),
        applied_count: 0, skipped_count: 0, failed_count: 0,
      }).returning('id');
      return { status: 'recorded', ledgerId: ledger.id, dates: affectedDates };
    }, { isolationLevel: 'repeatable read' });
    const alerts = await require('./quality-alerts').refreshScheduleQualityAlerts({ dates: affectedDates, now }, conn);
    if (alerts.status === 'failed') return { ...recorded, status: 'recorded_with_alert_error', repair, alerts };
    return repair ? { ...recorded, repair } : recorded;
  } catch (error) {
    logger.error(`[schedule-quality] post-change check failed for ${jobId || 'affected-dates'} (${error.code || 'check_or_ledger_failure'})`);
    return { status: 'failed' };
  }
}

module.exports = { refreshScheduleQualityAfterChange };
