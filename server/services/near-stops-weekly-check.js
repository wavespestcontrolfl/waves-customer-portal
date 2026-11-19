'use strict';

/**
 * Weekly near-stops check (owner 2026-11-19, "check" on the scope page
 * "Next-Door and Nearby Stops"). Each Monday ONE read-only owner notification:
 *
 *   1. Next-door stops booked apart in the next 30 days: two stops 0.1 mile or
 *      closer (any customers), or one customer's two homes half a mile or
 *      closer. Each line says what holds each visit where it is, read from
 *      the night run's own log line for that visit (auto_dispatch_audit_logs).
 *   2. Last week's office and phone bookings (first or one-time visits) that took
 *      an hour adding 6+ more drive minutes than an hour open the same day or up
 *      to 7 days sooner. A booking link's own offer rules (notice, hours) are not
 *      modeled, so link bookings are counted but not replayed. The replay feeds the booking engine's own per-day gap math
 *      (find-time.js candidatesForDay: each stop's real length, drive
 *      feasibility, on-the-hour starts, the model drive minutes) the calendar
 *      as it stood when the booking was made (scheduled_services rows plus the
 *      reschedule_log moves made after it). Closed days and the technician's
 *      days off are skipped. With one technician every stop that day is on one
 *      route, an unassigned visit too; with two or more the part pauses, because
 *      no log says whose route a stop was on at booking. Not replayed: the office
 *      screen's arrival-window simulation (GATE_ADMIN_ARRIVAL_WINDOWS) and what
 *      the customer asked for.
 *   3. Truck GPS minutes for visit-to-visit drives under half a mile
 *      (visit_gps_legs): the evidence a short-hop drive price would need.
 *
 * It moves no visit, texts nobody and calls no paid API: every drive number is
 * the app's model (auto-dispatch/geo.js driveMin), never a road lookup.
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
const { HQ, haversine, driveMin, resolveGeo, milesToDriveMinutes } = require('./auto-dispatch/geo');
const { daysBetween } = require('./auto-dispatch/route-tiers');
const { shiftDateStr } = require('./auto-dispatch/dates');
const { FLEX_TIER_RADIUS_DAYS } = require('./auto-dispatch/flex-tier');
const { NIGHT_TRIGGERS, FINISHED_STATUSES } = require('./auto-dispatch/catch-up');
const { NOT_A_ROUTE_STOP_STATUSES } = require('./stops-ahead');
const findTime = require('./scheduling/find-time');
const { techColumns, techStartPoint, techStartPointsLive } = require('./scheduling/tech-start-point');
const { getBlackoutDates } = require('./scheduling/blackout-dates');
const { occupiedRows } = require('./scheduling/visit-capacity');
const { applyAssignable, absentTechDays } = require('./technician-eligibility');
const { stampedDivergesSql } = require('./stamped-address');
const {
  etDateString, etParts, etWeekStart, addETDays, parseETDateTime, formatETDayDate, formatETTime,
} = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

const OPS_KEY = 'near-stops-weekly';
const LINK = '/admin/schedule';
const AREA = 'Schedule';
const LOOKAHEAD_DAYS = 30;
const NEXT_DOOR_MILES = 0.1; // about 528 feet, any two customers
const OWN_HOMES_MILES = 0.5; // one customer's two homes
const SAME_PLACE_MILES = 0.003; // about 16 feet: one customer's stops at one home
const MIN_SAVING_MINUTES = 6; // the owner's Oct 9 drive bar
const SAME_BOOKING_MS = 10 * 60000; // rows saved this close together are one booking
const SOONER_DAYS = 7; // the booking screen's own best-day horizon
const BOOKING_LEAD_MINUTES = 30; // find-time's same-day lead (todayFloorMin)
const SHORT_DRIVE_MILES = 0.5;
const NIGHT_LOG_HOURS = 36;
const MAX_LINES = 3;
const OFF_ROUTE = new Set(NOT_A_ROUTE_STOP_STATUSES);
const HEADLINE_MAX = 60;
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

const LINK_SCREENS = {
  inspection_link: 'inspection link',
  reservice_link: 're-service link',
  estimate_assessment_link: 'estimate link',
};

const REPLAY_NOTE = 'An estimate: the calendar at booking per the move log, the booking engine\'s gap math and drive '
  + 'estimate, hourly starts 8 AM to 5 PM, up to 7 days sooner. Not checked: arrival windows, customer wishes, '
  + 'short holds, office edits the move log missed.';

// ---------------------------------------------------------------- formatting

const ms = (value) => new Date(value).getTime();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const laterDate = (a, b) => (a > b ? a : b);

function shortName(row) {
  const first = String(row?.first_name || '').trim();
  const last = String(row?.last_name || '').trim();
  return [first, last ? `${last[0].toUpperCase()}.` : ''].filter(Boolean).join(' ') || 'A customer';
}

function hhmm(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

function minutesToHhmm(total) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
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
    planChild: row.is_recurring === true && row.recurring_parent_id != null,
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

function stopsBetween(dayStops, first, second, pair) {
  const routeTech = first.tech || second.tech;
  return dayStops.filter((s) => sameRoute(s.tech, routeTech) && !atPairHome(s, pair)
    && s.windowStart > first.windowStart && s.windowStart < second.windowStart).length;
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

// -------------------------------------------- part 2: bookings that cost drive

// "09:00:00-10:00:00", or a start alone ("09:00:00": the day re-plan logs a row
// with no end that way); occupiedRows gives a missing end the visit's length.
function splitWindow(value) {
  const match = /^(\d{1,2}:\d{2})(?::\d{2})?(?:\s*-\s*(\d{1,2}:\d{2}))?/.exec(String(value || '').trim());
  return match ? [match[1], match[2] || null] : [null, null];
}

// One row as it stood at instant T: null when it was not on the calendar then (made
// later, or cancelled by then), else its date and window then. The first move logged
// after T carries the slot the row held at T (reschedule_log original_date/_window).
function stateAt(row, T, moves = []) {
  if (ms(row.created_at) > T) return null;
  // A row now off the route (cancelled, skipped, no-show, rescheduled) left it
  // when it changed: cancelled_at for a cancel, else its last update stands in
  // (no log keeps the others' change time). A hold that had expired by T was
  // off the calendar too, as find-time's loader drops one at NOW().
  if (OFF_ROUTE.has(row.status) && ms((row.status === 'cancelled' && row.cancelled_at) || row.updated_at) <= T) return null;
  if (row.reservation_expires_at && ms(row.reservation_expires_at) <= T) return null;
  const later = moves.find((m) => ms(m.created_at) > T);
  if (!later) return { date: dateOnlyString(row.scheduled_date), windowStart: row.window_start, windowEnd: row.window_end };
  const [windowStart, windowEnd] = splitWindow(later.original_window);
  return { date: dateOnlyString(later.original_date || row.scheduled_date), windowStart, windowEnd };
}

const withState = (row, state) => ({
  ...row, scheduled_date: state.date, window_start: state.windowStart, window_end: state.windowEnd,
});

// The calendar at T in the row shape find-time's day builder reads.
function calendarAt(rows, T, movesById, excludeIds) {
  const out = [];
  for (const row of rows) {
    if (excludeIds.has(String(row.id))) continue;
    const state = stateAt(row, T, movesById.get(String(row.id)));
    if (state && state.windowStart) out.push(withState(row, state));
  }
  return out;
}

function screenOf(rows) {
  const link = rows.map((r) => String(r.source || '')).find((s) => s.endsWith('_link'));
  if (link) return LINK_SCREENS[link] || link.replace(/_/g, ' ');
  if (rows.some((r) => r.booking_source === 'phone_call')) return 'phone call';
  const source = rows[0].source;
  return !source || source === 'admin' ? 'office' : String(source).replace(/_/g, ' ');
}

function toBooking(rows) {
  const head = rows[0];
  const lat = head.svc_lat ?? head.cust_lat;
  const lng = head.svc_lng ?? head.cust_lng;
  if (lat == null || lng == null) return null;
  const spans = occupiedRows(rows.map((r) => withState(r, r.atBooking)));
  const startMin = Math.min(...spans.map((s) => s.startMin));
  const endMin = Math.max(...spans.map((s) => s.endMin));
  const createdAt = new Date(head.created_at);
  const at = etParts(createdAt);
  return {
    ids: new Set(rows.map((r) => String(r.id))),
    customerName: shortName(head),
    city: head.city || null,
    technicianId: head.technician_id ? String(head.technician_id) : null,
    viaLink: rows.some((r) => String(r.source || '').endsWith('_link')),
    day: head.atBooking.date,
    startMin,
    durationMinutes: endMin > startMin ? endMin - startMin : 60,
    stop: { lat: Number(lat), lng: Number(lng) },
    createdAt,
    bookingDay: etDateString(createdAt),
    bookingMinute: at.hour * 60 + at.minute,
    screen: screenOf(rows),
  };
}

// One booking = one customer's new visit at one home, day and start, however many
// service rows it holds (a combined visit's rows share their start). A second
// appointment at the same home that day stays its own booking. Each row is read
// as it stood when it was made.
function groupBookings(created, movesById) {
  const groups = new Map();
  const sorted = [...created].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  for (const row of sorted) {
    const atBooking = stateAt(row, ms(row.created_at), movesById.get(String(row.id)));
    if (!atBooking || !hhmm(atBooking.windowStart)) continue;
    const lat = Number(row.svc_lat ?? row.cust_lat);
    const lng = Number(row.svc_lng ?? row.cust_lng);
    const key = `${row.customer_id}|${atBooking.date}|${hhmm(atBooking.windowStart)}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
    // A later booking that reuses the same slot (the first one moved away) is
    // its own booking: rows join a group only when saved with its first row.
    const list = groups.get(key) || [];
    const last = list[list.length - 1];
    if (last && ms(row.created_at) - ms(last[0].created_at) <= SAME_BOOKING_MS) last.push({ ...row, atBooking });
    else list.push([{ ...row, atBooking }]);
    groups.set(key, list);
  }
  return [...groups.values()].flat().map(toBooking).filter(Boolean);
}

function dayParams(booking, services, techStartPoints) {
  const dayOpen = findTime.DAY_START_HOUR * 60;
  const dayClose = findTime.DAY_END_HOUR * 60;
  const { durationMinutes } = booking;
  return {
    services,
    geo: {
      newStop: booking.stop,
      dateFrom: booking.bookingDay,
      stopBuffer: 0,
      candidateExpectedMinutes: null,
      durationMinutes,
      dayOpen,
      earliestStartMin: 0,
      startFloorByDate: null,
      todayEt: booking.bookingDay,
      todayFloorMin: booking.bookingMinute + BOOKING_LEAD_MINUTES,
    },
    excludeSet: booking.ids,
    wantsPackedEnds: false,
    wantsExpectedMinutesCredit: false,
    slotStepMinutes: 60,
    durationMinutes,
    dayOpen,
    dayClose,
    everyStepStart: true,
    techStartPoints,
  };
}

// The drive the booked hour added: the same detour find-time scores a gap with
// (in + out - the leg it replaces), between the stops either side of it that day.
function bookedDetour(booking, tech, params) {
  const stops = findTime._internals.buildDayStops(params.services, {
    tech, date: booking.day, excludeSet: params.excludeSet, wantsPackedEnds: false, wantsExpectedMinutesCredit: false,
  });
  const home = params.techStartPoints ? techStartPoint(tech) : HQ;
  const prev = [...stops].reverse().find((s) => s.startMin <= booking.startMin) || home;
  const next = stops.find((s) => s.startMin > booking.startMin) || home;
  return Math.max(0, driveMin(prev, booking.stop) + driveMin(booking.stop, next) - driveMin(prev, next));
}

// One route only when that day's rows show one: every assigned stop on the
// booked day and the days it is compared with is this technician's. A stop on
// another technician's route (one who has since left) makes it ambiguous.
function oneRoute(booking, calendar, days, tech) {
  const own = (id) => !id || String(id) === String(tech.id);
  return own(booking.technicianId)
    && calendar.every((row) => !days.has(dateOnlyString(row.scheduled_date)) || own(row.technician_id));
}

function replayBooking(booking, ctx) {
  const { tech } = ctx;
  const calendar = calendarAt(ctx.rows, booking.createdAt.getTime(), ctx.movesById, booking.ids);
  const first = laterDate(booking.bookingDay, shiftDateStr(booking.day, -SOONER_DAYS));
  const offerDays = findTime._internals.enumerateDates(first, booking.day, { includeWeekends: true });
  if (!oneRoute(booking, calendar, new Set([booking.day, ...offerDays]), tech)) return null;
  // One technician serves every stop, so the day is one route: an unassigned
  // visit is a stop on it too (find-time's own rule for a committed stop with
  // no technician, on its customer-facing path).
  const services = calendar.map((row) => ({ ...row, technician_id: tech.id }));
  const params = dayParams(booking, services, ctx.techStartPoints);
  const booked = bookedDetour(booking, tech, params);
  let best = null;
  for (const day of offerDays) {
    if (ctx.closed.has(day) || ctx.absent.has(`${tech.id}:${day}`)) continue;
    for (const slot of findTime._internals.candidatesForDay(day, tech, params).candidates) {
      if (!best || slot.detour_minutes < best.detour_minutes) best = slot;
    }
  }
  return { booking, booked, best, saving: best ? booked - best.detour_minutes : 0 };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function bookingLine(r) {
  const b = r.booking;
  const where = b.city ? ` (${b.city})` : '';
  return `- ${capitalize(b.screen)}, booked ${dayLabel(b.bookingDay)}: ${b.customerName}${where} on `
    + `${whenLabel(b.day, minutesToHhmm(b.startMin))} adds ${r.booked} min; ${whenLabel(r.best.date, r.best.start_time)} `
    + `was open and adds ${r.best.detour_minutes} min (${r.saving} less).`;
}

// ---------------------------------------------------- part 3: short GPS drives

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

function headlineFor(pairs, bookings) {
  const parts = [];
  if (pairs) parts.push(plural(pairs, 'next-door split'));
  if (bookings) parts.push(`${bookings} costly ${bookings === 1 ? 'booking' : 'bookings'}`);
  const full = `${AREA} — review ${parts.join(' and ')}`;
  return full.length <= HEADLINE_MAX ? full : `${AREA} — review ${plural(pairs + bookings, 'near-stop finding')}`;
}

function pairLead(p) {
  const what = p.sameCustomer ? "one customer's two homes" : `two stops ${distanceLabel(p.miles)} apart`;
  if (p.first.date === p.second.date) return `Easiest to join: ${what} on ${dayLabel(p.first.date)}, ${splitLabel(p)}`;
  return `Easiest to join: ${what}, ${dayLabel(p.first.date)} and ${dayLabel(p.second.date)}`;
}

function summaryFor(apart, costly) {
  if (!apart.length) {
    return `${plural(costly.length, 'booking')} last week took an hour with 6+ more drive minutes than an open one.`;
  }
  const lead = pairLead(apart[0]);
  const tail = costly.length ? `; ${plural(costly.length, 'booking')} cost 6+ drive minutes more` : '';
  const full = `${lead}${tail}.`;
  return (full.length <= SUMMARY_MAX ? full : `${lead}.`).slice(0, SUMMARY_MAX);
}

function capped(lines) {
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `- and ${lines.length - MAX_LINES} more`];
}

// Three lines a section keep the detail near 1,500 characters; the cut is a
// last resort for very long names and cities.
function fitDetail(lines) {
  const text = lines.join('\n');
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX - 1)}…`;
}

function bookingSection({ costly, replayed, linkBookings, techCount }) {
  if (techCount !== 1) {
    return [`Bookings last week: not replayed. The replay needs one technician to know whose route each stop was on; the schedule has ${techCount}.`];
  }
  const links = linkBookings ? ` (${plural(linkBookings, 'link booking')} not replayed: a link has its own offer rules)` : '';
  return [
    `Office and phone bookings last week that took a costlier hour: ${costly.length} of ${replayed} replayed${links}`,
    ...capped(costly.map(bookingLine)),
    REPLAY_NOTE,
  ];
}

function composeWeeklyCheck(data) {
  const { apart = [], costly = [], replayed = 0, linkBookings = 0, techCount = 1, nightLog = null, weekStart } = data;
  const drives = data.drives || { week: [], total: 0, median: null, since: null };
  const items = apart.length + costly.length;
  if (!items) return { items: 0 };
  const lines = [
    `Week of ${dayLabel(weekStart)}. Read-only: this check moved nothing and texted nobody.`,
    '',
    `Next-door stops apart in the next ${LOOKAHEAD_DAYS} days: ${apart.length}`,
    ...capped(apart.map((p) => pairLine(p, nightLog))),
    '',
    ...bookingSection({ costly, replayed, linkBookings, techCount }),
    '',
    gpsLine(drives),
  ];
  return {
    items,
    headline: headlineFor(apart.length, costly.length),
    summary: summaryFor(apart, costly),
    detail: fitDetail(lines),
    metadata: {
      weekOf: weekStart,
      pairsApart: apart.length,
      bookingsReplayed: replayed,
      linkBookings,
      bookingsCostly: costly.length,
      costlyMinutes: costly.reduce((sum, r) => sum + r.saving, 0),
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

// The columns find-time's own loader reads (loadFindTimeContext), plus the ones
// the replay needs to rebuild the calendar at a past instant.
function calendarQuery(conn) {
  const diverges = stampedDivergesSql('s', 'c');
  return conn('scheduled_services as s')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .select(
      's.id', 's.customer_id', 's.scheduled_date', 's.technician_id', 's.window_start', 's.window_end',
      's.service_type', 's.estimated_duration_minutes', 's.reservation_service_mix', 's.is_recurring',
      's.recurring_parent_id', 's.status', 's.created_at', 's.updated_at', 's.cancelled_at',
      's.reservation_expires_at', 's.source', 's.booking_source',
      's.lat as svc_lat', 's.lng as svc_lng', 'c.first_name', 'c.last_name', 'c.city',
      conn.raw(`CASE WHEN NOT ${diverges} THEN c.latitude END as cust_lat`),
      conn.raw(`CASE WHEN NOT ${diverges} THEN c.longitude END as cust_lng`),
    );
}

function groupMoves(moves) {
  const byId = new Map();
  for (const move of moves) {
    const id = String(move.scheduled_service_id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(move);
  }
  return byId;
}

function dayRange(bookings) {
  const froms = bookings.map((b) => laterDate(b.bookingDay, shiftDateStr(b.day, -SOONER_DAYS)));
  const tos = bookings.map((b) => b.day);
  return { from: froms.reduce((a, b) => (a < b ? a : b)), to: tos.reduce(laterDate) };
}

// Strict: a closed-days read that fails throws, so the week is not stamped and
// the catch-up tries again, instead of a closed day reading as open.
async function loadDayRules(range, tech, conn) {
  const closed = await getBlackoutDates(range.from, range.to, conn, { strict: true });
  const absent = await absentTechDays(conn, { dateFrom: range.from, dateTo: range.to, technicianIds: [tech.id] });
  return { tech, closed, absent, techStartPoints: techStartPointsLive() };
}

// Office and phone bookings only: staff picked those hours on the screens this
// replays. A link booking's own offer rules are not modeled; it is counted.
function replayAll(bookings, ctx) {
  const staff = bookings.filter((b) => !b.viaLink);
  const results = staff.map((b) => replayBooking(b, ctx)).filter(Boolean);
  const costly = results.filter((r) => r.best && r.saving >= MIN_SAVING_MINUTES).sort((a, b) => b.saving - a.saving);
  return { costly, replayed: results.length, linkBookings: bookings.length - staff.length };
}

async function loadBookingReplay(weekStart, conn = db) {
  const techs = await applyAssignable(conn('technicians')).select(techColumns(['id', 'name'], true));
  if (techs.length !== 1) return { costly: [], replayed: 0, techCount: techs.length };
  const start = parseETDateTime(`${shiftDateStr(weekStart, -7)}T00:00`);
  const end = parseETDateTime(`${weekStart}T00:00`);
  const created = await calendarQuery(conn)
    .where('s.created_at', '>=', start)
    .where('s.created_at', '<', end)
    .whereNotNull('s.customer_id')
    .whereNull('s.reservation_expires_at')
    // A follow-up placed from its first visit (package_followup_auto, the call
    // pipeline's follow-up) is not a booking choice; it stays a stop on the calendar.
    .whereNull('s.parent_service_id')
    .whereNot((q) => q.where('s.is_recurring', true).whereNotNull('s.recurring_parent_id'));
  if (!created.length) return { costly: [], replayed: 0 };
  // Every move after the week began: each booking was made after `start`, so a
  // move after any booking's instant is in this set.
  const moves = await conn('reschedule_log')
    .where('created_at', '>=', start)
    .orderBy('created_at', 'asc')
    .select('scheduled_service_id', 'original_date', 'original_window', 'created_at');
  const movesById = groupMoves(moves);
  const bookings = groupBookings(created, movesById);
  if (!bookings.length) return { costly: [], replayed: 0 };
  const range = dayRange(bookings);
  const movedIn = moves.filter((m) => {
    const day = dateOnlyString(m.original_date);
    return day && day >= range.from && day <= range.to;
  }).map((m) => m.scheduled_service_id);
  const rows = await calendarQuery(conn).where((q) => {
    q.whereBetween('s.scheduled_date', [range.from, range.to]);
    if (movedIn.length) q.orWhereIn('s.id', movedIn);
  });
  const ctx = { rows, movesById, ...(await loadDayRules(range, techs[0], conn)) };
  return replayAll(bookings, ctx);
}

async function loadShortDrives(weekStart, conn = db) {
  const legs = await conn('visit_gps_legs')
    .where({ status: 'matched', drive_from_kind: 'visit' })
    .where('drive_miles', '<', SHORT_DRIVE_MILES)
    .select('service_date', 'drive_miles', 'drive_minutes');
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
  const { costly, replayed, linkBookings = 0, techCount = 1 } = await loadBookingReplay(weekStart, conn);
  const drives = await loadShortDrives(weekStart, conn);
  return { weekStart, apart, nightLog, costly, replayed, linkBookings, techCount, drives };
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
  const counts = { pairs: data.apart.length, bookings: data.costly.length };
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
    stateAt,
    calendarAt,
    groupBookings,
    replayBooking,
    replayAll,
    shortDriveSummary,
    composeWeeklyCheck,
    loadWeek,
    sentRecently,
    noEmail,
    OPS_KEY,
    HOLD_WORDS,
  },
};
