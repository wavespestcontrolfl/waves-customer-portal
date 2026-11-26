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
 *     The owner is a technicians row with role 'admin' (the owner-operator is the one admin who also works the field).
 *  2. Revenue per route day: SUM(service_records.revenue) (the gross-margin tile's basis: every visit with a revenue
 *     figure) / distinct (technician, ET date) pairs with at least one completed stop. Last 12 months and 90 days.
 *  3. Route fill: scheduled (not cancelled, skipped, no-show or rescheduled) stops in the next 28 days / (route days
 *     available x 12). A route day is an active field technician on a date they work (technicians.work_days, else
 *     Monday to Friday), not a company closed day (scheduling/blackout-dates.js: one-off dates, weekly days off, the
 *     closed holidays) and not a technician absence (technician_absences, which carries birthdays and holiday taken
 *     days). 12 stops is the owner's full-day figure. Planning only, not a pay target.
 *  4. Return-visit rate, 12 months: completed stops that are callbacks or free returns (service_records.is_callback,
 *     scheduled_services.is_callback, followup_included) / all completed stops. The Callback Rate tile is unchanged.
 *
 * A stop is one physical visit: a grouped visit (scheduled_services.visit_id) counts once, a record with no group on
 * its own, the same rule as paidStopsForWindow in monthly-financial-snapshot.js. Every metric runs in its own
 * try/catch: a failed query returns null and an error note for that metric, never a 500.
 */
const logger = require('./logger');
const { applyAssignable, absentTechDays, normalizeWorkDays, dayOfWeekOfDate } = require('./technician-eligibility');
const { getBlackoutDates } = require('./scheduling/blackout-dates');
const { addETDays, etDateString } = require('../utils/datetime-et');
const { STAFF_WORK_DATE_SQL } = require('../utils/staff-time-work-date');

const STOPS_PER_FULL_DAY = 12;
const ROUTE_WINDOW_DAYS = 28;
const YEAR_DAYS = 365;
const QUARTER_DAYS = 90;
const WEEKS_SHORT = 4;
const WEEKS_LONG = 12;
// No work-days list: the technician works Monday to Friday (0 = Sunday). A closed weekly day off still applies on top.
const DEFAULT_WORK_DAYS = Object.freeze([1, 2, 3, 4, 5]);
// Visit statuses that are not a stop on a route (same list as job-costing's PREPAY_UNCOUNTED_VISIT_STATUSES).
const NOT_A_STOP_STATUSES = ['cancelled', 'canceled', 'no_show', 'skipped', 'rescheduled'];

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

/** Minutes the owner's stops cost by the job-costing standard: each stop's standard on-site time + one standard drive. */
function standardStopMinutes(stops, standard) {
  const { standardLaborMinutesFor, JOB_COST_STANDARD } = standard;
  return stops.reduce((sum, stop) => {
    const onSite = standardLaborMinutesFor(stop.serviceType) ?? (num(stop.laborHours) * 60);
    return sum + onSite + JOB_COST_STANDARD.defaultDriveMinutes;
  }, 0);
}

/**
 * Route days in a date list: for each date that is not a closed day, each technician whose work days include the weekday
 * and who is not absent that date counts one. `techs` = [{ id, work_days }], `closedDates` a Set of YYYY-MM-DD,
 * `absentKeys` a Set of `${techId}:${date}`.
 */
function countRouteDays({ techs, dates, closedDates, absentKeys }) {
  let days = 0;
  for (const date of dates) {
    if (closedDates.has(date)) continue;
    const dow = dayOfWeekOfDate(date);
    for (const tech of techs) {
      const works = normalizeWorkDays(tech.work_days) || DEFAULT_WORK_DAYS;
      if (works.includes(dow) && !absentKeys.has(`${tech.id}:${date}`)) days += 1;
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

async function ownerTechnicianIds(db) {
  const rows = await db('technicians').where('role', 'admin').select('id');
  return rows.map((row) => row.id);
}

async function ownerClockMinutes(db, ownerIds, from, to) {
  if (!ownerIds.length) return { minutes: 0, shifts: 0 };
  const row = await db('time_entries')
    .whereIn('technician_id', ownerIds)
    .where('entry_type', 'shift')
    .whereIn('status', ['completed', 'edited'])
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [from, to])
    .select(db.raw('COALESCE(SUM(duration_minutes), 0)::text AS minutes'), db.raw('COUNT(*)::text AS shifts'))
    .first();
  return { minutes: num(row && row.minutes), shifts: num(row && row.shifts) };
}

async function ownerStopRows(db, ownerIds, from, to) {
  if (!ownerIds.length) return [];
  const rows = await completedStopsBase(db, from, to)
    .whereRaw(`${TECH_SQL} IN (${ownerIds.map(() => '?').join(', ')})`, ownerIds)
    .select(
      db.raw(`${STOP_KEY_SQL} AS stop_key`),
      'sr.service_type',
      'sr.labor_hours',
      db.raw("to_char(sr.service_date, 'YYYY-MM-DD') AS service_date"),
    );
  // One row per physical stop (a grouped visit's services book one stop and its longest costed time).
  const stops = new Map();
  for (const row of rows) {
    const prior = stops.get(row.stop_key);
    if (!prior || num(row.labor_hours) > num(prior.laborHours)) {
      stops.set(row.stop_key, { serviceType: row.service_type, laborHours: row.labor_hours, date: row.service_date });
    }
  }
  return [...stops.values()];
}

/** The owner's weekly hours for the last 4 and 12 weeks, from the time clock when it has shifts, else from stops. */
async function ownerFieldHours(db, now, ids) {
  const standard = require('./job-costing');
  const short = trailingWindow(now, WEEKS_SHORT * 7);
  const long = trailingWindow(now, WEEKS_LONG * 7);
  const clockShort = await ownerClockMinutes(db, ids, short.from, short.to);
  const clockLong = await ownerClockMinutes(db, ids, long.from, long.to);
  const stops = await ownerStopRows(db, ids, long.from, long.to);
  const stopsShort = stops.filter((stop) => stop.date >= short.from);
  const estimate = {
    last4Weeks: hoursPerWeek(standardStopMinutes(stopsShort, standard), WEEKS_SHORT),
    last12Weeks: hoursPerWeek(standardStopMinutes(stops, standard), WEEKS_LONG),
  };
  const clock = {
    last4Weeks: hoursPerWeek(clockShort.minutes, WEEKS_SHORT),
    last12Weeks: hoursPerWeek(clockLong.minutes, WEEKS_LONG),
  };
  const useClock = clockLong.shifts > 0;
  return {
    ownerFound: ids.length > 0,
    source: useClock ? 'time_clock' : 'stops_standard',
    last4Weeks: useClock ? clock.last4Weeks : estimate.last4Weeks,
    last12Weeks: useClock ? clock.last12Weeks : estimate.last12Weeks,
    timeClock: clock,
    stopsStandard: estimate,
    basis: useClock
      ? 'Owner shifts on the time clock, completed and edited entries, summed by work date and divided by the weeks '
        + '(4 and 12). Shift time as clocked: breaks are not taken out.'
      : 'No owner time-clock shifts in the last 12 weeks, so: the owner\'s completed stops x standard on-site minutes '
        + '(pest 25, lawn 20; other types use their costed labor hours) + 20 minutes of drive per stop, divided by the weeks.',
    windows: { last4Weeks: short, last12Weeks: long },
  };
}

/** Per-technician completed stops (and return visits) in the window, plus the overall totals. */
async function completedStopCounts(db, from, to) {
  const totals = await completedStopsBase(db, from, to)
    .select(
      db.raw(`COUNT(DISTINCT ${STOP_KEY_SQL})::text AS stops`),
      db.raw(`COUNT(DISTINCT ${STOP_KEY_SQL}) FILTER (WHERE ${RETURN_VISIT_SQL})::text AS return_stops`),
    )
    .first();
  const byTech = await completedStopsBase(db, from, to)
    .select(db.raw(`${TECH_SQL} AS technician_id`), db.raw(`COUNT(DISTINCT ${STOP_KEY_SQL})::text AS stops`))
    .groupByRaw(TECH_SQL);
  return {
    stops: num(totals && totals.stops),
    returnStops: num(totals && totals.return_stops),
    byTech: byTech.map((row) => ({ technicianId: row.technician_id, stops: num(row.stops) })),
  };
}

/** Owner reliance: weekly hours and the non-owner share of the last 12 months' completed stops. */
async function ownerReliance(db, now) {
  const year = trailingWindow(now, YEAR_DAYS);
  const ownerIds = await ownerTechnicianIds(db);
  const hours = await ownerFieldHours(db, now, ownerIds);
  const ids = new Set(ownerIds);
  const counts = await completedStopCounts(db, year.from, year.to);
  const split = counts.byTech.reduce((acc, row) => {
    if (!row.technicianId) acc.unassigned += row.stops;
    else if (ids.has(row.technicianId)) acc.owner += row.stops;
    else acc.other += row.stops;
    return acc;
  }, { owner: 0, other: 0, unassigned: 0 });
  return {
    ownerFieldHoursPerWeek: hours,
    nonOwnerStopShare: {
      share: nonOwnerShare(split.owner, split.other),
      ownerStops: split.owner,
      otherStops: split.other,
      unassignedStops: split.unassigned,
      window: year,
      basis: 'Completed stops done by someone other than the owner / completed stops with a technician on them. '
        + 'The owner is a technician account with the admin role. Stops with no technician are left out.',
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

async function scheduledStopCount(db, from, to) {
  const row = await db('scheduled_services as ss')
    .whereBetween('ss.scheduled_date', [from, to])
    .whereNotIn('ss.status', NOT_A_STOP_STATUSES)
    .select(db.raw('COUNT(DISTINCT COALESCE(ss.visit_id::text, ss.id::text))::text AS stops'))
    .first();
  return num(row && row.stops);
}

/** Route fill for the next 28 days. Planning only. */
async function routeFill(db, now) {
  const dates = upcomingDates(now, ROUTE_WINDOW_DAYS);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const techs = await applyAssignable(db('technicians')).select('id', 'work_days');
  const closedDates = await getBlackoutDates(from, to, db, { strict: true });
  const absentKeys = techs.length
    ? await absentTechDays(db, { dateFrom: from, dateTo: to, technicianIds: techs.map((t) => t.id), includeOffDays: false })
    : new Set();
  const routeDays = countRouteDays({ techs, dates, closedDates, absentKeys });
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
    basis: 'Scheduled stops (not cancelled, skipped, no-show or rescheduled) in the next 28 days / (route days available x 12). '
      + 'Route days: each active field technician on each day they work (their work days, else Monday to Friday), '
      + 'minus company closed days (weekly days off, one-off dates and the closed holidays) and technician absences.',
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
    basis: 'Completed stops that are callbacks or free return visits (is_callback, included follow-up) / all completed stops. '
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
  trailingWindow,
  STOPS_PER_FULL_DAY,
};
