'use strict';

/**
 * Same-start visits check (owner 2026-11-19, "build check").
 *
 * Why: on 2026-11-19 the owner saw by eye that one customer's two services were
 * booked in one slot. A sweep then found eight more such days for two other
 * customers, and the owner had every one split so the services run back to
 * back, one hour each ("split all"; a visit is one hour, owner 2026-11-19).
 * Nothing had told the office about any of them. New pairs can still appear: a
 * plan's later visits copy the hour of the plan's first visit (the nightly
 * top-up and the series build), and a booking still gives a customer's second
 * service that day the same start (owner 2026-10-13: same start time, same
 * technician). This check tells the office about each one.
 *
 * WHAT COUNTS: two or more live (pending or confirmed) visits of one customer
 * on one day after today, with the same arrival-window start, for the same
 * technician or with one of them unassigned. Today is left out: by the 6:40 AM
 * run its route is set and its day-before text has gone. Two technicians at one
 * start are two people working at once, so they never count. A visit with no
 * arrival time is the no-window notice's (auto-dispatch/audit.js), and a
 * deleted or inactive customer's work is not checked here.
 *
 * ALERT: one needs-you Schedule bell per customer (docs/admin-notifications.md),
 * raised by the schedule-integrity watchdog's daily 6:40 ET run, under its gate,
 * its per-run ring cap (this class rings last) and its alert episodes. The bell
 * names the first day and the number of days, links to the first day's
 * schedule, and lists the days in its detail. A day that joins a standing bell
 * rings it again; a day that is fixed or gone updates it quietly. The bell
 * closes itself when no upcoming day of the customer has two visits at one
 * start (fixed, cancelled or past), and a pair that comes back rings again.
 * Read-only against scheduled_services: it writes nothing but the admin bell.
 */

const db = require('../models/db');
const logger = require('./logger');
const { dateOnlyString } = require('../utils/date-only');

// The bell's dedupe-key prefix. Only this check raises under it, so an open row
// under it is the watchdog's to close (closeResolvedAlerts).
const SAME_START_PREFIX = 'same-start-visits:';
// Statuses of a visit that is still to happen. A future visit is never en_route or on_site.
const LIVE_STATUSES = ['pending', 'confirmed'];
// Days named in the bell's detail; any more are counted, not listed.
const DETAIL_DAYS = 10;

// Every live visit after `todayET` (YYYY-MM-DD, Eastern) that shares its
// customer, day and arrival start with another live visit for the same
// technician, or with one of the two unassigned. One row per visit.
function findSameStartVisits(todayET) {
  return db('scheduled_services as a')
    .join('scheduled_services as b', function sameCustomerDayAndStart() {
      this.on('b.customer_id', '=', 'a.customer_id')
        .andOn('b.scheduled_date', '=', 'a.scheduled_date')
        .andOn('b.window_start', '=', 'a.window_start')
        .andOn('b.id', '<>', 'a.id');
    })
    .join('customers as c', 'c.id', 'a.customer_id')
    .whereIn('a.status', LIVE_STATUSES)
    .whereIn('b.status', LIVE_STATUSES)
    .where('a.scheduled_date', '>', todayET)
    .whereNull('c.deleted_at')
    .where(function activeCustomer() { this.where('c.active', true).orWhereNull('c.active'); })
    .where(function oneTechnician() {
      this.whereNull('a.technician_id').orWhereNull('b.technician_id').orWhereRaw('a.technician_id = b.technician_id');
    })
    .distinct('a.id', 'a.customer_id', 'a.scheduled_date', 'a.window_start', 'a.service_type', 'c.first_name', 'c.last_name')
    .orderBy([{ column: 'a.customer_id' }, { column: 'a.scheduled_date' }, { column: 'a.window_start' }, { column: 'a.id' }]);
}

const byText = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

// The finder's rows as one finding per customer: its days in date and start
// order, each day's visits in service order.
function groupByCustomer(rows) {
  const { fullName } = require('./admin-alert-names');
  const customers = new Map();
  for (const row of rows || []) {
    const date = dateOnlyString(row.scheduled_date);
    const start = String(row.window_start || '').slice(0, 5);
    if (!date || !/^\d{2}:\d{2}$/.test(start)) continue;
    const customerId = String(row.customer_id);
    if (!customers.has(customerId)) customers.set(customerId, { customerId, name: fullName(row), days: new Map() });
    const days = customers.get(customerId).days;
    const key = `${date} ${start}`;
    if (!days.has(key)) days.set(key, { key, date, start, visits: [] });
    days.get(key).visits.push({ id: String(row.id), serviceType: String(row.service_type || 'Service') });
  }
  return [...customers.values()].map((finding) => ({
    ...finding,
    days: [...finding.days.values()]
      .filter((day) => day.visits.length > 1)
      .sort((a, b) => byText(a.key, b.key))
      .map((day) => ({ ...day, visits: day.visits.sort((a, b) => byText(a.serviceType, b.serviceType) || byText(a.id, b.id)) })),
  })).filter((finding) => finding.days.length);
}

// "11 AM", "10:30 AM", "12 PM" from 'HH:MM'.
function timeWords(start) {
  const [hours, minutes] = start.split(':').map(Number);
  const hour = hours % 12 || 12;
  const half = hours >= 12 ? 'PM' : 'AM';
  return minutes ? `${hour}:${String(minutes).padStart(2, '0')} ${half}` : `${hour} ${half}`;
}

// "Dec 3", with the year when the day is in a later year than today ("Jan 11, 2027").
function dayWords(date, todayET) {
  const { shortDateET } = require('./admin-alert-names');
  const short = shortDateET(new Date(`${date}T12:00:00Z`));
  return date.slice(0, 4) > String(todayET).slice(0, 4) ? `${short}, ${date.slice(0, 4)}` : short;
}

// The detail: every day (up to DETAIL_DAYS) with its time and services.
function detailText(days, todayET) {
  const listed = days.slice(0, DETAIL_DAYS).map((day) => {
    const services = day.visits.map((v) => v.serviceType);
    const named = services.length > 2 ? `${services.slice(0, -1).join(', ')} and ${services[services.length - 1]}` : services.join(' and ');
    return `${dayWords(day.date, todayET)} at ${timeWords(day.start)}: ${named}.`;
  });
  const more = days.length - listed.length;
  return [...listed, ...(more > 0 ? [`And ${more} more ${more === 1 ? 'day' : 'days'}.`] : [])].join(' ');
}

// One finding's bell copy under docs/admin-notifications.md: the customer in the
// headline, the first day and time in the why, that day's schedule behind the
// link. A rule violation (an odd name) never costs the alert: it falls back to
// plain wording and keeps the valid structured parts.
function sameStartCopy(finding, todayET) {
  const names = require('./admin-alert-names');
  const compose = require('./admin-alert-compose');
  const [first] = finding.days;
  const when = `${dayWords(first.date, todayET)} at ${timeWords(first.start)}`;
  const why = finding.days.length === 1
    ? `${first.visits.length} visits start at ${timeWords(first.start)} on ${dayWords(first.date, todayET)}; split them so they run back to back, one hour each.`
    : `${finding.days.length} days have visits at the same time, first ${when}; split each so they run back to back.`;
  // The visit the office moves: the last of the first day's visits.
  const moveId = first.visits[first.visits.length - 1].id;
  const link = `/admin/dispatch?tab=schedule&date=${encodeURIComponent(first.date)}&appointment=${encodeURIComponent(moveId)}`;
  const detail = detailText(finding.days, todayET);
  const spec = {
    area: 'Schedule',
    action: names.fitAction('Schedule', finding.name || 'a customer',
      [(n) => `split ${n}'s visits at the same time`, (n) => `split ${n}'s same-time visits`]),
    why,
    severity: 'needs-you',
    link,
    subject: { type: 'customer', id: finding.customerId },
    doneWhen: 'visits_start_apart',
    who: 'person',
  };
  try {
    const composed = compose.composeAdminAlert(spec);
    return { title: composed.headline, why: composed.why, link: composed.link, detail, metadata: composed.metadata };
  } catch (err) {
    if (err.code !== 'ADMIN_ALERT_RULE') throw err;
    return {
      title: `Two visits start at the same time for ${finding.name || 'a customer'}`,
      why, link, detail,
      metadata: { ...compose.validStructuredFields(spec), ruleViolations: err.violations },
    };
  }
}

// One customer's alert in the watchdog's tuple form: [dedupeKey, title, body,
// metadata, options]. The refresh rings only when a day the standing bell did
// not list joins it; a fixed day updates the bell quietly.
function sameStartAlert(finding, todayET) {
  const copy = sameStartCopy(finding, todayET);
  const dayKeys = finding.days.map((day) => day.key);
  return [
    `${SAME_START_PREFIX}${finding.customerId}`,
    copy.title,
    copy.why,
    {
      customer_id: finding.customerId,
      first_date: finding.days[0].date,
      day_count: finding.days.length,
      day_keys: dayKeys,
      visit_ids: finding.days.flatMap((day) => day.visits.map((v) => v.id)),
      ...copy.metadata,
    },
    {
      link: copy.link,
      detail: copy.detail,
      refreshOnDedupe: true,
      ringOnRefresh: (_existing, existingMeta) => {
        const known = new Set(Array.isArray(existingMeta?.day_keys) ? existingMeta.day_keys : []);
        return dayKeys.some((key) => !known.has(key));
      },
    },
  ];
}

// The class's alerts, or a failed flag when the check threw (an unknown live
// set: the watchdog's close pass then leaves this class's standing bells alone).
async function sameStartVisitAlerts(todayET) {
  try {
    const findings = groupByCustomer(await findSameStartVisits(todayET));
    return { alerts: findings.map((finding) => sameStartAlert(finding, todayET)), failed: false };
  } catch (err) {
    logger.error(`[schedule-integrity] same-start visit check failed: ${err.message}`);
    return { alerts: [], failed: true };
  }
}

module.exports = {
  SAME_START_PREFIX,
  sameStartVisitAlerts,
  _findSameStartVisits: findSameStartVisits,
  _groupByCustomer: groupByCustomer,
  _sameStartCopy: sameStartCopy,
  _timeWords: timeWords,
};
