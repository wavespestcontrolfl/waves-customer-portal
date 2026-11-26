/**
 * Work and routes: four operating numbers a buyer of the business asks about, read live (no stored snapshot).
 * GET /api/admin/dashboard/ops-buyer-metrics returns them; the dashboard's "Work and routes" card shows them.
 * Read-only: it sends nothing, charges nothing and writes nothing.
 *
 *  1. Owner reliance
 *     a. the owner's field hours per week, last 4 and last 12 weeks. Source: the owner's time-clock shifts
 *        (time_entries, entry_type 'shift') when there are any in the 12 weeks; else the owner's completed stops x the
 *        job-costing standard minutes (JOB_COST_STANDARD: pest 25, lawn 20; other types keep their costed labor_hours)
 *        + the standard drive per stop (20 minutes). The payload carries both figures and names the one it used.
 *     b. the share of completed stops in the last 12 months done by someone other than the owner.
 *     The owner is the ONE assignable field technician with the admin role whose phone is a known owner phone
 *     (twilio.js isKnownOwnerPhone, the identity tech-open-visit-nudge.js already uses). No match, or more than one,
 *     makes both owner numbers unavailable (null plus a reason), never a zero or a 100% share.
 *  2. Revenue per route day: SUM(service_records.revenue) (the gross-margin tile's basis: every visit with a revenue
 *     figure) / distinct (technician, ET date) pairs with at least one completed stop. Last 12 months and 90 days.
 *  3. Route fill: scheduled (not cancelled, skipped, no-show or rescheduled) stops in the next 28 days / (route days
 *     available x 12). A route day is an active field technician on an open date: not a company closed day
 *     (scheduling/blackout-dates.js: one-off dates, weekly days off, the closed holidays) and not a technician absence
 *     (technician_absences, which carries birthdays and holiday taken days; plus, while GATE_TECH_WORK_DAYS is live,
 *     the weekdays outside the technician's work_days, both through absentTechDays like the scheduler). A technician with
 *     no work_days works every open day. 12 stops is the owner's full-day figure. Planning only, not a pay target.
 *  4. Return-visit rate, 12 months: completed stops that are callbacks or free returns (service_records.is_callback,
 *     scheduled_services.is_callback, followup_included, or a re-service by the shared classifier re-service.js isReService
 *     on the catalog key, name or service type, as production-share.js does) / all completed stops. The Callback Rate tile is unchanged.
 *
 * A stop is one physical visit: a grouped visit (scheduled_services.visit_id) counts once, a record with no group on
 * its own, the same rule as paidStopsForWindow in monthly-financial-snapshot.js. Every metric runs in its own
 * try/catch: a failed query returns null and an error note for that metric, never a 500.
 */
const logger = require('./logger');
const { applyAssignable, absentTechDays } = require('./technician-eligibility');
const { isReService } = require('./re-service');
const { NOT_A_ROUTE_STOP_STATUSES, placedOrLegacySql } = require('./stops-ahead');
const { getBlackoutDates } = require('./scheduling/blackout-dates');
const { addETDays, etDateString } = require('../utils/datetime-et');
const { STAFF_WORK_DATE_SQL } = require('../utils/staff-time-work-date');

const STOPS_PER_FULL_DAY = 12;
const ROUTE_WINDOW_DAYS = 28;
const YEAR_DAYS = 365;
const QUARTER_DAYS = 90;
const WEEKS_SHORT = 4;
const WEEKS_LONG = 12;

const STOP_KEY_SQL = 'COALESCE(ss.visit_id::text, sr.id::text)';
const TECH_SQL = 'COALESCE(sr.technician_id, ss.technician_id)';
const RETURN_VISIT_SQL = '(sr.is_callback IS TRUE OR ss.is_callback IS TRUE OR ss.followup_included IS TRUE)';

const num = (value) => Number(value) || 0;
const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const ratio = (top, bottom, places = 4) => (num(bottom) > 0 ? round(num(top) / num(bottom), places) : null);

// ---- Pure formulas (tested directly) ------------------------------------------------------------------------------

/** Hours per week over `weeks` weeks, or null for a window of no weeks. */
function hoursPerWeek(totalMinutes, weeks) {
  return weeks > 0 ? round(num(totalMinutes) / 60 / weeks, 1) : null;
}

/** Share of stops done by someone other than the owner, 0 to 1, or null with no attributed stops. */
function nonOwnerShare(ownerStops, otherStops) {
  return ratio(num(otherStops), num(ownerStops) + num(otherStops));
}

/** Revenue per route day, or null with no route days. */
function revenuePerRouteDay(revenue, routeDays) {
  return num(routeDays) > 0 ? round(num(revenue) / num(routeDays), 2) : null;
}

/** Scheduled stops over what the available route days could hold, or null with no route days. */
function routeFillRatio(scheduledStops, routeDays) {
  return ratio(scheduledStops, num(routeDays) * STOPS_PER_FULL_DAY);
}

/** Return visits over completed stops, or null with no stops. */
function returnVisitRatio(returnStops, completedStops) {
  return ratio(returnStops, completedStops);
}

/**
 * Minutes the owner's stops cost by the job-costing standard: the standard on-site time of EVERY service done at the stop
 * (a grouped visit sums its members) + one drive (`driveMinutes`) for the stop. `stops` = [{ members: [{ serviceType, laborHours }] }].
 */
function standardStopMinutes(stops, standard, driveMinutes) {
  const { standardLaborMinutesFor } = standard;
  return stops.reduce((sum, stop) => {
    const onSite = stop.members.reduce((acc, m) => acc + (standardLaborMinutesFor(m.serviceType) ?? (num(m.laborHours) * 60)), 0);
    return sum + onSite + driveMinutes;
  }, 0);
}

/**
 * Route days in a date list: for each date that is not a closed day, each technician who is not absent (or off by work
 * days) that date counts one. `techIds` = [id], `closedDates` a Set of YYYY-MM-DD, `absentKeys` a Set of `${techId}:${date}`
 * (absentTechDays: absences, plus work-days off days while GATE_TECH_WORK_DAYS is live).
 */
function countRouteDays({ techIds, dates, closedDates, absentKeys }) {
  let days = 0;
  for (const date of dates) {
    if (closedDates.has(date)) continue;
    for (const id of techIds) {
      if (!absentKeys.has(`${id}:${date}`)) days += 1;
    }
  }
  return days;
}

// ---- Windows ------------------------------------------------------------------------------------------------------

/** { from, to } ET calendar dates of the `days` days ending on (and including) today. */
function trailingWindow(now, days) {
  return { from: etDateString(addETDays(now, -(days - 1))), to: etDateString(now) };
}

function upcomingDates(now, days) {
  return Array.from({ length: days }, (_, i) => etDateString(addETDays(now, i)));
}

// ---- Queries ------------------------------------------------------------------------------------------------------

const completedStopsBase = (db, from, to) => db('service_records as sr')
  .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
  .where('sr.status', 'completed')
  .whereBetween('sr.service_date', [from, to]);

/**
 * The owner-operator's technician id: the ONE assignable field technician with the admin role whose phone is a known owner
 * phone. { id } on exactly one match, else { reason } (none, or several, so it cannot be told apart).
 */
async function resolveOwnerTechnician(db) {
  const { isKnownOwnerPhone } = require('./twilio');
  const rows = await applyAssignable(db('technicians')).where('role', 'admin').select('id', 'phone');
  const owners = rows.filter((row) => row.phone && isKnownOwnerPhone(row.phone));
  if (owners.length === 1) return { id: owners[0].id };
  return {
    reason: owners.length === 0
      ? 'No active field technician with the admin role has a known owner phone, so the owner cannot be told apart.'
      : 'More than one active field technician with the admin role has a known owner phone, so the owner cannot be told apart.',
  };
}

async function ownerClockMinutes(db, ownerId, from, to) {
  const row = await db('time_entries')
    .where('technician_id', ownerId)
    .where('entry_type', 'shift')
    .whereIn('status', ['completed', 'edited'])
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [from, to])
    .select(db.raw('COALESCE(SUM(duration_minutes), 0)::text AS minutes'), db.raw('COUNT(*)::text AS shifts'))
    .first();
  return { minutes: num(row && row.minutes), shifts: num(row && row.shifts) };
}

async function ownerStopRows(db, ownerId, from, to) {
  const rows = await completedStopsBase(db, from, to)
    .whereRaw(`${TECH_SQL} = ?`, [ownerId])
    .select(
      db.raw(`${STOP_KEY_SQL} AS stop_key`),
      'sr.service_type',
      'sr.labor_hours',
      db.raw("to_char(sr.service_date, 'YYYY-MM-DD') AS service_date"),
    );
  // One entry per physical stop; a grouped visit keeps every service done at it.
  const stops = new Map();
  for (const row of rows) {
    const stop = stops.get(row.stop_key) || { date: row.service_date, members: [] };
    stop.members.push({ serviceType: row.service_type, laborHours: row.labor_hours });
    stops.set(row.stop_key, stop);
  }
  return [...stops.values()];
}

/** The owner's weekly hours for the last 4 and 12 weeks, from the time clock when it has shifts, else from stops. */
async function ownerFieldHours(db, now, ownerId) {
  const standard = require('./job-costing');
  // The configured Average Drive Time (pricing_config global_drive_time), refreshed and read through job-costing, once per
  // calculation: the same minutes job-costing charges each stop.
  await standard.refreshDriveTimeSetting(db);
  const driveMinutes = standard.standardDriveMinutes();
  const short = trailingWindow(now, WEEKS_SHORT * 7);
  const long = trailingWindow(now, WEEKS_LONG * 7);
  const clockShort = await ownerClockMinutes(db, ownerId, short.from, short.to);
  const clockLong = await ownerClockMinutes(db, ownerId, long.from, long.to);
  const stops = await ownerStopRows(db, ownerId, long.from, long.to);
  const stopsShort = stops.filter((stop) => stop.date >= short.from);
  const estimate = {
    last4Weeks: hoursPerWeek(standardStopMinutes(stopsShort, standard, driveMinutes), WEEKS_SHORT),
    last12Weeks: hoursPerWeek(standardStopMinutes(stops, standard, driveMinutes), WEEKS_LONG),
  };
  const clock = {
    last4Weeks: hoursPerWeek(clockShort.minutes, WEEKS_SHORT),
    last12Weeks: hoursPerWeek(clockLong.minutes, WEEKS_LONG),
  };
  // Each window picks its own source from its own shift count: a quiet 4 weeks falls back to stops even when the 12 weeks
  // have shifts, and the reverse.
  const sources = {
    last4Weeks: clockShort.shifts > 0 ? 'time_clock' : 'stops_standard',
    last12Weeks: clockLong.shifts > 0 ? 'time_clock' : 'stops_standard',
  };
  const pick = (window) => (sources[window] === 'time_clock' ? clock[window] : estimate[window]);
  return {
    sources,
    driveMinutesPerStop: driveMinutes,
    last4Weeks: pick('last4Weeks'),
    last12Weeks: pick('last12Weeks'),
    timeClock: clock,
    stopsStandard: estimate,
    basis: 'Each window uses the owner\'s time-clock shifts (completed and edited entries, summed by work date, breaks not taken '
      + 'out) when it has any, divided by its weeks. A window with no owner shift instead uses the owner\'s completed stops x '
      + 'standard on-site minutes (pest 25, lawn 20; other types use their costed labor hours), every service of a grouped visit '
      + `counted, + the configured Average Drive Time (${driveMinutes} minutes now) once per stop. The card names the source of each window.`,
    windows: { last4Weeks: short, last12Weeks: long },
  };
}

/** Is this completed record a return visit: a callback flag, an included follow-up, or a re-service (re-service.js). */
const isReturnRecord = (row) => row.flagged === true || isReService({
  serviceKey: row.service_key, serviceName: row.service_name, serviceType: `${row.record_type || ''} ${row.visit_type || ''}`,
});

/**
 * Completed stops in the window: { stops, returnStops, stopTechs: [Set of technician ids per stop] }. One stop per
 * COALESCE(visit_id, record id); a stop is a return visit when any of its records is one (isReturnRecord). Every
 * technician with a record at the stop is kept, so attribution never depends on row order.
 */
async function completedStopCounts(db, from, to) {
  const rows = await completedStopsBase(db, from, to)
    .leftJoin('services as sv', 'sv.id', 'ss.service_id')
    .select(
      db.raw(`${STOP_KEY_SQL} AS stop_key`),
      db.raw(`${TECH_SQL} AS technician_id`),
      db.raw(`${RETURN_VISIT_SQL} AS flagged`),
      db.raw('COALESCE(sv.service_key, ss.service_key_snapshot) AS service_key'),
      'sv.name AS service_name',
      'sr.service_type AS record_type',
      'ss.service_type AS visit_type',
    );
  const stops = new Map();
  for (const row of rows) {
    const stop = stops.get(row.stop_key) || { techs: new Set(), returned: false };
    if (row.technician_id) stop.techs.add(row.technician_id);
    stop.returned = stop.returned || isReturnRecord(row);
    stops.set(row.stop_key, stop);
  }
  const all = [...stops.values()];
  return { stops: all.length, returnStops: all.filter((stop) => stop.returned).length, stopTechs: all.map((stop) => stop.techs) };
}

/**
 * Owner, other and unassigned stop counts. Rule: a stop the owner worked on in any record is an owner stop (the owner was
 * there); else a stop with another technician is an other stop; a stop with no technician is unassigned.
 */
function splitStopsByOwner(stopTechs, ownerId) {
  const split = { owner: 0, other: 0, unassigned: 0 };
  for (const techs of stopTechs) {
    if (techs.has(ownerId)) split.owner += 1;
    else if (techs.size > 0) split.other += 1;
    else split.unassigned += 1;
  }
  return split;
}

/** Owner reliance: weekly hours and the non-owner share of the last 12 months' completed stops. */
async function ownerReliance(db, now) {
  const year = trailingWindow(now, YEAR_DAYS);
  const owner = await resolveOwnerTechnician(db);
  if (!owner.id) return { ownerFieldHoursPerWeek: null, nonOwnerStopShare: null, unavailableReason: owner.reason };
  const hours = await ownerFieldHours(db, now, owner.id);
  const counts = await completedStopCounts(db, year.from, year.to);
  const split = splitStopsByOwner(counts.stopTechs, owner.id);
  return {
    ownerFieldHoursPerWeek: hours,
    nonOwnerStopShare: {
      share: nonOwnerShare(split.owner, split.other),
      ownerStops: split.owner,
      otherStops: split.other,
      unassignedStops: split.unassigned,
      window: year,
      basis: 'Completed stops done by someone other than the owner / completed stops with a technician on them. '
        + 'The owner is the one active field technician with the admin role and a known owner phone. '
        + 'A grouped stop the owner worked on in any record is an owner stop. Stops with no technician are left out.',
    },
  };
}

/** Revenue per route day for the last 12 months and the last 90 days. */
async function revenuePerRouteDayMetric(db, now) {
  const year = trailingWindow(now, YEAR_DAYS);
  const quarter = trailingWindow(now, QUARTER_DAYS);
  const row = await db('service_records as sr')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .whereBetween('sr.service_date', [year.from, year.to])
    .select(
      db.raw('COALESCE(SUM(sr.revenue), 0)::text AS revenue_year'),
      db.raw('COALESCE(SUM(sr.revenue) FILTER (WHERE sr.service_date >= ?::date), 0)::text AS revenue_quarter', [quarter.from]),
      db.raw(`COUNT(DISTINCT (${TECH_SQL})::text || '|' || sr.service_date::text)
        FILTER (WHERE sr.status = 'completed' AND ${TECH_SQL} IS NOT NULL)::text AS days_year`),
      db.raw(`COUNT(DISTINCT (${TECH_SQL})::text || '|' || sr.service_date::text)
        FILTER (WHERE sr.status = 'completed' AND ${TECH_SQL} IS NOT NULL AND sr.service_date >= ?::date)::text AS days_quarter`, [quarter.from]),
    )
    .first();
  const build = (window, revenue, routeDays) => ({
    window, revenue: round(num(revenue), 2), routeDays: num(routeDays), revenuePerRouteDay: revenuePerRouteDay(revenue, routeDays),
  });
  return {
    last12Months: build(year, row && row.revenue_year, row && row.days_year),
    last90Days: build(quarter, row && row.revenue_quarter, row && row.days_quarter),
    basis: 'Completed-job revenue (every visit with a revenue figure, as in the gross-margin tile) / route days. '
      + 'A route day is one technician on one ET date with at least one completed stop.',
  };
}

// One physical stop: a grouped visit (visit_id), else the same technician + customer + date + arrival window (stops-ahead.js
// counts such ungrouped siblings once), else the row itself (a row with no customer).
const SCHEDULED_STOP_KEY_SQL = `COALESCE(ss.visit_id::text, CASE WHEN ss.customer_id IS NULL THEN ss.id::text
  ELSE concat_ws('|', ss.technician_id::text, ss.customer_id::text, ss.scheduled_date::text, ss.window_start::text) END)`;

/**
 * Scheduled stops in [from, to]. Placement and status come from stops-ahead.js (a route stop is not cancelled, skipped, no-show
 * or rescheduled; a windowless row waiting on customer_pick_by or recurring_dispatch_due_date is not placed yet; a legacy
 * date-only stop stays), and an unclaimed estimate slot hold (no customer, a reservation expiry set; live or expired, the
 * predicate territory.js and tech-out.js use) is not a stop. Ungrouped siblings of one slot count once.
 */
async function scheduledStopCount(db, from, to) {
  const row = await db('scheduled_services as ss')
    .whereBetween('ss.scheduled_date', [from, to])
    .whereNotIn('ss.status', NOT_A_ROUTE_STOP_STATUSES)
    .whereRaw("(ss.track_state IS NULL OR ss.track_state <> 'cancelled')")
    .whereRaw(placedOrLegacySql('ss'))
    .whereRaw('NOT (ss.customer_id IS NULL AND ss.reservation_expires_at IS NOT NULL)')
    .select(db.raw(`COUNT(DISTINCT ${SCHEDULED_STOP_KEY_SQL})::text AS stops`))
    .first();
  return num(row && row.stops);
}

/** Route fill for the next 28 days. Planning only. */
async function routeFill(db, now) {
  const dates = upcomingDates(now, ROUTE_WINDOW_DAYS);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const techs = await applyAssignable(db('technicians')).select('id');
  const closedDates = await getBlackoutDates(from, to, db, { strict: true });
  const absentKeys = techs.length
    ? await absentTechDays(db, { dateFrom: from, dateTo: to, technicianIds: techs.map((t) => t.id) })
    : new Set();
  const routeDays = countRouteDays({ techIds: techs.map((t) => t.id), dates, closedDates, absentKeys });
  const scheduledStops = await scheduledStopCount(db, from, to);
  return {
    window: { from, to },
    scheduledStops,
    routeDaysAvailable: routeDays,
    stopsPerFullDay: STOPS_PER_FULL_DAY,
    fillRatio: routeFillRatio(scheduledStops, routeDays),
    activeTechnicians: techs.length,
    closedDays: [...closedDates].filter((d) => d >= from && d <= to).sort(),
    label: 'planning only, not a pay target',
    basis: 'Scheduled stops in the next 28 days (route stops by the stops-ahead rules: not cancelled, skipped, no-show or rescheduled; a windowless '
      + 'row still waiting to be placed is left out; same-slot siblings count once; an unclaimed estimate slot hold is left out) / (route days available x 12). '
      + 'Route days: each active field technician on each open day (no work-days list means every open day; a list counts only '
      + 'while the work-days setting is on), minus company closed days (weekly days off, one-off dates and the closed '
      + 'holidays) and technician absences.',
  };
}

/** Return-visit rate over the last 12 months. */
async function returnVisitRate(db, now) {
  const year = trailingWindow(now, YEAR_DAYS);
  const counts = await completedStopCounts(db, year.from, year.to);
  return {
    window: year,
    returnVisits: counts.returnStops,
    completedStops: counts.stops,
    rate: returnVisitRatio(counts.returnStops, counts.stops),
    basis: 'Completed stops that are callbacks, included follow-ups or catalog re-services / all completed stops. '
      + 'Not the same figure as the Callback Rate tile, which uses the dashboard period.',
  };
}

const METRICS = Object.freeze([
  ['ownerReliance', ownerReliance],
  ['revenuePerRouteDay', revenuePerRouteDayMetric],
  ['routeFill', routeFill],
  ['returnVisitRate', returnVisitRate],
]);

/** The four metrics. A metric that fails is null with an entry in `errors`; the others still return. */
async function buildOpsBuyerMetrics({ db, now = new Date() }) {
  const result = { generatedFor: etDateString(now), errors: {} };
  for (const [key, compute] of METRICS) {
    try {
      result[key] = await compute(db, now);
    } catch (err) {
      logger.error(`[ops-buyer-metrics] ${key} failed: ${err.message}`);
      result[key] = null;
      result.errors[key] = `${key} could not be read`;
    }
  }
  return result;
}

module.exports = {
  buildOpsBuyerMetrics,
  hoursPerWeek,
  nonOwnerShare,
  revenuePerRouteDay,
  routeFillRatio,
  returnVisitRatio,
  standardStopMinutes,
  countRouteDays,
  isReturnRecord,
  splitStopsByOwner,
  resolveOwnerTechnician,
  trailingWindow,
  STOPS_PER_FULL_DAY,
};
