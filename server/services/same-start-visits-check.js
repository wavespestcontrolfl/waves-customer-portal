'use strict';

/**
 * Same-start visits check (owner 2026-11-19, "build check").
 *
 * Why: on 2026-11-19 the owner saw by eye that one customer's two services were
 * booked in one slot. A sweep then found eight more such days for two other
 * customers, and the owner had every one split so the services run back to
 * back ("split all"; a visit is one hour unless set otherwise, owner
 * 2026-11-19).
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
 * start are two people working at once, so they never count. A visit the
 * tracker already reads complete or cancelled is not live, whatever its
 * status says. A time held for an estimate has no customer yet (the hold
 * discriminator in slot-reservation.js), so the customer join leaves it out; a
 * booked visit with a leftover hold stamp still counts. The services of one
 * legacy visit group (one visit_id, visit-groups.js) are
 * one stop that shares its start by design: they never pair with each other,
 * and beside a separate visit at that start they count as one. A visit with no
 * arrival time is the no-window notice's (auto-dispatch/audit.js), and a
 * deleted or inactive customer's work is not checked here.
 *
 * GROUPS: the visits at one start are one group per technician with two or
 * more of them there. An unassigned visit joins the one technician at its
 * start, or the other unassigned visits when no technician is there. Where two
 * or more technicians have visits at that start, its partner is not known yet:
 * it waits for a technician (unassigned-timed-visits-check.js, under
 * GATE_UNASSIGNED_VISIT_GUARD, names it from three days out), and the check then
 * judges it with that technician's visits.
 * A day is a calendar day: two groups on one date (two starts, or two
 * technicians' pairs at one start) are one day with two groups.
 *
 * ALERT: one needs-you Schedule bell per customer (docs/admin-notifications.md),
 * raised by the schedule-integrity watchdog's daily 6:40 ET run, under its gate,
 * its shared ring budget (this class rings after every other one, the
 * combined-booking check included, earliest first day first) and its alert
 * episodes. The bell names the
 * first day and the number of days, links to the first day's schedule, and
 * lists the days and their groups in its detail. Its itemKeys are every day,
 * listed in the detail or not, so a day that joins a standing bell rings it
 * again; a day that is fixed or gone updates it quietly. The bell closes itself
 * when no upcoming day of the customer has two visits at one start (fixed,
 * cancelled or past), and a pair that comes back rings again. Read-only against
 * scheduled_services: it writes nothing but the admin bell.
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
// technician, or with one of the two unassigned. One row per visit, with its
// technician, so the groups keep two technicians' pairs apart.
function findSameStartVisits(todayET) {
  const { TERMINAL_TRACK_STATES } = require('./customer-lifecycle-guard');
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
    // The tracker can lead `status`: a visit it already reads complete or
    // cancelled is not live work on either side (customer-lifecycle-guard.js).
    .where(function trackerLive() { this.whereNull('a.track_state').orWhereNotIn('a.track_state', TERMINAL_TRACK_STATES); })
    .where(function partnerTrackerLive() { this.whereNull('b.track_state').orWhereNotIn('b.track_state', TERMINAL_TRACK_STATES); })
    // The services of one visit group are one stop: a pair only across stops.
    .where(function twoStops() { this.whereNull('a.visit_id').orWhereNull('b.visit_id').orWhereRaw('a.visit_id <> b.visit_id'); })
    .distinct('a.id', 'a.customer_id', 'a.scheduled_date', 'a.window_start', 'a.service_type', 'a.technician_id', 'a.visit_id', 'c.first_name', 'c.last_name')
    .orderBy([{ column: 'a.customer_id' }, { column: 'a.scheduled_date' }, { column: 'a.window_start' }, { column: 'a.id' }]);
}

const byText = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
const byService = (a, b) => byText(a.serviceType, b.serviceType) || byText(a.id, b.id);
// The stops among some visits: a visit group's services are one stop.
const stopCount = (visits) => new Set(visits.map((visit) => visit.stopId)).size;

// One start's visits as groups that must be split: one group per technician
// with two or more visits there. An unassigned visit joins the one technician
// there (or the other unassigned visits); with two or more technicians there
// its partner is not known yet, so it joins no group (GROUPS above).
function startGroups(slot) {
  const byTechnician = new Map();
  const unassigned = [];
  for (const visit of slot.visits) {
    if (!visit.technicianId) { unassigned.push(visit); continue; }
    if (!byTechnician.has(visit.technicianId)) byTechnician.set(visit.technicianId, []);
    byTechnician.get(visit.technicianId).push(visit);
  }
  const groups = byTechnician.size > 1 ? [...byTechnician.values()] : [[...[...byTechnician.values()].flat(), ...unassigned]];
  return groups.filter((visits) => stopCount(visits) > 1).map((visits) => ({ start: slot.start, visits: [...visits].sort(byService) }));
}

// One customer's slots (date + start) as calendar days in date order, each
// day's groups in start order.
function daysOf(slots) {
  const days = new Map();
  for (const slot of slots) {
    for (const group of startGroups(slot)) {
      if (!days.has(slot.date)) days.set(slot.date, { date: slot.date, groups: [] });
      days.get(slot.date).groups.push(group);
    }
  }
  return [...days.values()]
    .sort((a, b) => byText(a.date, b.date))
    .map((day) => ({ ...day, groups: day.groups.sort((a, b) => byText(a.start, b.start) || byService(a.visits[0], b.visits[0])) }));
}

// The finder's rows as one finding per customer, with its days (daysOf). The
// findings come earliest first day first (then its first start), so a capped
// run spends its rings on the nearest days: tomorrow's pair is today's on the
// next run, and the finder leaves today out.
function groupByCustomer(rows) {
  const { fullName } = require('./admin-alert-names');
  const customers = new Map();
  for (const row of rows || []) {
    const date = dateOnlyString(row.scheduled_date);
    const start = String(row.window_start || '').slice(0, 5);
    if (!date || !/^\d{2}:\d{2}$/.test(start)) continue;
    const customerId = String(row.customer_id);
    if (!customers.has(customerId)) customers.set(customerId, { customerId, name: fullName(row), slots: new Map() });
    const slots = customers.get(customerId).slots;
    const key = `${date} ${start}`;
    if (!slots.has(key)) slots.set(key, { date, start, visits: [] });
    slots.get(key).visits.push({
      id: String(row.id), serviceType: String(row.service_type || 'Service'), technicianId: row.technician_id ? String(row.technician_id) : null,
      stopId: row.visit_id ? `group:${row.visit_id}` : String(row.id),
    });
  }
  const firstOf = (finding) => `${finding.days[0].date} ${finding.days[0].groups[0].start}`;
  return [...customers.values()]
    .map(({ slots, ...finding }) => ({ ...finding, days: daysOf([...slots.values()]) }))
    .filter((finding) => finding.days.length)
    .sort((a, b) => byText(firstOf(a), firstOf(b)) || byText(a.customerId, b.customerId));
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

const listWords = (names) => (names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' and '));

// One day in the detail: each group's start and services. A start that repeats
// on the day is a second technician's pair ("at 9 AM, another technician: ...").
function dayDetail(day, todayET) {
  const parts = day.groups.map((group, i) => {
    const repeat = i > 0 && day.groups[i - 1].start === group.start;
    return `at ${timeWords(group.start)}${repeat ? ', another technician' : ''}: ${listWords(group.visits.map((v) => v.serviceType))}`;
  });
  return `${dayWords(day.date, todayET)} ${parts.join('; ')}.`;
}

// The detail: every day (up to DETAIL_DAYS) with its groups.
function detailText(days, todayET) {
  const listed = days.slice(0, DETAIL_DAYS).map((day) => dayDetail(day, todayET));
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
  const [firstGroup] = first.groups;
  const day = dayWords(first.date, todayET);
  // A visit group counts once: its services are one stop.
  const visitCount = first.groups.reduce((n, group) => n + stopCount(group.visits), 0);
  let why = `${finding.days.length} days have visits at the same time, first ${day} at ${timeWords(firstGroup.start)}; split each so they run back to back.`;
  if (finding.days.length === 1 && first.groups.length === 1) {
    why = `${visitCount} visits start at ${timeWords(firstGroup.start)} on ${day}; split them so they run back to back.`;
  } else if (finding.days.length === 1) {
    why = `${visitCount} visits on ${day} share a start time with another visit; split them so they run back to back.`;
  }
  // The visit the office moves: the last of the first day's first group that is
  // not in a visit group (else the last one).
  const moveId = ([...firstGroup.visits].reverse().find((v) => v.stopId === v.id) || firstGroup.visits[firstGroup.visits.length - 1]).id;
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
// metadata, options]. itemKeys are every day (YYYY-MM-DD), listed in the
// detail or not: notifyAdmin refreshes a standing bell when they change
// (RING_METADATA_KEYS), and the refresh rings only when a day the bell did not
// carry joins it; a fixed day updates the bell quietly.
function sameStartAlert(finding, todayET) {
  const copy = sameStartCopy(finding, todayET);
  const dates = finding.days.map((day) => day.date);
  return [
    `${SAME_START_PREFIX}${finding.customerId}`,
    copy.title,
    copy.why,
    {
      customer_id: finding.customerId,
      first_date: dates[0],
      day_count: dates.length,
      itemKeys: dates,
      visit_ids: finding.days.flatMap((day) => day.groups.flatMap((group) => group.visits.map((v) => v.id))),
      ...copy.metadata,
    },
    {
      link: copy.link,
      detail: copy.detail,
      refreshOnDedupe: true,
      ringOnRefresh: (_existing, existingMeta) => {
        const known = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys : []);
        return dates.some((date) => !known.has(date));
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
