/** Reconcile future route exceptions through the existing Dispatch writer.
 * No appointment writes or customer notifications. Timing is a forecast,
 * never proof that an unknown location or grouped service can be driven. */
const db = require('../../models/db');
const { isDeepStrictEqual } = require('node:util');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays, validCalendarDate } = require('../../utils/datetime-et');
const { toDateStr } = require('../auto-dispatch/dates');
const { createAlert, resolveAlert } = require('../dispatch-alerts');
const { getScheduleQualityMeasurements } = require('./day-quality');

const TYPE = 'schedule_route_quality';
const enabled = () => ['GATE_SCHEDULE_QUALITY_MEASUREMENTS', 'GATE_SCHEDULE_QUALITY_ALERTS'].every(gateEnvValue);

function buildRouteQualityAlerts(day, driveModel) {
  const alerts = [];
  for (const quality of day.byTech) {
    const issues = [];
    const missing = quality.missingCoordinates.length;
    if (missing) issues.push(`${missing} visit${missing === 1 ? '' : 's'} without a usable location. Verify the service address and map pin.`);
    const unknownDurations = quality.defaultDurations.length;
    if (unknownDurations) issues.push(`${unknownDurations} visit${unknownDurations === 1 ? ' needs' : 's need'} a service duration before route timing can be verified.`);
    if (quality.uncertaintyReasons.includes('grouped_work_requires_review')) {
      issues.push('Grouped services need a combined duration check before route timing can be verified.');
    }
    const late = driveModel === 'calibrated' && !unknownDurations ? quality.modeledLateVisits?.length : 0;
    if (late) issues.push(`${late} visit${late === 1 ? '' : 's'} modeled after the promised arrival window. Review the running order and appointment commitments.`);
    if (issues.length) alerts.push({ techId: quality.technicianId, payload: {
      date: day.date, issues, ...(late ? { departureMinutes: quality.assumptions.departureMinutes } : {}),
    } });
  }
  const dayIssues = [];
  if (day.unallocatedVisits) dayIssues.push(`${day.unallocatedVisits} visit${day.unallocatedVisits === 1 ? ' needs' : 's need'} placement with an available technician.`);
  if (day.closed && (day.unallocatedVisits || day.byTech.some(quality => quality.scheduledVisits))) {
    dayIssues.push('Work is scheduled on a configured day off. Review the date and staffing.');
  }
  if (dayIssues.length) alerts.push({ techId: null, payload: { date: day.date, issues: dayIssues } });
  return alerts;
}

async function refreshScheduleQualityAlerts({ dates = [], now } = {}, conn = db) {
  if (!enabled()) return { status: 'gate_off' };
  try {
    return await conn.transaction(async trx => {
      // All generators of this type share this lock. READ COMMITTED ensures
      // a checker that waited sees the prior checker's cards and the current
      // schedule, rather than reconciling an older repeatable-read snapshot.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['schedule-route-quality-alerts']);
      const capturedAt = now || new Date();
      const today = etDateString(capturedAt);
      const lastDate = etDateString(addETDays(capturedAt, 30));
      const affectedDates = [...new Set(dates.map(toDateStr))]
        .filter(date => validCalendarDate(date) && date > today && date <= lastDate).sort();
      const expected = new Map();
      for (const date of affectedDates) {
        const measured = await getScheduleQualityMeasurements({ date }, trx, capturedAt);
        if (measured.error) throw new Error('Schedule measurement failed');
        for (const day of measured.days) {
          for (const alert of buildRouteQualityAlerts(day, measured.driveModel)) {
            expected.set(`${day.date}:${alert.techId || 'unallocated'}`, alert);
          }
        }
      }
      const open = await trx('dispatch_alerts').where({ type: TYPE }).whereNull('resolved_at').select('id', 'tech_id', 'payload');
      const keep = new Set();
      const gateOff = () => Object.assign(new Error('Schedule quality alerts disabled'), { code: 'QUALITY_ALERTS_GATE_OFF' });
      if (!enabled()) throw gateOff();
      let resolved = 0;
      let created = 0;
      for (const alert of open) {
        const date = alert.payload?.date;
        // Future planning cards expire when the service day starts; today's
        // existing live-dispatch alerts own actual-progress exceptions.
        if (date > today && !affectedDates.includes(date)) continue;
        const key = `${date}:${alert.tech_id || 'unallocated'}`;
        const desired = expected.get(key);
        if (desired && !keep.has(key) && isDeepStrictEqual(alert.payload, desired.payload)) {
          keep.add(key);
        } else {
          if (await resolveAlert({ id: alert.id, trx })) resolved += 1;
        }
      }
      for (const [key, alert] of expected) {
        if (keep.has(key)) continue;
        await createAlert({ type: TYPE, severity: 'warn', ...alert, trx });
        created += 1;
      }
      // Roll back every card and suppress deferred socket emits on a kill
      // that arrived during an awaited write.
      if (!enabled()) throw gateOff();
      return { status: 'reconciled', created, resolved };
    }, { isolationLevel: 'read committed' });
  } catch (error) {
    if (error.code === 'QUALITY_ALERTS_GATE_OFF') return { status: 'gate_off' };
    logger.error(`[schedule-quality] Dispatch reconciliation failed (${error.code || 'check_or_alert_failure'})`);
    return { status: 'failed' };
  }
}

module.exports = { refreshScheduleQualityAlerts, buildRouteQualityAlerts };
