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

// GET /api/admin/dispatch/alerts returns the newest 50 rows by default, and
// this generator can see every technician on every future date it checks.
// Uncapped, one overnight pass over nine technicians and six dates writes 54
// cards and pushes unresolved alerts of every other type — critical ones
// included — off the end of the morning Action Queue.
//
// The cap is PER DATE rather than per pass or per queue, because a date is
// reconciled whole by whichever check reaches it: a nightly six-date pass and
// a one-date pass after a schedule edit must agree on that date's cards, or
// they would resolve and recreate each other's work every run. Six dates
// therefore cost at most 18 rows, and cards expire as their service day
// arrives.
const MAX_CARDS_PER_DATE = 3;

// Overflow rides in the payload because the row itself carries no technician:
// keying it apart from a date's unallocated-work card keeps the two
// reconcilable side by side.
const cardKey = (date, techId, overflow) => `${date}:${overflow ? 'overflow' : (techId || 'unallocated')}`;

// Within a date: the day's shared card (unallocated work, a configured
// closure) ahead of its technicians, then the busiest routes. Deterministic,
// so a repeated check keeps the same cards open.
function cardPriority([, a], [, b]) {
  if (!a.techId !== !b.techId) return a.techId ? 1 : -1;
  if (a.payload.issues.length !== b.payload.issues.length) return b.payload.issues.length - a.payload.issues.length;
  return String(a.techId).localeCompare(String(b.techId));
}

// Trim each date in place, leaving one slot for the summary card that names
// how much of that day was left out so an operator still sees there is more.
function capRouteQualityCards(expected, limit = MAX_CARDS_PER_DATE) {
  const byDate = new Map();
  for (const entry of expected) {
    const date = entry[1].payload.date;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(entry);
  }
  for (const [date, entries] of byDate) {
    if (entries.length <= limit) continue;
    entries.sort(cardPriority);
    for (const [key] of entries.slice(limit - 1)) expected.delete(key);
    const omitted = entries.length - (limit - 1);
    expected.set(cardKey(date, null, true), { techId: null, payload: { date, overflow: true,
      issues: [`${omitted} more route${omitted === 1 ? '' : 's'} on ${date} need review. Open the schedule for that day.`] } });
  }
  return expected;
}

// One technician's unresolved exceptions for a day, plus the modeled-late
// count: lateness is a claim about timing, so it needs a calibrated drive
// model AND a known duration for every stop before it can be made.
function technicianRouteIssues(quality, driveModel) {
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
  return { issues, late };
}

function buildRouteQualityAlerts(day, driveModel) {
  const alerts = [];
  for (const quality of day.byTech) {
    const { issues, late } = technicianRouteIssues(quality, driveModel);
    // The technician's name belongs on this admin-room card: the
    // dispatch:alert broadcast carries the bare row without the joined
    // tech_name, so without it two live route cards for the same day are
    // indistinguishable until the board is reloaded. The measurement ledger
    // still stores technician ids alone.
    if (issues.length) alerts.push({ techId: quality.technicianId, payload: {
      date: day.date, ...(quality.technician ? { techName: quality.technician } : {}),
      issues, ...(late ? { departureMinutes: quality.assumptions.departureMinutes } : {}),
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
            expected.set(cardKey(day.date, alert.techId), alert);
          }
        }
      }
      capRouteQualityCards(expected);
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
        const key = cardKey(date, alert.tech_id, alert.payload?.overflow);
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

module.exports = { refreshScheduleQualityAlerts, buildRouteQualityAlerts, capRouteQualityCards, MAX_CARDS_PER_DATE };
