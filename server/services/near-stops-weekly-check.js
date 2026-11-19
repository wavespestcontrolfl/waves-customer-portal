'use strict';

/**
 * Weekly near-stops check (owner 2026-11-19, "check" on the scope page
 * "Next-Door and Nearby Stops"). Each Monday ONE read-only owner notification
 * with parts 1 and 3 of that page:
 *
 *   1. Next-door stops booked apart in the next 30 days: two stops 0.1 mile or
 *      closer (any customers), or one customer's two homes half a mile or
 *      closer. A home is the app's own same-place rule (one linked property, else
 *      one service address); a stop is one home's day, every service there that
 *      day. Each line says what holds each visit where it is: for two days,
 *      the newest night run's own log line for that visit (auto_dispatch_audit_logs,
 *      a dry run marked as one); for one day, the 4:40 AM day re-plan's own reason
 *      the visit keeps its hour (day_replan_plans.fixed, the visit's own technician).
 *   3. Truck GPS minutes for visit-to-visit drives under half a mile
 *      (visit_gps_legs), one drive per stop, every drive since the first
 *      matched leg: the evidence a short-hop drive price would need.
 *
 * Part 2 of the page (last week's bookings that took a costlier hour) is not
 * built here. It needs the calendar as it stood at each booking, and the app
 * keeps no history of a visit's fields (window edits, status restores, holds the
 * sweep deleted, closed-day edits), so a replay from the logs is never exact.
 *
 * Delivery (docs/admin-notifications.md): a standing condition, one Schedule row
 * for the whole set, raised through raiseAdminAlert under category 'alert' with
 * bell: true (as the unassigned-visits check). It rings when a split joins the
 * set, refreshes quietly when one leaves, and closes itself (count_zero) when none
 * is left. A GPS reading alone is an FYI and writes no row; the next row's GPS
 * line counts every drive since the first, so no week's drive is lost.
 *
 * It moves no visit, texts nobody and calls no paid API: its one drive price is
 * the app's model (auto-dispatch/geo.js milesToDriveMinutes), never a road lookup.
 * Writes: the one admin row and the weekly marker in ops_email_send_state.
 *
 * Cron: Monday 6:17am ET in scheduler.js inside runExclusive, plus a Monday and
 * Tuesday 11:17am catch-up that runs only while this week's marker is missing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { alertEpisodesLive } = require('../config/feature-gates');
const { composeAdminAlert, raiseAdminAlert, cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { haversine, resolveGeo, milesToDriveMinutes } = require('./auto-dispatch/geo');
const { samePlace } = require('./auto-dispatch/current-conflict');
const { effectivePremise, currentOrder, effectiveWindowRange } = require('./route-reorder-window-fit');
const { timeFallbackOrder } = require('./scheduling/route-order-time-fallback');
const { daysBetween } = require('./auto-dispatch/route-tiers');
const { NIGHT_TRIGGERS, FINISHED_STATUSES } = require('./auto-dispatch/catch-up');
const { NONTERMINAL_SCHEDULED_SERVICE_STATUSES } = require('./scheduled-service-statuses');
const {
  etDateString, etWeekStart, addETDays, parseETDateTime, formatETDayDate, formatETTime,
} = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

const DEDUPE_KEY = 'near-stops-weekly'; // the admin row's key and the weekly marker's email_key
const CATEGORY = 'alert'; // the schedule checks' own category (bell: true below)
const DONE_WHEN = 'count_zero';
const LINK = '/admin/schedule';
const AREA = 'Schedule';
const LOOKAHEAD_DAYS = 30;
// Rounds pair across a wider span than the report: a round near the end meets its
// partner just past it, and a round whose partner was served last month keeps that
// partner instead of meeting the next round. Only live splits in the next 30 days report.
const PAIR_DAYS_BACK = LOOKAHEAD_DAYS;
const PAIR_DAYS_AHEAD = 2 * LOOKAHEAD_DAYS;
const SERVED_STATUS = 'completed';
const NEXT_DOOR_MILES = 0.1; // about 528 feet, any two customers
const OWN_HOMES_MILES = 0.5; // one customer's two homes
const SAME_PLACE_MILES = 0.003; // about 16 feet: one customer's stops at one home
const SHORT_DRIVE_MILES = 0.5;
const NIGHT_LOG_HOURS = 36;
const MAX_LINES = 5;
const NEWEST_DRIVES = 3;
const DETAIL_MAX = 2000;

// The night run's skip and keep reasons (auto_dispatch_audit_logs.reason_code), in
// the owner's words, from each code's own reason_description. An unknown code
// falls back to its own words, lower case.
const HOLD_WORDS = {
  NO_SCORE_IMPROVEMENT: 'no other day scored enough better',
  NO_VALID_SLOT: 'no open slot in reach',
  NO_SLOT_MATCHING_PREFERENCE: "no slot fits the customer's day or time wish",
  NO_DRIVE_SAVING: 'no move saved enough drive',
  NO_ROAD_DRIVE_SAVING: 'real roads showed too little saving',
  PERSON_PLACED: 'staff picked the day',
  PERSON_PLACED_UNKNOWN: 'staff may have picked the day',
  REMINDER_SENT_FROZEN: 'a reminder or a promise froze it',
  CUSTOMER_CONFIRMED: 'customer confirmed',
  MOVE_LIMIT_REACHED: "already at the night run's move limit",
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
  DRY_RUN_RECOMMENDATION: 'the night run would move it',
  WITHIN_73H: 'too close to its day to move',
  SUNDAY_CAP_REACHED: "the night's Sunday move cap was reached",
};

// The 4:40 AM day re-plan's reasons a visit keeps its hour (day-replan fixedReason
// and attachPrefs, stored in day_replan_plans.fixed), in the owner's words. An
// unknown reason falls back to its own words.
const REPLAN_HOLD_WORDS = {
  status: 'already under way',
  hold: 'a held estimate slot',
  staff_lock: 'locked by staff',
  office_review_pending: 'waiting for office review',
  grouped: 'part of a combined visit',
  same_customer: 'same customer twice that day',
  within_24h: 'less than 24 hours away',
  reminder_24h_sent: '24-hour reminder sent',
  reminder_24h_off: '24-hour reminder off',
  customer_confirmed: 'customer confirmed',
  first_or_one_time: 'first or one-time visit',
  person_placed: 'staff picked the time',
  time_told: 'customer may already know the time',
  pref_unknown: "customer's wishes unreadable",
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

// A visit's time: its window start, or for a legacy row the start of its time_window
// as the app reads it (route-reorder-window-fit.js effectiveWindowRange: 'morning'
// starts 8:00 AM, '2:00 PM' is 14:00).
function windowStartOf(row) {
  const own = hhmm(row.window_start);
  if (own) return own;
  const range = effectiveWindowRange(row);
  if (!range) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(range.startMin / 60))}:${pad(range.startMin % 60)}`;
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

// The night run moves only a plan's later cadence visits (auto-dispatch/eligibility.js:
// is_recurring true and a recurring_parent_id). A booster carries the parent but is
// stored is_recurring false; a first or one-time visit has no parent.
function nightKindOf(row) {
  if (row.recurring_parent_id == null) return 'first';
  return row.is_recurring === true ? 'cadence' : 'booster';
}

function toVisit(row) {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    date: dateOnlyString(row.scheduled_date),
    windowStart: windowStartOf(row),
    tech: row.technician_id ? String(row.technician_id) : null,
    done: row.status === SERVED_STATUS, // served: a pairing partner, never a split to report
    nightKind: nightKindOf(row),
    // The board's order fields (route-reorder-window-fit.js currentOrder, which
    // mirrors the dispatch board: a visit with no window_start runs last).
    route_order: row.route_order ?? null,
    window_start: row.window_start ?? null,
    created_at: row.created_at ?? null,
    row,
  };
}

const hasStreet = (premise) => !!premise?.service_address_line1;

// Whether two rows of one customer are one place under the app's own same-place
// rule (auto-dispatch/current-conflict.js samePlace, on route-reorder-window-fit.js
// effectivePremise: the visit's stamp, else the customer's): two street lines match
// by address, unit included, a missing zip or city counting as unknown, so two known
// addresses that differ are two places even at one map pin (two units of one
// building). When either row has no street line, the map pin decides (16 ft).
function onePlace(x, y) {
  if (hasStreet(x.premise) && hasStreet(y.premise)) return samePlace(x.row, y.row);
  return !!(x.geo && y.geo) && haversine(x.geo.lat, x.geo.lng, y.geo.lat, y.geo.lng) <= SAME_PLACE_MILES;
}

// Every pair of one customer's rows compared once (onePlace), by index.
function agreementOf(entries) {
  const agree = entries.map(() => new Array(entries.length).fill(false));
  entries.forEach((x, i) => {
    agree[i][i] = true;
    for (let j = i + 1; j < entries.length; j += 1) {
      agree[i][j] = onePlace(x, entries[j]);
      agree[j][i] = agree[i][j];
    }
  });
  return agree;
}

// Unlinked rows against the customer's properties. A row joins the one property all
// of whose rows it agrees with. One that agrees with only some of a property's rows
// (a property stamped two ways) or with two properties cannot be placed, and neither
// can two rows that join one property but differ from each other. The rest are free.
function placeOnProperties(propertyRows, loose, agree) {
  const properties = propertyRows.map((rows) => ({ rows, joiners: [] }));
  const free = [];
  const unplaced = [];
  for (const i of loose) {
    const agreed = properties.map((p) => p.rows.filter((h) => agree[i][h]).length);
    const full = properties.filter((p, k) => agreed[k] === p.rows.length);
    const partial = properties.some((p, k) => agreed[k] > 0 && agreed[k] < p.rows.length);
    if (partial || full.length > 1) unplaced.push(i);
    else if (full.length === 1) full[0].joiners.push(i);
    else free.push(i);
  }
  const homes = properties.map(({ rows, joiners }) => {
    const clash = joiners.filter((i) => !joiners.every((j) => agree[i][j]));
    unplaced.push(...clash);
    return [...rows, ...joiners.filter((i) => !clash.includes(i))];
  });
  return { homes, free, unplaced };
}

// Free rows: each groups with every free row it agrees with, when those rows all
// agree with each other too; each distinct group is checked once. A row that agrees
// with two rows that differ (a street line with no zip beside two zips, a pin-only
// visit beside two units) cannot be placed.
function groupFree(free, agree) {
  const groupOf = new Map(free.map((i) => [i, free.filter((j) => agree[i][j])]));
  const verdicts = new Map();
  const isHome = (group) => {
    const key = group.join(',');
    if (!verdicts.has(key)) verdicts.set(key, group.every((a) => group.every((b) => agree[a][b])));
    return verdicts.get(key);
  };
  const placed = new Set(free.filter((i) => isHome(groupOf.get(i))));
  const homes = [];
  const seen = new Set();
  for (const i of placed) {
    if (seen.has(i)) continue;
    const home = groupOf.get(i).filter((j) => placed.has(j));
    home.forEach((j) => seen.add(j));
    homes.push(home);
  }
  return { homes, unplaced: free.filter((i) => !placed.has(i)) };
}

// One customer's homes, judged on all its rows at once, so the order the rows come
// in never changes them: linked rows are one home per property, unlinked rows join
// a property (placeOnProperties) or group among themselves (groupFree). A row that
// cannot be placed stays a stop on its route but is never paired.
function customerHomes(entries) {
  const agree = agreementOf(entries);
  const byProperty = new Map();
  const loose = [];
  entries.forEach((e, i) => {
    if (!e.row.property_id) return loose.push(i);
    const id = String(e.row.property_id);
    if (!byProperty.has(id)) byProperty.set(id, []);
    return byProperty.get(id).push(i);
  });
  const linked = placeOnProperties([...byProperty.values()], loose, agree);
  const grouped = groupFree(linked.free, agree);
  const pick = (ids) => ids.map((i) => entries[i]);
  return {
    homes: [...linked.homes, ...grouped.homes].map(pick),
    unplaced: pick([...linked.unplaced, ...grouped.unplaced]),
  };
}

// Every row's home, pinned or not (customerHomes). A home's pin, name and city come
// from its earliest visit; only a placed home with a pin can be paired.
function buildPlaces(rows) {
  const byCustomer = new Map();
  for (const raw of rows) {
    const geo = resolveGeo(raw);
    // The app's guarded pin (scheduling/day-stops.js guardedCoordSelects), as the route helpers read it.
    const row = { ...raw, lat: geo ? geo.lat : null, lng: geo ? geo.lng : null };
    const customerId = String(row.customer_id);
    if (!byCustomer.has(customerId)) byCustomer.set(customerId, []);
    byCustomer.get(customerId).push({ row, geo, premise: effectivePremise(row), visit: toVisit(row) });
  }
  const places = [];
  const addPlace = (entries, unplaced) => {
    const ordered = [...entries].sort((x, y) => visitOrder(x.visit, y.visit));
    const first = ordered[0].row;
    const place = {
      key: `home-${places.length + 1}`,
      customerId: String(first.customer_id),
      geo: ordered.find((e) => e.geo)?.geo || null,
      unplaced,
      name: shortName(first),
      city: first.service_address_city || first.customer_city || null,
    };
    place.visits = ordered.map((e) => ({ ...e.visit, home: place.key, placeName: place.name, city: place.city }));
    places.push(place);
  };
  for (const entries of byCustomer.values()) {
    const { homes, unplaced } = customerHomes(entries);
    homes.forEach((home) => addPlace(home, false));
    unplaced.forEach((e) => addPlace([e], true));
  }
  return places;
}

function nearPairs(places) {
  const pinned = places.filter((p) => p.geo && !p.unplaced);
  const pairs = [];
  for (let i = 0; i < pinned.length; i += 1) {
    for (let j = i + 1; j < pinned.length; j += 1) {
      const a = pinned[i];
      const b = pinned[j];
      const sameCustomer = a.customerId === b.customerId;
      const miles = haversine(a.geo.lat, a.geo.lng, b.geo.lat, b.geo.lng);
      if (miles <= (sameCustomer ? OWN_HOMES_MILES : NEXT_DOOR_MILES)) pairs.push({ a, b, miles, sameCustomer });
    }
  }
  return pairs;
}

const slotKey = (v) => `${v.date} ${v.windowStart || '99:99'}`;
// Earlier slot first, then the lower id: two rows of one combined visit always
// resolve the same way, so a split keeps its key from week to week.
const visitOrder = (x, y) => slotKey(x).localeCompare(slotKey(y)) || x.id.localeCompare(y.id);

// A stop's first-booked service (booked first, then the lower id): it names the stop
// in the split's key, so a split keeps its key when the services it shows change
// (siblings reordered, one served) or the whole stop moves to another day.
const bookedFirst = (x, y) => (ms(x.created_at) || Infinity) - (ms(y.created_at) || Infinity) || x.id.localeCompare(y.id);

// One stop per home and day: every service there that day (a combined visit, or
// services back to back) is one trip. A stop stays live while any of its services
// is outstanding, and its first live service (visitOrder) stands for it; it is
// served only when every service is.
function homeDays(place) {
  const days = new Map();
  for (const visit of [...place.visits].sort(visitOrder)) {
    if (!days.has(visit.date)) days.set(visit.date, []);
    days.get(visit.date).push(visit);
  }
  return [...days.values()].map((visits) => ({
    key: `${place.key}|${visits[0].date}`,
    date: visits[0].date,
    visits,
    lead: visits.find((v) => !v.done) || visits[0],
    anchor: [...visits].sort(bookedFirst)[0].id,
    done: visits.every((v) => v.done),
  }));
}

const routeKey = (date, tech) => `${date}|${tech}`;

// Each technician's day as the board runs it (route-reorder-window-fit.js
// currentOrder, the dispatch board's own order: route number, then hour, then
// booking), with every service on it, pinned or not, served or not.
function routesOf(places) {
  const routes = new Map();
  for (const place of places) {
    for (const visit of place.visits) {
      if (!visit.tech) continue;
      const key = routeKey(visit.date, visit.tech);
      if (!routes.has(key)) routes.set(key, []);
      routes.get(key).push(visit);
    }
  }
  for (const [key, visits] of routes) routes.set(key, currentOrder(visits));
  return routes;
}

// The route two services are judged on: their technician's day. An unassigned
// service goes on its partner's route where the app puts a visit with no route
// number (route-order-time-fallback.js timeFallbackOrder: among the numbered stops
// by its hour, after any stop done or under way; by hour on a day with no numbers).
// The day's stops with no number stay last, where the board shows them.
function routeFor(routes, a, b) {
  const tech = a.tech || b.tech;
  const day = routes.get(routeKey(a.date, tech)) || [];
  const loose = [a, b].find((v) => !v.tech);
  if (!loose) return day;
  const ids = day.some((v) => v.route_order != null)
    ? timeFallbackOrder(day.map((v) => v.row), { ...loose.row, technician_id: tech })
    : null;
  if (!ids) {
    // On a day with no route numbers the unassigned service goes in by its own start,
    // a legacy window included, as the time fallback reads it.
    const placed = { ...loose, window_start: loose.windowStart };
    return currentOrder([...day, placed]).map((v) => (v === placed ? loose : v));
  }
  const byId = new Map([...day, loose].map((v) => [v.id, v]));
  return [...ids.map((id) => byId.get(String(id))), ...day.filter((v) => v.route_order == null)];
}

// The stops the route runs between two services: other homes only, one stop per
// home (its back-to-back services are one trip); a stop at either paired home is
// part of the pair, a third home of the same customer is not.
function stopsBetween(route, a, b, pair) {
  const i = route.indexOf(a);
  const j = route.indexOf(b);
  const between = route.slice(Math.min(i, j) + 1, Math.max(i, j));
  return new Set(between.map((s) => s.home).filter((home) => home !== pair.a.key && home !== pair.b.key)).size;
}

// How two homes' stops sit on the calendar, with the two services that show it.
// A null split is not one to report: together (one day, one route, back to back) or
// not judged (no time yet, or neither visit on a route yet). Two days: each stop's
// lead service. One day: the two homes' nearest open services on one route decide,
// counted on the route as the board runs it, so a home's second trip that day never
// hides a back-to-back pair and a stop in a tied hour counts where the route puts it.
// A same-day split is reported for any two customers: the 4:40 AM day re-plan keeps
// most stops at their hours (a told time, a first visit, a staff pick, 24 hours out),
// so it cannot be left to join them.
function splitOf(x, y, pair, routes) {
  if (x.date !== y.date) {
    const [first, second] = [x.lead, y.lead].sort(visitOrder);
    return { first, second, split: { gap: daysBetween(first.date, second.date) } };
  }
  let near = null;
  let twoTechs = null;
  for (const a of x.visits) {
    for (const b of y.visits) {
      if (a.done || b.done || !a.windowStart || !b.windowStart || (!a.tech && !b.tech)) continue;
      const [first, second] = [a, b].sort(visitOrder);
      if (a.tech && b.tech && a.tech !== b.tech) {
        twoTechs = twoTechs || { first, second };
        continue;
      }
      const between = stopsBetween(routeFor(routes, a, b), a, b, pair);
      if (!near || between < near.between) near = { first, second, between };
    }
  }
  if (near) return { first: near.first, second: near.second, split: near.between === 0 ? null : { between: near.between } };
  if (twoTechs) return { ...twoTechs, split: { twoTechs: true } };
  const [first, second] = [x.lead, y.lead].sort(visitOrder);
  return { first, second, split: null };
}

const gapOf = (p) => p.gap ?? 0;
// One stable key per split: its two stops' first-booked services.
const pairKey = (p) => p.key;

// The two homes' stops, paired one to one. A stop already together with a stop next
// door (or on the same day with no time to judge) pairs first; the rest pair nearest
// dates first, then the earlier slots. So each stop meets at most one stop next
// door, and a round with no partner pairs with nothing. Returns the pairs apart.
function pairSplits(pair, routes) {
  const candidates = [];
  for (const x of homeDays(pair.a)) {
    for (const y of homeDays(pair.b)) {
      candidates.push({
        keys: [x.key, y.key],
        key: [x.anchor, y.anchor].sort().join('|'),
        done: x.done || y.done,
        days: Math.abs(daysBetween(x.date, y.date)),
        ...splitOf(x, y, pair, routes),
      });
    }
  }
  candidates.sort((p, q) => Number(p.split != null) - Number(q.split != null) || p.days - q.days
    || visitOrder(p.first, q.first) || visitOrder(p.second, q.second));
  const used = new Set();
  const splits = [];
  for (const c of candidates) {
    if (c.keys.some((k) => used.has(k))) continue;
    c.keys.forEach((k) => used.add(k));
    if (c.split) splits.push(c);
  }
  return splits;
}

// Every split of two live stops that both fall between `from` (today) and `until`
// (the report's last day). The rows reach further on both sides (PAIR_DAYS_BACK,
// PAIR_DAYS_AHEAD) only so each round meets its own partner: a split with a served
// stop is over, and one whose partner is past `until` reports in a later week.
function findApartPairs(rows, { from = null, until = null } = {}) {
  const places = buildPlaces(rows);
  const routes = routesOf(places);
  const apart = [];
  for (const pair of nearPairs(places)) {
    for (const hit of pairSplits(pair, routes)) {
      if (hit.done || hit.days > LOOKAHEAD_DAYS) continue;
      if ((from && hit.first.date < from) || (until && hit.second.date > until)) continue;
      apart.push({ ...pair, key: hit.key, first: hit.first, second: hit.second, ...hit.split });
    }
  }
  // Same-day splits first, then the pairs the fewest days apart: the easiest to join.
  return apart.sort((x, y) => gapOf(x) - gapOf(y) || visitOrder(x.first, y.first) || pairKey(x).localeCompare(pairKey(y)));
}

// The day the night run left a visit on, by its own audit rule (auto-dispatch/
// audit.js): the new day of a move it made, else the day it judged.
const dayRunLeft = (row) => dateOnlyString(row.action === 'changed' ? row.new_scheduled_date || row.old_scheduled_date : row.old_scheduled_date);

function holdFor(visit, nightLog) {
  if (visit.nightKind === 'first') return 'first or one-time visit';
  if (visit.nightKind === 'booster') return 'booster visit, which the night run never moves';
  if (!nightLog) return 'no night run to read';
  const row = nightLog.get(visit.id);
  if (!row) return 'not in the night run';
  // Its reason is for the day it judged; a visit moved since then has no reason here.
  const left = dayRunLeft(row);
  if (left && left !== visit.date) return 'moved after the last night run';
  const code = String(row.reason_code || row.action || 'no reason logged');
  const words = HOLD_WORDS[code] || code.toLowerCase().replace(/_/g, ' ');
  return row.dry_run ? `dry run: ${words}` : words;
}

// Same-day pairs: the re-plan's newest plan for the visit's own day and technician
// says why it keeps its hour. The re-plan plans only assigned visits, and a plan
// lists only the stops it fixed, so a visit it does not list reads as no lock listed,
// never as free to move (the plan may be older than the visit). No plan: the re-plan
// did not plan that day (past its reach, too few stops, or a day it skipped).
const replanKey = (date, tech) => `${date}|${tech}`;

function replanHoldFor(visit, replan) {
  if (!visit.tech) return 'no technician yet';
  const plan = replan ? replan.get(replanKey(visit.date, visit.tech)) : null;
  if (!plan) return 'the re-plan did not plan this day';
  const why = plan.get(visit.id);
  if (!why) return 'no lock listed in the last re-plan';
  return REPLAN_HOLD_WORDS[why] || String(why).replace(/_/g, ' ');
}

function splitLabel(p) {
  if (p.twoTechs) return 'same day, two technicians';
  if (p.between != null) return `same day, ${plural(p.between, 'stop')} between`;
  return `${plural(p.gap, 'day')} apart`;
}

// Each visit's time, with what holds it there: on one day the re-plan's reason for
// its hour, on two days the night run's reason for its day.
function visitWords(visit, hold, withDay) {
  const when = withDay ? whenLabel(visit.date, visit.windowStart) : timeLabel(visit.date, visit.windowStart);
  return `${when} (${hold})`;
}

function pairLine(p, nightLog, replan) {
  const who = p.sameCustomer ? `${p.first.placeName}'s two homes` : `${p.first.placeName} and ${p.second.placeName}`;
  const lead = `- ${who}${p.first.city ? ` (${p.first.city})` : ''}, ${distanceLabel(p.miles)} apart: `;
  const sameDay = p.first.date === p.second.date;
  const holdOf = (visit) => (sameDay ? replanHoldFor(visit, replan) : holdFor(visit, nightLog));
  return `${lead}${visitWords(p.first, holdOf(p.first), true)} and ${visitWords(p.second, holdOf(p.second), !sameDay)}, `
    + `${splitLabel(p)}.`;
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

// Every short drive so far: the count, the median minutes and the newest few.
function shortDriveSummary(legs) {
  const minutes = legs.map((l) => Number(l.drive_minutes)).filter(Number.isFinite).sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[mid] : (minutes.length ? (minutes[mid - 1] + minutes[mid]) / 2 : null);
  const arrived = (l) => (l.gps_arrived_at ? ms(l.gps_arrived_at) : -Infinity);
  const newest = [...legs]
    .sort((a, b) => dateOnlyString(b.service_date).localeCompare(dateOnlyString(a.service_date))
      || arrived(b) - arrived(a) || String(a.scheduled_service_id).localeCompare(String(b.scheduled_service_id)))
    .slice(0, NEWEST_DRIVES);
  return { total: legs.length, median, newest };
}

const legWords = (l) => `${Number(l.drive_miles).toFixed(1)} mi in ${Number(l.drive_minutes).toFixed(1)} min`;

function gpsLine(drives) {
  const since = drives.since ? ` since ${dayLabel(drives.since)}` : '';
  const price = `The app prices a 0.1-mile hop at about ${milesToDriveMinutes(0.1)} min.`;
  const lead = 'Truck GPS, drives under half a mile from one visit to the next:';
  if (!drives.total) return `${lead} none${since}. ${price}`;
  const median = drives.median != null ? `, median ${Number(drives.median).toFixed(1)} min` : '';
  const newest = drives.newest.map((l) => `${dayLabel(dateOnlyString(l.service_date))}: ${legWords(l)}`).join('; ');
  return `${lead} ${drives.total}${since}${median}. Newest: ${newest}. ${price}`;
}

// ------------------------------------------------------------------- compose


function pairLead(p) {
  const what = p.sameCustomer ? "one customer's two homes" : `two stops ${distanceLabel(p.miles)} apart`;
  if (p.first.date === p.second.date) return `Easiest to join: ${what} on ${dayLabel(p.first.date)}, ${splitLabel(p)}`;
  return `Easiest to join: ${what}, ${dayLabel(p.first.date)} and ${dayLabel(p.second.date)}`;
}


function capped(lines) {
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `- and ${lines.length - MAX_LINES} more`];
}

// Five pair lines keep the detail under 2,000 characters; the cut is a last
// resort for very long names and cities.
function fitDetail(lines) {
  const text = lines.join('\n');
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX - 1)}…`;
}

// The row for the week: `items` 0 = nothing to raise (the open row closes).
function composeWeeklyCheck(data) {
  const { apart = [], nightLog = null, replan = null, weekStart } = data;
  const drives = data.drives || { total: 0, median: null, since: null, newest: [] };
  if (!apart.length) return { items: 0 };
  const lines = [
    `Week of ${dayLabel(weekStart)}. Read-only: this check moved nothing and texted nobody.`,
    '',
    `Next-door stops apart in the next ${LOOKAHEAD_DAYS} days: ${apart.length}`,
    ...capped(apart.map((p) => pairLine(p, nightLog, replan))),
    '',
    gpsLine(drives),
  ];
  const easiest = apart[0];
  return {
    items: apart.length,
    itemKeys: apart.map(pairKey).sort(),
    spec: {
      area: AREA,
      action: `review ${plural(apart.length, 'next-door split')}`,
      why: cutAtWord(`${pairLead(easiest)}.`, MAX_WHY_CHARS),
      severity: 'needs-you',
      link: `${LINK}?date=${easiest.first.date}`,
      subject: { type: 'check', id: DEDUPE_KEY },
      doneWhen: DONE_WHEN,
      who: 'person',
    },
    detail: fitDetail(lines),
    metadata: { weekOf: weekStart, pairsApart: apart.length, shortDrivesTotal: drives.total },
  };
}

// A refresh rings only when a split joins the set. (A comeback after the row closed
// rings through raiseAdminAlertWithReopen, which ignores this.)
function ringOnNewPair(itemKeys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key));
  };
}

async function raisePairs(trx, composed) {
  const opts = {
    dedupeKey: DEDUPE_KEY,
    trx,
    // Under GATE_ADMIN_BELL_POLICY the 'alert' category is denied unless the call site tags it.
    bell: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewPair(composed.itemKeys),
    // A refresh that rings moves the row to the top of the newest-first bell.
    bumpOnRefresh: true,
    detail: composed.detail,
    metadata: { ...composed.metadata, itemKeys: composed.itemKeys, count: composed.items },
  };
  if (!alertEpisodesLive()) return raiseAdminAlert(CATEGORY, composed.spec, opts);
  const alert = composeAdminAlert(composed.spec);
  return require('./admin-alert-episodes').raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    ...opts, link: alert.link, metadata: { ...opts.metadata, ...alert.metadata },
  });
}

// Writes the week's row, or closes the open one when no split is left. One run at a
// time across instances (the advisory lock notifyAdmin takes for this row). A read or
// write failure throws and never closes the row, so the week stays unstamped.
async function writeAlert(composed, now, conn = db) {
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${DEDUPE_KEY}`]);
    if (!composed.items) {
      const closed = alertEpisodesLive()
        ? Number(await require('./admin-alert-episodes').closeAdminAlertKeys(trx, [DEDUPE_KEY], DONE_WHEN, {
          now, resolution: 'Cleared: no next-door stops are booked apart in the next 30 days',
        })) || 0
        : 0;
      return closed ? 'closed' : 'clear';
    }
    const result = await raisePairs(trx, composed);
    if (!result) throw new Error('near-stops row was not written');
    if (result.suppressed) return 'suppressed';
    if (!result.deduped) return 'raised';
    if (result.refreshed) return result.rung === false ? 'refreshed' : 'raised';
    return 'unchanged';
  });
}

// -------------------------------------------------------------------- loaders

// Live visits, and served ones as pairing partners only; never a cancelled,
// skipped, moved or missed visit, an estimate-slot hold or an internal test customer.
async function loadStops(fromDate, untilDate, conn = db) {
  const { isInternalTestCustomerId } = require('./internal-test-customers');
  const rows = await conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .whereBetween('s.scheduled_date', [fromDate, untilDate])
    .whereIn('s.status', [...NONTERMINAL_SCHEDULED_SERVICE_STATUSES, SERVED_STATUS])
    .whereNull('s.reservation_expires_at')
    .orderBy([{ column: 's.scheduled_date' }, { column: 's.window_start' }, { column: 's.id' }])
    .select(
      's.id', 's.customer_id', 's.scheduled_date', 's.window_start', 's.technician_id', 's.status',
      's.route_order', 's.created_at', 's.visit_id', 's.time_window',
      's.is_recurring', 's.recurring_parent_id', 's.lat', 's.lng', 's.property_id',
      's.service_address_line1', 's.service_address_line2', 's.service_address_zip', 's.service_address_city',
      'c.first_name', 'c.last_name', 'c.address_line1 as customer_address_line1',
      'c.address_line2 as customer_address_line2', 'c.zip as customer_zip', 'c.state as customer_state',
      'c.city as customer_city', 'c.latitude as customer_latitude', 'c.longitude as customer_longitude',
    );
  return rows.filter((row) => !isInternalTestCustomerId(row.customer_id));
}

// The newest finished nightly run's line for each visit (last line wins), a dry
// run's lines marked as such. Null when no run finished in the last
// NIGHT_LOG_HOURS, so the report says so.
async function loadNightLog(visitIds, now = new Date(), conn = db) {
  if (!visitIds.length) return new Map();
  // The night tool's own runs, in either mode, as its catch-up counts them (cron or
  // catch_up, finished with or without errors); a staff run never stands in for it.
  const run = await conn('auto_dispatch_runs')
    .whereIn('triggered_by', NIGHT_TRIGGERS)
    .whereIn('status', FINISHED_STATUSES)
    .where('started_at', '>=', new Date(now.getTime() - NIGHT_LOG_HOURS * 3600000))
    .orderBy('started_at', 'desc')
    .first('id', 'mode');
  if (!run) return null;
  const rows = await conn('auto_dispatch_audit_logs')
    .where('auto_dispatch_run_id', run.id)
    .whereIn('scheduled_service_id', visitIds)
    .orderBy([{ column: 'created_at' }, { column: 'id' }])
    .select('scheduled_service_id', 'action', 'reason_code', 'old_scheduled_date', 'new_scheduled_date');
  const dryRun = run.mode === 'dry_run';
  return new Map(rows.map((r) => [String(r.scheduled_service_id), { ...r, dry_run: dryRun }]));
}

// The newest day re-plan plan (last NIGHT_LOG_HOURS) for each same-day visit's own
// day and technician: a map of `date|tech` to a map of visit id to the reason it
// keeps its hour.
async function loadReplanFixed(apart, now = new Date(), conn = db) {
  const visits = apart.filter((p) => p.first.date === p.second.date).flatMap((p) => [p.first, p.second]).filter((v) => v.tech);
  if (!visits.length) return new Map();
  const rows = await conn('day_replan_plans')
    .whereIn('service_date', [...new Set(visits.map((v) => v.date))])
    .whereIn('technician_id', [...new Set(visits.map((v) => v.tech))])
    .where('created_at', '>=', new Date(now.getTime() - NIGHT_LOG_HOURS * 3600000))
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .select('service_date', 'technician_id', 'fixed');
  const plans = new Map();
  for (const row of rows) {
    const key = replanKey(dateOnlyString(row.service_date), String(row.technician_id));
    if (plans.has(key)) continue; // newest first: the first row per day and route wins
    const fixed = Array.isArray(row.fixed) ? row.fixed : [];
    plans.set(key, new Map(fixed.filter((f) => f && f.id != null).map((f) => [String(f.id), f.why])));
  }
  return plans;
}

async function loadShortDrives(conn = db) {
  const rows = await conn('visit_gps_legs')
    .where({ status: 'matched', drive_from_kind: 'visit' })
    .where('drive_miles', '<', SHORT_DRIVE_MILES)
    .orderBy([{ column: 'service_date' }, { column: 'gps_arrived_at' }, { column: 'scheduled_service_id' }])
    .select('scheduled_service_id', 'technician_id', 'service_date', 'gps_arrived_at', 'leg_group_key', 'drive_miles', 'drive_minutes');
  const legs = physicalLegs(rows);
  const first = await conn('visit_gps_legs').where({ status: 'matched' }).min('service_date as first').first();
  return { ...shortDriveSummary(legs), since: first?.first ? dateOnlyString(first.first) : null };
}

async function loadWeek(now = new Date(), conn = db) {
  const weekStart = etWeekStart(now);
  const stops = await loadStops(etDateString(addETDays(now, -PAIR_DAYS_BACK)), etDateString(addETDays(now, PAIR_DAYS_AHEAD)), conn);
  const apart = findApartPairs(stops, { from: etDateString(now), until: etDateString(addETDays(now, LOOKAHEAD_DAYS)) });
  // Reasons only for the lines the notification shows; the whole set still counts and rings.
  const shown = apart.slice(0, MAX_LINES);
  const twoDays = shown.filter((p) => p.first.date !== p.second.date);
  const nightLog = await loadNightLog([...new Set(twoDays.flatMap((p) => [p.first.id, p.second.id]))], now, conn);
  const replan = await loadReplanFixed(shown, now, conn);
  const drives = await loadShortDrives(conn);
  return { weekStart, apart, nightLog, replan, drives };
}

// ------------------------------------------------------------- run + marker

const weekStartMs = (now) => parseETDateTime(`${etWeekStart(now)}T00:00`).getTime();

async function markerAt(conn = db) {
  const row = await conn('ops_email_send_state').where({ email_key: DEDUPE_KEY }).first('last_sent_at');
  return row?.last_sent_at ? ms(row.last_sent_at) : null;
}

// True once this ET week's check has run (the marker is stamped at or after its
// Monday 00:00). A read failure runs anyway: a rerun refreshes the one row, and a
// refresh rings only when a split joined since.
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
      .insert({ email_key: DEDUPE_KEY, last_sent_at: now, updated_at: now })
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
  const pairs = data.apart.length;
  let outcome;
  try {
    outcome = await (opts.writeAlert || writeAlert)(composeWeeklyCheck(data), now);
  } catch (err) {
    logger.error(`[near-stops-weekly] alert write failed (${err.code || err.name || 'error'})`);
    return { sent: false, error: true, pairs };
  }
  await (opts.stampSendMarker || stampSendMarker)();
  return { sent: outcome === 'raised', outcome, pairs };
}

module.exports = {
  runNearStopsWeeklyCheck,
  weekIsMissing,
  DEDUPE_KEY,
  _private: {
    buildPlaces,
    nearPairs,
    pairSplits,
    findApartPairs,
    holdFor,
    replanHoldFor,
    loadNightLog,
    loadReplanFixed,
    loadStops,
    physicalLegs,
    shortDriveSummary,
    composeWeeklyCheck,
    ringOnNewPair,
    writeAlert,
    loadWeek,
    sentRecently,
    HOLD_WORDS,
  },
};
