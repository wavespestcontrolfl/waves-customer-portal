'use strict';

/**
 * Weekly near-stops check (owner 2026-11-19, "check" on the scope page
 * "Next-Door and Nearby Stops"). Each Monday ONE read-only owner notification
 * with parts 1 and 3 of that page:
 *
 *   1. Next-door stops booked apart in the next 30 days: two stops 0.1 mile or
 *      closer (any customers), or one customer's two homes half a mile or
 *      closer. Each line says what holds each visit where it is, read from
 *      the night run's own log line for that visit (auto_dispatch_audit_logs).
 *   3. Truck GPS minutes for visit-to-visit drives under half a mile
 *      (visit_gps_legs), one drive per stop: the evidence a short-hop drive
 *      price would need.
 *
 * Part 2 of the page (last week's bookings that took a costlier hour) is not
 * built here. It needs the calendar as it stood at each booking, and the app
 * keeps no history of a visit's fields (window edits, status restores, holds the
 * sweep deleted, closed-day edits), so a replay from the logs is never exact.
 *
 * It moves no visit, texts nobody and calls no paid API: its one drive price is
 * the app's model (auto-dispatch/geo.js milesToDriveMinutes), never a road lookup.
 * Writes: its own bell row (deliverOpsDigest, owner audience, one a week; the
 * next week's row replaces it) and the weekly marker in ops_email_send_state.
 * No email: the owner asked for one admin notification.
 *
 * Cron: Monday 6:17am ET in scheduler.js inside runExclusive, plus a Monday and
 * Tuesday 11:17am catch-up that runs only while this week's marker is missing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');
const { haversine, resolveGeo, milesToDriveMinutes } = require('./auto-dispatch/geo');
const { daysBetween } = require('./auto-dispatch/route-tiers');
const { shiftDateStr } = require('./auto-dispatch/dates');
const { FLEX_TIER_RADIUS_DAYS } = require('./auto-dispatch/flex-tier');
const { NIGHT_TRIGGERS, FINISHED_STATUSES } = require('./auto-dispatch/catch-up');
const { NOT_A_ROUTE_STOP_STATUSES } = require('./stops-ahead');
const {
  etDateString, etWeekStart, addETDays, parseETDateTime, formatETDayDate, formatETTime,
} = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

const OPS_KEY = 'near-stops-weekly';
const LINK = '/admin/schedule';
const AREA = 'Schedule';
const LOOKAHEAD_DAYS = 30;
const NEXT_DOOR_MILES = 0.1; // about 528 feet, any two customers
const OWN_HOMES_MILES = 0.5; // one customer's two homes
const SAME_PLACE_MILES = 0.003; // about 16 feet: one customer's stops at one home
const SHORT_DRIVE_MILES = 0.5;
const NIGHT_LOG_HOURS = 36;
const MAX_LINES = 3;
const SUMMARY_MAX = 110;
const DETAIL_MAX = 2000;

// The night run's skip and keep reasons (auto_dispatch_audit_logs.reason_code), in
// the owner's words, from each code's own reason_description. An unknown code
// falls back to its own words, lower case.
const HOLD_WORDS = {
  NO_SCORE_IMPROVEMENT: 'no other day scored better',
  NO_VALID_SLOT: 'no open slot in reach',
  NO_SLOT_MATCHING_PREFERENCE: "no slot fits the customer's day or time wish",
  NO_DRIVE_SAVING: 'no move saved enough drive',
  NO_ROAD_DRIVE_SAVING: 'real roads showed no saving',
  PERSON_PLACED: 'staff picked the day',
  PERSON_PLACED_UNKNOWN: 'staff may have picked the day',
  REMINDER_SENT_FROZEN: 'customer already told the time',
  CUSTOMER_CONFIRMED: 'customer confirmed',
  MOVE_LIMIT_REACHED: 'night run moved it twice already',
  REMINDER_24H_OFF: '24-hour reminder off',
  NO_ARRIVAL_WINDOW: 'no arrival time yet',
  MAX_CHANGES_REACHED: "the night's move cap was reached",
  PROOFREADER_UNSURE: 'move proofreader held it',
  PROOFREADER_HOLD: 'move proofreader held it',
  PROOFREADER_NOT_ASKED: 'move proofreader held it',
  CONFLICT_NO_NEAR_SLOT: 'no near slot for its conflict',
  DRIFT_ANCHOR_STALE: 'plan date anchor out of date',
  SOUTH_DAY_KEPT: 'kept off far-south route days',
  CUSTOMER_INACTIVE: 'customer inactive',
  MISSING_GEO: 'no map pin',
  MANUALLY_LOCKED: 'locked by staff',
  AUTO_DISPATCH_EXCLUDED: 'excluded by staff',
  CHANGE_APPLIED: 'the night run moved it there',
};

// ---------------------------------------------------------------- formatting

const ms = (value) => new Date(value).getTime();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function shortName(row) {
  const first = String(row?.first_name || '').trim();
  const last = String(row?.last_name || '').trim();
  return [first, last ? `${last[0].toUpperCase()}.` : ''].filter(Boolean).join(' ') || 'A customer';
}

function hhmm(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

function dayLabel(dateStr) {
  return formatETDayDate(parseETDateTime(`${dateStr}T12:00`));
}

function timeLabel(dateStr, start) {
  return start ? formatETTime(parseETDateTime(`${dateStr}T${start}`)) : 'no time yet';
}

function whenLabel(dateStr, start) {
  return `${dayLabel(dateStr)} ${timeLabel(dateStr, start)}`;
}

function distanceLabel(miles) {
  if (miles >= 0.1) return `${miles.toFixed(1)} mi`;
  return `about ${Math.max(10, Math.round((miles * 5280) / 10) * 10)} ft`;
}

// ------------------------------------------------- part 1: next-door splits

function toVisit(row, geo) {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    date: dateOnlyString(row.scheduled_date),
    windowStart: hhmm(row.window_start),
    tech: row.technician_id ? String(row.technician_id) : null,
    planChild: row.recurring_parent_id != null, // a plan's own later visit or booster
    lat: geo.lat,
    lng: geo.lng,
  };
}

// One place per home: a customer's stops within SAME_PLACE_MILES share one.
function buildPlaces(rows) {
  const places = [];
  for (const row of rows) {
    const geo = resolveGeo(row);
    if (!geo) continue;
    const visit = toVisit(row, geo);
    let place = places.find((p) => p.customerId === visit.customerId
      && haversine(p.lat, p.lng, geo.lat, geo.lng) <= SAME_PLACE_MILES);
    if (!place) {
      place = {
        customerId: visit.customerId,
        lat: geo.lat,
        lng: geo.lng,
        name: shortName(row),
        city: row.service_address_city || row.customer_city || null,
        visits: [],
      };
      places.push(place);
    }
    visit.placeName = place.name;
    visit.city = place.city;
    place.visits.push(visit);
  }
  return places;
}

function nearPairs(places) {
  const pairs = [];
  for (let i = 0; i < places.length; i += 1) {
    for (let j = i + 1; j < places.length; j += 1) {
      const a = places[i];
      const b = places[j];
      const sameCustomer = a.customerId === b.customerId;
      const miles = haversine(a.lat, a.lng, b.lat, b.lng);
      if (miles <= (sameCustomer ? OWN_HOMES_MILES : NEXT_DOOR_MILES)) pairs.push({ a, b, miles, sameCustomer });
    }
  }
  return pairs;
}

function nearestVisit(visit, others) {
  let best = null;
  for (const other of others) {
    const gap = Math.abs(daysBetween(visit.date, other.date));
    if (!best || gap < best.gap || (gap === best.gap && other.date < best.visit.date)) best = { visit: other, gap };
  }
  return best ? best.visit : null;
}

const slotKey = (v) => `${v.date} ${v.windowStart || '99:99'}`;

// Each visit of the place with fewer visits meets the nearest-dated visit of the
// other place, so a monthly plan beside a two-monthly one pairs its nearer round,
// not both. Each match comes back earlier visit first; the matches soonest first.
function matchVisits(pair) {
  const [few, many] = pair.a.visits.length <= pair.b.visits.length ? [pair.a, pair.b] : [pair.b, pair.a];
  const matches = [];
  for (const visit of few.visits) {
    const near = nearestVisit(visit, many.visits);
    if (near) matches.push([visit, near].sort((x, y) => slotKey(x).localeCompare(slotKey(y))));
  }
  return matches.sort((x, y) => slotKey(x[0]).localeCompare(slotKey(y[0])));
}

// An unassigned stop (no technician) may be on either route, so it counts.
const sameRoute = (a, b) => !a || !b || a === b;

// A stop at one of the two paired homes is part of the pair; any other stop on
// the route between them splits them, a third home of the same customer too.
function atPairHome(stop, pair) {
  return [pair.a, pair.b].some((home) => home.customerId === stop.customerId && stop.geo
    && haversine(home.lat, home.lng, stop.geo.lat, stop.geo.lng) <= SAME_PLACE_MILES);
}

// A combined visit (two services at one home and hour) is one stop.
function stopsBetween(dayStops, first, second, pair) {
  const routeTech = first.tech || second.tech;
  const between = dayStops.filter((s) => sameRoute(s.tech, routeTech) && !atPairHome(s, pair)
    && s.windowStart > first.windowStart && s.windowStart < second.windowStart);
  return new Set(between.map((s) => `${s.customerId}|${s.windowStart}`)).size;
}

// Every timed stop by day, with or without a map pin: a stop between two homes
// splits them even when it cannot be placed on the map.
function stopsByDayOf(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const windowStart = hhmm(row.window_start);
    if (!windowStart) continue;
    const date = dateOnlyString(row.scheduled_date);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push({
      customerId: String(row.customer_id), tech: row.technician_id ? String(row.technician_id) : null, windowStart,
      geo: resolveGeo(row),
    });
  }
  return byDay;
}

// How one matched pair sits on the calendar. Null = not a split to report: together
// (one day, one technician, back to back), not judged (a visit has no time yet), or
// the 4:40 AM day re-plan's to order (two customers' stops on one day; the re-plan
// re-times those, and holds only one customer's own stops at their hours).
function splitOf(first, second, pair, stopsByDay) {
  if (first.date !== second.date) return { gap: daysBetween(first.date, second.date) };
  if (!first.windowStart || !second.windowStart) return null;
  if (first.tech && second.tech && first.tech !== second.tech) return { twoTechs: true };
  const between = stopsBetween(stopsByDay.get(first.date) || [], first, second, pair);
  if (between === 0 || !pair.sameCustomer) return null;
  return { between };
}

const gapOf = (p) => p.gap ?? 0;

function findApartPairs(rows) {
  const places = buildPlaces(rows);
  const stopsByDay = stopsByDayOf(rows);
  const apart = [];
  for (const pair of nearPairs(places)) {
    const hit = matchVisits(pair)
      .map(([first, second]) => ({ first, second, split: splitOf(first, second, pair, stopsByDay) }))
      .find((m) => m.split);
    if (hit) apart.push({ ...pair, first: hit.first, second: hit.second, ...hit.split });
  }
  // Same-day splits first, then the pairs the fewest days apart: the easiest to join.
  return apart.sort((x, y) => gapOf(x) - gapOf(y) || slotKey(x.first).localeCompare(slotKey(y.first)));
}

function holdFor(visit, nightLog) {
  if (!visit.planChild) return 'first or one-time visit';
  if (!nightLog) return 'no night run to read';
  const row = nightLog.get(visit.id);
  if (!row) return 'not in the night run';
  const code = String(row.reason_code || row.action || 'no reason logged');
  return HOLD_WORDS[code] || code.toLowerCase().replace(/_/g, ' ');
}

function splitLabel(p) {
  if (p.twoTechs) return 'same day, two technicians';
  if (p.between != null) return `same day, ${plural(p.between, 'stop')} between`;
  const reach = p.gap > FLEX_TIER_RADIUS_DAYS ? `, past the night run's ${FLEX_TIER_RADIUS_DAYS}-day reach` : '';
  return `${plural(p.gap, 'day')} apart${reach}`;
}

// Each visit's time, with what holds that visit where it is.
function visitWords(visit, nightLog, withDay) {
  const when = withDay ? whenLabel(visit.date, visit.windowStart) : timeLabel(visit.date, visit.windowStart);
  return `${when} (${holdFor(visit, nightLog)})`;
}

function pairLine(p, nightLog) {
  const who = p.sameCustomer ? `${p.first.placeName}'s two homes` : `${p.first.placeName} and ${p.second.placeName}`;
  const lead = `- ${who}${p.first.city ? ` (${p.first.city})` : ''}, ${distanceLabel(p.miles)} apart: `;
  if (p.between != null) {
    return `${lead}${whenLabel(p.first.date, p.first.windowStart)} and ${timeLabel(p.second.date, p.second.windowStart)}, `
      + `${splitLabel(p)}; the 4:40 AM re-plan keeps one customer's own hours.`;
  }
  const sameDay = p.first.date === p.second.date;
  return `${lead}${visitWords(p.first, nightLog, true)} and ${visitWords(p.second, nightLog, !sameDay)}, ${splitLabel(p)}.`;
}

// ---------------------------------------------------- part 3: short GPS drives

// One physical drive per stop: trip-link writes a combined visit's inbound leg
// on each of its service rows, so a stop's arrival (technician, day, arrival
// time; else its visit group) counts once.
function physicalLegs(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const stop = row.gps_arrived_at ? ms(row.gps_arrived_at) : `group:${row.leg_group_key}`;
    const key = `${row.technician_id}|${dateOnlyString(row.service_date)}|${stop}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shortDriveSummary(legs, fromDay, toDay) {
  const week = legs.filter((l) => {
    const day = dateOnlyString(l.service_date);
    return day >= fromDay && day < toDay;
  });
  const minutes = legs.map((l) => Number(l.drive_minutes)).filter(Number.isFinite).sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[mid] : (minutes.length ? (minutes[mid - 1] + minutes[mid]) / 2 : null);
  return { week, total: legs.length, median };
}

const legWords = (l) => `${Number(l.drive_miles).toFixed(1)} mi in ${Number(l.drive_minutes).toFixed(1)} min`;

function gpsLine(drives) {
  const week = drives.week.length ? drives.week.map(legWords).join(', ') : 'none';
  const since = drives.since ? ` since ${dayLabel(drives.since)}` : '';
  const median = drives.median != null ? `, median ${Number(drives.median).toFixed(1)} min` : '';
  return `Truck GPS, drives under half a mile from one visit to the next: last week ${week}. `
    + `All${since}: ${drives.total}${median}. The app prices such a drive at about ${milesToDriveMinutes(0.1)} min.`;
}

// ------------------------------------------------------------------- compose

const headlineFor = (pairs) => `${AREA} — review ${plural(pairs, 'next-door split')}`;

function pairLead(p) {
  const what = p.sameCustomer ? "one customer's two homes" : `two stops ${distanceLabel(p.miles)} apart`;
  if (p.first.date === p.second.date) return `Easiest to join: ${what} on ${dayLabel(p.first.date)}, ${splitLabel(p)}`;
  return `Easiest to join: ${what}, ${dayLabel(p.first.date)} and ${dayLabel(p.second.date)}`;
}

const summaryFor = (apart) => `${pairLead(apart[0])}.`.slice(0, SUMMARY_MAX);

function capped(lines) {
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `- and ${lines.length - MAX_LINES} more`];
}

// Three pair lines keep the detail near 1,000 characters; the cut is a last
// resort for very long names and cities.
function fitDetail(lines) {
  const text = lines.join('\n');
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX - 1)}…`;
}

function composeWeeklyCheck(data) {
  const { apart = [], nightLog = null, weekStart } = data;
  const drives = data.drives || { week: [], total: 0, median: null, since: null };
  if (!apart.length) return { items: 0 };
  const lines = [
    `Week of ${dayLabel(weekStart)}. Read-only: this check moved nothing and texted nobody.`,
    '',
    `Next-door stops apart in the next ${LOOKAHEAD_DAYS} days: ${apart.length}`,
    ...capped(apart.map((p) => pairLine(p, nightLog))),
    '',
    gpsLine(drives),
  ];
  return {
    items: apart.length,
    headline: headlineFor(apart.length),
    summary: summaryFor(apart),
    detail: fitDetail(lines),
    metadata: {
      weekOf: weekStart,
      pairsApart: apart.length,
      shortDrivesWeek: drives.week.length,
      shortDrivesTotal: drives.total,
    },
  };
}

// -------------------------------------------------------------------- loaders

async function loadUpcomingStops(today, until, conn = db) {
  return conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .whereBetween('s.scheduled_date', [today, until])
    .whereNotIn('s.status', NOT_A_ROUTE_STOP_STATUSES)
    .select(
      's.id', 's.customer_id', 's.scheduled_date', 's.window_start', 's.technician_id',
      's.is_recurring', 's.recurring_parent_id', 's.lat', 's.lng',
      's.service_address_line1', 's.service_address_zip', 's.service_address_city',
      'c.first_name', 'c.last_name', 'c.address_line1 as customer_address_line1', 'c.zip as customer_zip',
      'c.city as customer_city', 'c.latitude as customer_latitude', 'c.longitude as customer_longitude',
    );
}

// The newest completed nightly run's line for each visit (last line wins). Null
// when no run completed in the last NIGHT_LOG_HOURS, so the report says so.
async function loadNightLog(visitIds, now = new Date(), conn = db) {
  if (!visitIds.length) return new Map();
  // The night tool's own runs, as its catch-up reads them (cron or catch_up,
  // finished with or without errors); a staff run never stands in for it.
  const run = await conn('auto_dispatch_runs')
    .where({ mode: 'apply' })
    .whereIn('triggered_by', NIGHT_TRIGGERS)
    .whereIn('status', FINISHED_STATUSES)
    .where('started_at', '>=', new Date(now.getTime() - NIGHT_LOG_HOURS * 3600000))
    .orderBy('started_at', 'desc')
    .first('id');
  if (!run) return null;
  const rows = await conn('auto_dispatch_audit_logs')
    .where('auto_dispatch_run_id', run.id)
    .whereIn('scheduled_service_id', visitIds)
    .orderBy('created_at', 'asc')
    .select('scheduled_service_id', 'action', 'reason_code');
  return new Map(rows.map((r) => [String(r.scheduled_service_id), r]));
}

async function loadShortDrives(weekStart, conn = db) {
  const rows = await conn('visit_gps_legs')
    .where({ status: 'matched', drive_from_kind: 'visit' })
    .where('drive_miles', '<', SHORT_DRIVE_MILES)
    .select('technician_id', 'service_date', 'gps_arrived_at', 'leg_group_key', 'drive_miles', 'drive_minutes');
  const legs = physicalLegs(rows);
  const first = await conn('visit_gps_legs').where({ status: 'matched' }).min('service_date as first').first();
  return {
    ...shortDriveSummary(legs, shiftDateStr(weekStart, -7), weekStart),
    since: first?.first ? dateOnlyString(first.first) : null,
  };
}

async function loadWeek(now = new Date(), conn = db) {
  const weekStart = etWeekStart(now);
  const stops = await loadUpcomingStops(etDateString(now), etDateString(addETDays(now, LOOKAHEAD_DAYS)), conn);
  const apart = findApartPairs(stops);
  const nightLog = await loadNightLog(apart.flatMap((p) => [p.first.id, p.second.id]), now, conn);
  const drives = await loadShortDrives(weekStart, conn);
  return { weekStart, apart, nightLog, drives };
}

// ------------------------------------------------------------- run + marker

const weekStartMs = (now) => parseETDateTime(`${etWeekStart(now)}T00:00`).getTime();

async function markerAt(conn = db) {
  const row = await conn('ops_email_send_state').where({ email_key: OPS_KEY }).first('last_sent_at');
  return row?.last_sent_at ? ms(row.last_sent_at) : null;
}

// True once this ET week's check has run (the marker is stamped at or after its
// Monday 00:00). A read failure runs anyway: a rare second row beats a lost week,
// and the week's dedupe key keeps that second row from ringing.
async function sentRecently(now = new Date()) {
  try {
    const at = await markerAt();
    return at != null && at >= weekStartMs(now);
  } catch (err) {
    logger.warn(`[near-stops-weekly] marker read failed (${err.code || err.name || 'error'}): running without it`);
    return false;
  }
}

async function stampSendMarker() {
  try {
    const now = new Date();
    await db('ops_email_send_state')
      .insert({ email_key: OPS_KEY, last_sent_at: now, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: now, updated_at: now });
  } catch (err) {
    logger.warn(`[near-stops-weekly] marker write failed (${err.code || err.name || 'error'}): the catch-up may run again`);
  }
}

// The Monday and Tuesday 11:17 catch-up asks this. Unlike the Monday tick, a read
// failure answers false (skip; the next tick asks again).
async function weekIsMissing(now = new Date()) {
  try {
    const at = await markerAt();
    return !(at != null && at >= weekStartMs(now));
  } catch (err) {
    logger.warn(`[near-stops-weekly] catch-up could not read the marker (${err.code || err.name || 'error'}): skipped`);
    return false;
  }
}

// The owner asked for an admin notification, not an email. deliverOpsDigest calls
// this only when the bell row cannot be written: it sends nothing and reports not
// ok, so the week stays unstamped and the 11:17 catch-up tries again.
async function noEmail() {
  return { ok: false, error: 'bell_only' };
}

async function runNearStopsWeeklyCheck(opts = {}) {
  const now = opts.now || new Date();
  if (await (opts.sentRecently || sentRecently)(now)) return { skipped: 'recent_send' };
  let data;
  try {
    data = await (opts.loadWeek || loadWeek)(now);
  } catch (err) {
    logger.error(`[near-stops-weekly] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }
  const counts = { pairs: data.apart.length };
  const composed = composeWeeklyCheck(data);
  const stamp = opts.stampSendMarker || stampSendMarker;
  if (!composed.items) {
    // Nothing to review: last week's open row closes (the clean-run fall-off).
    await (opts.retireIfClean || retireIfClean)(OPS_KEY);
    await stamp();
    return { sent: false, empty: true, ...counts };
  }
  let delivered;
  try {
    delivered = await (opts.deliver || deliverOpsDigest)({
      key: OPS_KEY,
      subject: `ACT: ${composed.headline}`,
      headline: composed.headline,
      summary: composed.summary,
      text: composed.detail,
      link: LINK,
      metadata: composed.metadata,
      audience: 'owner',
      // One row per ET week: a rerun the same week hits the key, each new week
      // rings once, and the new row closes last week's open one.
      dedupeKey: `${OPS_KEY}:${data.weekStart}`,
      count: composed.items,
      itemKeys: [data.weekStart],
      ringOnFirstIdentity: true,
      supersedePrior: true,
      sendEmail: noEmail,
    });
  } catch (err) {
    logger.error(`[near-stops-weekly] delivery failed (${err.code || err.name || 'error'})`);
    return { sent: false, error: true, ...counts };
  }
  if (delivered?.ok === false) {
    logger.error('[near-stops-weekly] delivery reported not ok');
    return { sent: false, error: true, ...counts };
  }
  await stamp();
  return { sent: true, ...counts };
}

module.exports = {
  runNearStopsWeeklyCheck,
  weekIsMissing,
  _private: {
    buildPlaces,
    nearPairs,
    matchVisits,
    findApartPairs,
    holdFor,
    physicalLegs,
    shortDriveSummary,
    composeWeeklyCheck,
    loadWeek,
    sentRecently,
    noEmail,
    OPS_KEY,
    HOLD_WORDS,
  },
};
