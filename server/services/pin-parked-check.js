'use strict';

/**
 * Pin check after a visit (GATE_PIN_PARKED_CHECK, owner "build guardrail" 2026-10-09).
 *
 * Why: a customer's map pin can be hundreds of metres from the property (a coarse Google point for a new street,
 * a commercial boulevard, a sales centre, a condo community). The GPS arrival detector needs the truck inside
 * gps_arrival.radius_meters (175 m by default), so those visits never arrive on their own. The fix is the
 * existing staff action verify_pin with the truck's parked point as the new pin. This job FINDS those customers
 * and SUGGESTS the parked point. A person confirms it; nothing here changes a pin.
 *
 * Once a day, for visits COMPLETED in the last 2 ET days whose technician has a Bouncie vehicle:
 *   1. Destination = the visit's own lat/lng, else the customer's stored pin. The geocoder is never called.
 *      A visit stamped at another address than the customer's primary (a rental, a second property) is skipped.
 *   2. The vehicle's stops on the visit's ET day(s) come from bouncie_webhook_log (bouncie-truck-stops.js).
 *   3. Flag only when ALL hold:
 *        - no stop within the arrival radius of the pin (of the visit's pin, nor of the customer's saved pin);
 *        - the closest stop is farther than the radius, at most 1500 m away, and lasted 10+ minutes
 *          (farther means another vehicle did the visit or the visit was closed without a stop there);
 *        - the customer's review is not verified (with its pin unchanged) and not outside_area;
 *        - that stop is not the vehicle's home base (its usual first start of the day), not inside a business,
 *          personal or supplier geo-fence, and not inside the radius of another customer's visit the same
 *          technician completed that day (the truck was parked for the neighbour);
 *        - the stop is a pin verify_pin would accept (inside the service-area box);
 *        - staff have not dismissed a suggestion for this same pin.
 *   4. ONE open suggestion per customer (customer-pin-suggestions.js); a re-run never duplicates. A later visit
 *      with a stop inside the radius, a verified pin, a changed pin or a deleted customer closes it (superseded).
 *   5. ONE admin notification per new suggestion, keyed on the suggestion id.
 *
 * Needs GATE_GEOCODE_REVIEW on as well (verify_pin is the only way to apply a suggestion).
 * Grouped visits (scheduled_services sharing visit_id) are ONE physical visit. Every fact is read again under a
 * per-customer advisory lock before the write. Sends nothing to a customer. Inert unless GATE_PIN_PARKED_CHECK.
 */
const db = require('../models/db');
const logger = require('./logger');
const { pinParkedCheckLive } = require('../config/feature-gates');
const { distanceMeters, loadArrivalConfig } = require('./gps-arrival-detector');
const truckStops = require('./bouncie-truck-stops');
const { effectiveReview, effectiveCustomer, reviewEnabled } = require('./customer-geocode-review');
const { stampedAddressDiverges } = require('./stamped-address');
const { isInServiceAreaBox } = require('./service-area');
const { raiseAdminAlert } = require('./admin-alert-compose');
const { fitAction, fullName, shortDateET } = require('./admin-alert-names');
const store = require('./customer-pin-suggestions');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const LOG = '[pin-parked-check]';
const REPORT_MIN_STOP_MINUTES = 10;
const MAX_STOP_DISTANCE_M = 1500;
// How far back a visit's scheduled or worked day may be before its truck evidence is not read (the visit is skipped).
const MAX_LOOKBACK_DAYS = 7;
const HOME_LOOKBACK_DAYS = 30;
const HOME_MIN_DAYS = 3;
const FENCE_TYPES = ['business', 'personal', 'supplier'];
const PENDING_BELL_LIMIT = 50;

const usablePin = (lat, lng) => {
  const a = lat == null || lat === '' ? NaN : Number(lat);
  const b = lng == null || lng === '' ? NaN : Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && a !== 0 && b !== 0 ? { lat: a, lng: b } : null;
};

// ET calendar day -> [start, end) in epoch ms.
function etDayBounds(day) {
  const start = parseETDateTime(`${day}T00:00`);
  const next = etDateString(addETDays(start, 1));
  return { startMs: start.getTime(), endMs: parseETDateTime(`${next}T00:00`).getTime() };
}

// ---------- reads ----------

async function loadCompletedVisits(conn, { fromMs, toMs }) {
  const rows = await conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .join('technicians as t', 't.id', 's.technician_id')
    .leftJoin('customer_properties as p', function joinPrimary() {
      this.on('p.customer_id', '=', 'c.id').andOnVal('p.active', '=', true).andOnVal('p.is_primary', '=', true);
    })
    .where('s.status', 'completed')
    .where('s.completed_at', '>=', new Date(fromMs))
    .where('s.completed_at', '<', new Date(toMs))
    .whereNull('c.deleted_at')
    .whereRaw("NULLIF(btrim(t.bouncie_imei), '') IS NOT NULL")
    .orderBy('s.completed_at', 'desc').orderBy('s.id')
    .select(
      's.id', 's.customer_id', 's.technician_id', 's.visit_id', 's.property_id', 's.completed_at', 's.en_route_at', 's.arrived_at',
      conn.raw('s.scheduled_date::text as scheduled_day'),
      's.lat as service_lat', 's.lng as service_lng',
      's.service_address_line1', 's.service_address_city', 's.service_address_zip',
      'c.first_name', 'c.last_name', 'c.address_line1 as customer_address_line1', 'c.address_line2 as customer_address_line2',
      'c.city as customer_city', 'c.state as customer_state', 'c.zip as customer_zip',
      'c.latitude as customer_latitude', 'c.longitude as customer_longitude',
      'p.id as primary_property_id', 'p.address_line1 as primary_address_line1', 'p.address_line2 as primary_address_line2',
      'p.city as primary_city', 'p.state as primary_state', 'p.zip as primary_zip',
      'p.latitude as primary_latitude', 'p.longitude as primary_longitude', 't.bouncie_imei',
    );
  return rows.map((row) => ({ ...row, ...effectivePinColumns(row), bouncie_imei: String(row.bouncie_imei).trim() }));
}

/**
 * The saved pin as the review panel shows it: the review store's own effectiveCustomer (the matching primary
 * property's coordinates win over the customer row's). One definition for judging, verifying, storing and showing.
 */
function effectivePinColumns(row) {
  const pick = (prefix) => ({
    address_line1: row[`${prefix}_address_line1`], address_line2: row[`${prefix}_address_line2`], city: row[`${prefix}_city`],
    state: row[`${prefix}_state`], zip: row[`${prefix}_zip`],
  });
  const customer = { ...pick('customer'), latitude: row.customer_latitude, longitude: row.customer_longitude };
  const primary = row.primary_property_id == null ? null
    : { ...pick('primary'), latitude: row.primary_latitude, longitude: row.primary_longitude };
  const effective = effectiveCustomer(customer, primary);
  return { customer_latitude: effective.latitude, customer_longitude: effective.longitude };
}

/** One row per physical visit: grouped partners (the same visit_id) are the same stop. */
function oneRowPerVisit(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.visit_id ? `v:${row.visit_id}` : `s:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function loadFences(conn) {
  const rows = await conn('geo_fences').where({ is_active: true }).whereIn('fence_type', FENCE_TYPES)
    .select('lat', 'lng', 'radius_meters');
  return rows.map((row) => ({ ...usablePin(row.lat, row.lng), radius: Number(row.radius_meters) || 0 }))
    .filter((fence) => fence.lat != null);
}

/** The cell (about 110 m) most days of the last month began in; null when no cell began 3+ days. Pure. */
function homeBaseFrom(rows) {
  const cells = new Map();
  for (const row of rows) {
    const pin = usablePin(row.start_lat, row.start_lng);
    if (!pin) continue;
    const key = `${pin.lat.toFixed(3)},${pin.lng.toFixed(3)}`;
    const cell = cells.get(key) || { days: 0, lat: 0, lng: 0 };
    cell.days += 1; cell.lat += pin.lat; cell.lng += pin.lng;
    cells.set(key, cell);
  }
  const best = [...cells.values()].sort((a, b) => b.days - a.days)[0];
  return best && best.days >= HOME_MIN_DAYS ? { lat: best.lat / best.days, lng: best.lng / best.days } : null;
}

async function loadHomeBase(conn, imei, now) {
  const since = etDateString(addETDays(now, -HOME_LOOKBACK_DAYS));
  const { rows } = await conn.raw(
    `SELECT DISTINCT ON (trip_date) trip_date, start_lat, start_lng FROM mileage_log
      WHERE vehicle_id = ? AND trip_date >= ? AND start_lat IS NOT NULL AND start_lng IS NOT NULL
      ORDER BY trip_date, created_at`,
    [imei, since],
  );
  return homeBaseFrom(rows || []);
}

// ---------- the flag rules (pure) ----------

/**
 * The ET days a visit's truck evidence may come from: the day it was scheduled and every day it was worked
 * (en route, arrived, completed). A visit done on one day and closed out on a later one needs both.
 */
function visitDays(visit) {
  const stamped = ['en_route_at', 'arrived_at', 'completed_at'].map((key) => (visit[key] ? etDateString(new Date(visit[key])) : null));
  return [...new Set([String(visit.scheduled_day || '').slice(0, 10), ...stamped].filter(Boolean))];
}

/**
 * The days of a visit that must be read before it can be judged: its visitDays up to today (a day still ahead has
 * no truck data to read). `tooOld` when any of them is before the lookback cap: that evidence is not loaded, so the
 * visit is not judged at all.
 */
function requiredDays(visit, now) {
  const today = etDateString(now);
  const cap = etDateString(addETDays(now, -MAX_LOOKBACK_DAYS));
  const days = visitDays(visit).filter((day) => day <= today);
  return { days, tooOld: days.some((day) => day < cap) };
}

/** Where the visit was supposed to be: its own pin, else the customer's. Null for another property or no pin. */
function destinationOf(visit) {
  if (visit.property_id != null && visit.primary_property_id != null
    && String(visit.property_id) !== String(visit.primary_property_id)) return null;
  const own = usablePin(visit.service_lat, visit.service_lng);
  if (own) return stampedAddressDiverges(visit) ? null : own;
  if (stampedAddressDiverges(visit)) return null;
  return usablePin(visit.customer_latitude, visit.customer_longitude);
}

const nearestPinDistance = (pins, stop) => Math.min(...pins.map((pin) => distanceMeters(pin.lat, pin.lng, stop.lat, stop.lng)));
const within = (point, stop, meters) => point && distanceMeters(point.lat, point.lng, stop.lat, stop.lng) <= meters;

/** Why a stop is not this job's stop: home base, a fence, or the neighbour's visit. Null when it could be. */
function excludedStopReason(stop, { radius, home, fences, neighbours }) {
  if (within(home, stop, radius)) return 'home_base';
  if (fences.some((fence) => within(fence, stop, Math.max(radius, fence.radius)))) return 'geo_fence';
  if (neighbours.some((pin) => within(pin, stop, radius))) return 'neighbour_visit';
  return null;
}

/**
 * Judges one visit against the stops of its technician's truck on the visit's day(s).
 * @returns {{flag:false, reason:string} | {flag:true, ...}}
 */
function judgeVisit({ visit, stops, radius, context }) {
  const destination = destinationOf(visit);
  if (!destination) return { flag: false, reason: 'no_pin_or_other_property' };
  const customerPin = usablePin(visit.customer_latitude, visit.customer_longitude);
  const pins = [destination, customerPin].filter(Boolean);
  const measured = stops.map((stop) => ({ stop, metres: nearestPinDistance(pins, stop) }));
  if (measured.some((m) => m.metres <= radius)) return { flag: false, reason: 'stop_at_pin' };
  if (!measured.length) return { flag: false, reason: 'no_stops' };
  const closest = measured.reduce((a, b) => (b.metres < a.metres ? b : a));
  if (closest.metres > MAX_STOP_DISTANCE_M) return { flag: false, reason: 'stop_too_far' };
  if (closest.stop.minutes < REPORT_MIN_STOP_MINUTES) return { flag: false, reason: 'stop_too_short' };
  const excluded = excludedStopReason(closest.stop, { radius, ...context });
  if (excluded) return { flag: false, reason: excluded };
  const pin = customerPin || destination;
  return {
    flag: true,
    pin,
    destination,
    parked: { lat: closest.stop.lat, lng: closest.stop.lng },
    distanceM: Math.round(distanceMeters(pin.lat, pin.lng, closest.stop.lat, closest.stop.lng)),
    stopMinutes: Math.round(closest.stop.minutes),
    stopStartedAt: new Date(closest.stop.startMs),
  };
}

// ---------- the write (one transaction, per-customer lock, everything read again) ----------

const BLOCKED_REVIEW = ['verified', 'outside_area'];

async function recordSuggestion(conn, visit, verdict) {
  try {
    return await conn.transaction(async (trx) => {
      await store.lockCustomer(trx, visit.customer_id);
      // Share lock: a verify_pin on this customer waits for this transaction, so its own "close the
      // suggestion" step always runs after the insert below, never before it.
      const customer = await trx('customers').where({ id: visit.customer_id }).whereNull('deleted_at').forShare().first();
      if (!customer) return { skipped: 'customer_gone' };
      const [review, primary] = await Promise.all([
        trx('customer_geocode_reviews').where({ customer_id: customer.id }).first(),
        trx('customer_properties').where({ customer_id: customer.id, active: true, is_primary: true }).first(),
      ]);
      // The panel's own view of the customer: this is the pin staff see, verify and replace.
      const shown = effectiveCustomer(customer, primary);
      if (BLOCKED_REVIEW.includes(effectiveReview(shown, review).status)) return { skipped: 'review_settled' };
      const pin = usablePin(shown.latitude, shown.longitude);
      if (!pin) return { skipped: 'no_saved_pin' }; // nothing comparable to show staff, so nothing to suggest
      const read = usablePin(visit.customer_latitude, visit.customer_longitude);
      if (!read || !(store.same7(pin.lat, read.lat) && store.same7(pin.lng, read.lng))) return { skipped: 'pin_changed' };
      if (!isInServiceAreaBox(verdict.parked.lat, verdict.parked.lng, { zip: customer.zip })) return { skipped: 'outside_service_area' };
      return await insertSuggestion(trx, visit, verdict, pin);
    });
  } catch (err) {
    if (err?.code === '23505') return { skipped: 'already_open' };
    throw err;
  }
}

async function insertSuggestion(trx, visit, verdict, pin) {
  const dismissed = await trx('customer_pin_suggestions')
    .where({ customer_id: visit.customer_id, status: 'dismissed' })
    .whereRaw('pin_lat = ?::numeric AND pin_lng = ?::numeric', [pin.lat.toFixed(7), pin.lng.toFixed(7)]).first('id');
  if (dismissed) return { skipped: 'dismissed_for_this_pin' };
  const open = await store.openForCustomer(visit.customer_id, trx);
  if (open) {
    if (store.same7(open.pin_lat, pin.lat) && store.same7(open.pin_lng, pin.lng)) return { skipped: 'already_open', row: open };
    await store.closeSuggestion(open.id, 'superseded', {
      reason: 'pin_changed', resolution: 'Closed: the pin changed, a new check replaced this one', conn: trx,
    });
  }
  const [created] = await trx('customer_pin_suggestions').insert({
    customer_id: visit.customer_id,
    scheduled_service_id: visit.id,
    technician_id: visit.technician_id,
    visit_date: etDateString(new Date(visit.completed_at)),
    pin_lat: pin.lat.toFixed(7),
    pin_lng: pin.lng.toFixed(7),
    parked_lat: verdict.parked.lat.toFixed(7),
    parked_lng: verdict.parked.lng.toFixed(7),
    distance_m: verdict.distanceM,
    stop_minutes: verdict.stopMinutes,
    stop_started_at: verdict.stopStartedAt,
    status: 'open',
  }).returning(store.COLUMNS);
  return { created };
}

// ---------- the bell ----------

function alertSpec(row, customer) {
  const name = fullName(customer) || 'a customer';
  const day = shortDateET(new Date(`${store.dayText(row.visit_date)}T12:00:00Z`));
  return {
    area: 'Customers',
    action: fitAction('Customers', name, [(n) => `check the map pin for ${n}`, (n) => `check ${n}'s pin`]),
    why: `Truck parked ${row.distance_m} m from the pin on ${day}; open the customer to fix it.`,
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(row.customer_id)}`,
    subject: { type: 'customer', id: String(row.customer_id) },
    // Closes itself: applying, dismissing or superseding the suggestion closes this row (customer-pin-suggestions.js).
    doneWhen: 'pin_checked',
    who: 'person',
  };
}

function alertDetail(row, customer) {
  const address = [customer.address_line1, customer.city].filter(Boolean).join(', ');
  return [
    address,
    `The truck stood ${row.stop_minutes} minutes, ${row.distance_m} m from the saved pin, during the completed visit.`,
    "Open the customer, review the location and use the truck's spot if the pin is wrong.",
  ].filter(Boolean).join('\n').slice(0, 2000);
}

/**
 * Rings the bell for one open suggestion and stamps notified_at, all inside the per-customer lock that every close
 * path (apply, dismiss, supersede) also takes. The suggestion is read again under the lock: if it is no longer
 * open, nothing is posted. If a close wins the lock later, it finds the bell this transaction committed and closes
 * it. So a settled pin can never be left beside a live bell, whatever the order. The bell is keyed on the
 * suggestion id, so a retry never rings twice.
 */
async function notifyOne(conn, listed) {
  return conn.transaction(async (trx) => {
    await store.lockCustomer(trx, listed.customer_id);
    const row = await trx('customer_pin_suggestions').where({ id: listed.id, status: 'open' }).whereNull('notified_at')
      .forUpdate().first(store.COLUMNS);
    if (!row) return false;
    const customer = await trx('customers').where({ id: row.customer_id }).whereNull('deleted_at')
      .first('first_name', 'last_name', 'address_line1', 'city');
    if (!customer) return false;
    const posted = await raiseAdminAlert('customer', alertSpec(row, customer), {
      bell: true,
      dedupeKey: store.alertKey(row.id),
      detail: alertDetail(row, customer),
      metadata: { customerId: row.customer_id, suggestionId: row.id },
      trx,
    });
    // A suppressed row (a preference or an internal test customer) has nothing left to post, so it counts as done.
    if (!posted || !(posted.id || posted.deduped || posted.suppressed)) return false;
    await trx('customer_pin_suggestions').where({ id: row.id }).update({ notified_at: trx.fn.now() });
    return true;
  });
}

async function postPendingNotifications(conn) {
  const pending = await conn('customer_pin_suggestions').where({ status: 'open' }).whereNull('notified_at')
    .orderBy('created_at').limit(PENDING_BELL_LIMIT).select(store.COLUMNS);
  let posted = 0;
  for (const row of pending) {
    try {
      if (await notifyOne(conn, row)) posted += 1;
    } catch (err) {
      logger.warn(`${LOG} notification failed`, { suggestionId: row.id, error: err.code || err.name });
    }
  }
  return posted;
}

// ---------- closing settled suggestions ----------

/** Open suggestions whose customer is gone, whose pin was verified, or whose saved pin moved or went away. */
async function closeSettledSuggestions(conn) {
  const open = await conn('customer_pin_suggestions').where({ status: 'open' }).select(store.COLUMNS);
  if (!open.length) return 0;
  const ids = open.map((row) => row.customer_id);
  const customers = new Map((await conn('customers').whereIn('id', ids).whereNull('deleted_at').select('*'))
    .map((row) => [String(row.id), row]));
  const reviews = new Map((await conn('customer_geocode_reviews').whereIn('customer_id', ids).select('*'))
    .map((row) => [String(row.customer_id), row]));
  const primaries = new Map((await conn('customer_properties').whereIn('customer_id', ids).where({ active: true, is_primary: true }).select('*'))
    .map((row) => [String(row.customer_id), row]));
  let closed = 0;
  for (const row of open) {
    const found = customers.get(String(row.customer_id));
    const customer = found && effectiveCustomer(found, primaries.get(String(row.customer_id)));
    const reason = settledReason(row, customer, reviews.get(String(row.customer_id)));
    if (reason && await store.closeSuggestion(row.id, 'superseded', { reason, resolution: 'Closed: the pin no longer needs a check', conn })) {
      closed += 1;
    }
  }
  return closed;
}

function settledReason(row, customer, review) {
  if (!customer) return 'customer_gone';
  if (BLOCKED_REVIEW.includes(effectiveReview(customer, review).status)) return 'pin_verified';
  const pin = usablePin(customer.latitude, customer.longitude);
  // No saved pin (revoked, cleared) or a different one: the suggestion no longer describes what staff would see.
  if (!pin || !(store.same7(pin.lat, row.pin_lat) && store.same7(pin.lng, row.pin_lng))) return 'pin_changed';
  return null;
}

// ---------- the run ----------

async function stopsFor(conn, imei, { fromMs, toMs, radius, now }) {
  try {
    return await truckStops.loadTruckStops(conn, imei, { fromMs, toMs, maxGapMeters: radius, now: now.getTime() });
  } catch (err) {
    logger.warn(`${LOG} could not read truck stops`, { error: err.code || err.name });
    return null;
  }
}

/**
 * Where the same technician's OTHER customers' visits that day were. Deliberately generous, because it only ever
 * prevents a suggestion: a truck stop at another customer's job is that customer's, not ours. For each such visit
 * both its own stamped coordinates (whatever property it was at, a secondary one included) and the customer's
 * effective primary pin count; a stop near either is excluded.
 */
const neighbourPins = (visit, visits) => visits
  .filter((other) => other.technician_id === visit.technician_id && other.customer_id !== visit.customer_id
    && visitDays(other).some((day) => visitDays(visit).includes(day)))
  .flatMap((other) => [
    usablePin(other.service_lat, other.service_lng),
    usablePin(other.customer_latitude, other.customer_longitude),
  ])
  .filter(Boolean);

const tallyKey = (tally, key) => { tally[key] = (tally[key] || 0) + 1; };

/**
 * Each vehicle's stops and home base. One paged read per vehicle over the union of every day its visits need
 * (visitDays, capped at MAX_LOOKBACK_DAYS back). A vehicle whose stops cannot be read maps to null; a vehicle
 * none of whose visits can be judged is not read at all.
 */
async function loadVehicles(conn, visits, window) {
  const vehicles = new Map();
  for (const imei of new Set(visits.map((visit) => visit.bouncie_imei))) {
    const needed = visits.filter((visit) => visit.bouncie_imei === imei)
      .map((visit) => requiredDays(visit, window.now)).filter((r) => !r.tooOld).flatMap((r) => r.days).sort();
    if (!needed.length) { vehicles.set(imei, { stops: [], home: null }); continue; }
    const stops = await stopsFor(conn, imei, { ...window, fromMs: etDayBounds(needed[0]).startMs });
    vehicles.set(imei, stops ? { stops, home: await loadHomeBase(conn, imei, window.now).catch(() => null) } : null);
  }
  return vehicles;
}

/**
 * One verdict per visit, judged against its own technician's truck. A visit whose truck data could not be read, or
 * one of whose required days is before the lookback cap, is `unknown`: no suggestion, nothing closed from it.
 */
function judgeVisits(visits, vehicles, { radius, fences, now }) {
  return visits.map((visit) => {
    const vehicle = vehicles.get(visit.bouncie_imei);
    const required = requiredDays(visit, now);
    if (required.tooOld) return { visit, verdict: { flag: false, reason: 'days_not_loaded', unknown: true } };
    if (!vehicle) return { visit, verdict: { flag: false, reason: 'stops_unreadable', unknown: true } };
    const stops = vehicle.stops.filter((stop) => required.days.includes(etDateString(new Date(stop.startMs))));
    const context = { home: vehicle.home, fences, neighbours: neighbourPins(visit, visits) };
    return { visit, verdict: judgeVisit({ visit, stops, radius, context }) };
  });
}

/**
 * ONE decision for a customer, from every visit of theirs in the window (every technician, every truck):
 *   ok    some visit had a stop inside the arrival radius, so the pin works: close any open suggestion, create none
 *   skip  no such stop, but a truck's data could not be read, so the pin cannot be judged today
 *   flag  none had a stop at the pin and at least one qualifies: suggest from the NEWEST qualifying visit
 *   none  nothing to say
 */
function decideCustomer(judged) {
  if (judged.some((j) => j.verdict.reason === 'stop_at_pin')) return { action: 'ok' };
  if (judged.some((j) => j.verdict.unknown)) return { action: 'skip' };
  const flagged = judged.filter((j) => j.verdict.flag)
    .sort((a, b) => new Date(b.visit.completed_at) - new Date(a.visit.completed_at));
  return flagged.length ? { action: 'flag', visit: flagged[0].visit, verdict: flagged[0].verdict } : { action: 'none' };
}

async function applyDecision(conn, customerId, decision, openByCustomer, tally) {
  const open = openByCustomer.get(String(customerId));
  if (decision.action === 'ok' && open) {
    const closed = await store.closeSuggestion(open.id, 'superseded', {
      reason: 'stop_at_pin', resolution: 'Closed: the truck stopped at the pin', conn,
    });
    if (closed) tally.closed += 1;
  } else if (decision.action === 'flag') {
    const result = await recordSuggestion(conn, decision.visit, decision.verdict);
    if (result.created) tally.created += 1;
  }
}

/**
 * The daily run. Never throws for one bad vehicle or customer; returns counts. Gate off = nothing is read.
 * @returns {Promise<{skipped?:string, visits?:number, created?:number, closed?:number, notified?:number}>}
 */
async function runPinParkedCheck({ now = new Date(), conn = db } = {}) {
  if (!pinParkedCheckLive()) return { skipped: 'gated' };
  // The suggestion is applied through verify_pin, which needs address review on. Without it a bell would have no action.
  if (!reviewEnabled()) return { skipped: 'review_disabled' };
  const radius = (await loadArrivalConfig()).radiusMeters;
  const days = [etDateString(addETDays(now, -1)), etDateString(now)];
  const window = { fromMs: etDayBounds(days[0]).startMs, toMs: etDayBounds(days[1]).endMs, radius, now };
  const tally = { created: 0, closed: 0 };
  tally.closed += await closeSettledSuggestions(conn);
  const visits = oneRowPerVisit(await loadCompletedVisits(conn, window));
  const openByCustomer = new Map((await conn('customer_pin_suggestions').where({ status: 'open' }).select(store.COLUMNS))
    .map((row) => [String(row.customer_id), row]));
  const vehicles = await loadVehicles(conn, visits, window);
  const judged = judgeVisits(visits, vehicles, { radius, fences: await loadFences(conn), now });
  for (const { verdict } of judged) tallyKey(tally, verdict.flag ? 'flagged' : verdict.reason);
  const byCustomer = new Map();
  for (const j of judged) byCustomer.set(String(j.visit.customer_id), [...(byCustomer.get(String(j.visit.customer_id)) || []), j]);
  for (const [customerId, group] of byCustomer) {
    try {
      await applyDecision(conn, customerId, decideCustomer(group), openByCustomer, tally);
    } catch (err) {
      logger.warn(`${LOG} customer skipped`, { customerId, error: err.code || err.name });
    }
  }
  const notified = await postPendingNotifications(conn);
  logger.info(`${LOG} done`, { visits: visits.length, ...tally, notified });
  return { visits: visits.length, notified, ...tally };
}

module.exports = {
  runPinParkedCheck,
  _private: {
    judgeVisit, destinationOf, homeBaseFrom, visitDays, etDayBounds, oneRowPerVisit, excludedStopReason, alertSpec,
    alertDetail, settledReason, requiredDays, judgeVisits, loadVehicles, neighbourPins, effectivePinColumns, decideCustomer, notifyOne, recordSuggestion, closeSettledSuggestions, postPendingNotifications, loadCompletedVisits,
    REPORT_MIN_STOP_MINUTES, MAX_STOP_DISTANCE_M,
  },
};
