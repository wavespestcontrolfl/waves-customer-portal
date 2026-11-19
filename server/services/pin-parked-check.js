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
 * Once a day, for visits COMPLETED in the last 3 ET days (COMPLETED_WINDOW_DAYS) whose technician has a Bouncie vehicle:
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
 *        - these two are not BOTH true: the truck also parked at the pin on the ET day of that closest stop (too
 *          briefly to count as a stop), and the closest stop stands inside the radius of another customer's saved
 *          pin. Together they mean the technician did come to the pin and the long stop was the other customer's
 *          (clearStopsAtOtherCustomers);
 *        - the stop is a pin verify_pin would accept (inside the service-area box);
 *        - staff have not dismissed a suggestion for this same pin.
 *   4. ONE open suggestion per customer (customer-pin-suggestions.js); a re-run never duplicates. A later visit
 *      with a stop inside the radius, a verified pin, a changed pin or a deleted customer closes it (superseded).
 *      So does the two-fact rule of step 3, judged again on the suggestion's own parked spot and day with the truck
 *      data of the visit it was made from (late data can show the short stop at the pin): suggestionExplained. That
 *      visit is read again by id even after it left the window (up to the lookback cap), and only the technician who
 *      made the suggestion counts.
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
const { isInServiceAreaBox } = require('./service-area');
const { raiseAdminAlert } = require('./admin-alert-compose');
const { fitAction, fullName, shortDateET } = require('./admin-alert-names');
const store = require('./customer-pin-suggestions');
const {
  usablePin, isWithin, within, etDayBounds, completedVisitQuery, shapeVisits, effectivePinColumns, oneRowPerVisit,
  loadFences, homeBaseFrom, homeSince, loadHomeBase, dayBeforeMapping, destinationOf,
} = require('./visit-gps-context');
const { etDateString, addETDays } = require('../utils/datetime-et');

const LOG = '[pin-parked-check]';
const REPORT_MIN_STOP_MINUTES = 10;
const MAX_STOP_DISTANCE_M = 1500;
// How far back a visit's scheduled or worked day may be before its truck evidence is not read (the visit is skipped).
const MAX_LOOKBACK_DAYS = 7;
const PENDING_BELL_LIMIT = 50;
const COMPLETED_WINDOW_DAYS = 3;
const RETIRE_LIMIT = 500;
const NEIGHBOUR_LIMIT = 2000;
// The shortest parked gap read from the truck. A gap shorter than the stop rule's own floor (bouncie-truck-stops
// MIN_STOP_MINUTES) is never a stop: it cannot settle a pin and cannot be suggested. It is read only as "the truck
// came to the pin" (briefPinDays).
const BRIEF_STOP_MIN_MINUTES = 1;

// ---------- reads ----------

async function loadCompletedVisits(conn, { fromMs, toMs }) {
  return shapeVisits(await completedVisitQuery(conn)
    .where('s.completed_at', '>=', new Date(fromMs))
    .where('s.completed_at', '<', new Date(toMs)));
}

/**
 * The same technicians' OTHER completed visits that touch the evidence days of the judged visits, whenever they were
 * completed: a delayed visit worked on an older day needs that day's other jobs to tell a neighbour's stop from its
 * own. Bounded by the technicians, the days (never past the lookback cap, see requiredDays) and a row limit.
 */
async function loadNeighbourVisits(conn, visits, now) {
  const technicianIds = [...new Set(visits.map((visit) => visit.technician_id))];
  const days = [...new Set(visits.flatMap((visit) => requiredDays(visit, now).days))].sort();
  if (!technicianIds.length || !days.length) return [];
  const first = etDayBounds(days[0]).startMs;
  const last = etDayBounds(days[days.length - 1]).endMs;
  const known = new Set(visits.map((visit) => visit.id));
  const rows = shapeVisits(await completedVisitQuery(conn)
    .whereIn('s.technician_id', technicianIds)
    .where(function inDays() {
      this.whereBetween('s.scheduled_date', [days[0], days[days.length - 1]])
        .orWhere(function worked() {
          this.where('s.completed_at', '>=', new Date(first)).where('s.completed_at', '<', new Date(last));
        });
    })
    .limit(NEIGHBOUR_LIMIT));
  return oneRowPerVisit(rows.filter((row) => !known.has(row.id) && visitDays(row).some((day) => days.includes(day))));
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
  // The tracker remap rule (visit-gps-context.js dayBeforeMapping): a day that starts before the mapping changed
  // may belong to another vehicle, so it cannot be judged.
  const beforeMapping = days.some((day) => dayBeforeMapping(day, visit.mapping_changed_at));
  const tooOld = days.some((day) => day < cap);
  return { days, tooOld, beforeMapping, unloadable: tooOld || beforeMapping };
}

/** The shortest measurable distance from a stop to any of the pins; null when none could be measured. */
const nearestPinDistance = (pins, stop) => {
  const measured = pins.map((pin) => distanceMeters(pin.lat, pin.lng, stop.lat, stop.lng)).filter((d) => d != null);
  return measured.length ? Math.min(...measured) : null;
};

/** The ET day a stop began. */
const stopDay = (stop) => etDateString(new Date(stop.startMs));

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
  // "A stop at the pin" is generous: a stop near the visit's own stamp OR the saved pin means the pin works.
  if (stops.some((stop) => isWithin(nearestPinDistance(pins, stop), radius))) return { flag: false, reason: 'stop_at_pin' };
  if (!stops.length) return { flag: false, reason: 'no_stops' };
  // Everything that picks or limits the suggested stop is measured from the saved pin: the pin the suggestion would replace.
  if (!customerPin) return { flag: false, reason: 'no_saved_pin' };
  const measured = stops.map((stop) => ({ stop, metres: nearestPinDistance([customerPin], stop) })).filter((m) => m.metres != null);
  if (!measured.length) return { flag: false, reason: 'no_stops' };
  const closest = measured.reduce((a, b) => (b.metres < a.metres ? b : a));
  if (closest.metres > MAX_STOP_DISTANCE_M) return { flag: false, reason: 'stop_too_far' };
  if (closest.stop.minutes < REPORT_MIN_STOP_MINUTES) return { flag: false, reason: 'stop_too_short' };
  const excluded = excludedStopReason(closest.stop, { radius, ...context });
  if (excluded) return { flag: false, reason: excluded };
  const pin = customerPin;
  return {
    flag: true,
    pin,
    destination,
    parked: { lat: closest.stop.lat, lng: closest.stop.lng },
    distanceM: Math.round(closest.metres),
    stopMinutes: Math.round(closest.stop.minutes),
    stopStartedAt: new Date(closest.stop.startMs),
  };
}

// ---------- the write (one transaction, per-customer lock, everything read again) ----------

const BLOCKED_REVIEW = ['verified', 'outside_area'];

const samePoint = (aLat, aLng, bLat, bLng) => {
  const a = usablePin(aLat, aLng);
  const b = usablePin(bLat, bLng);
  return a == null || b == null ? a == null && b == null : store.same7(a.lat, b.lat) && store.same7(a.lng, b.lng);
};

/**
 * The verdict was built on a snapshot read earlier in the run. Under the customer's locks, read the visit and its
 * technician's tracker mapping again: if the visit was reassigned, moved, reopened, or the technician was pointed at
 * another device since, the evidence no longer describes it and nothing is suggested. Plain reads: no new lock.
 */
async function visitUnchanged(trx, visit) {
  const now = await trx('scheduled_services as s').join('technicians as t', 't.id', 's.technician_id').where('s.id', visit.id)
    .first('s.technician_id', 's.customer_id', 's.status', 's.lat', 's.lng', 't.bouncie_imei', 't.bouncie_imei_changed_at');
  if (!now || now.status !== 'completed') return false;
  if (String(now.technician_id) !== String(visit.technician_id) || String(now.customer_id) !== String(visit.customer_id)) return false;
  if (!samePoint(now.lat, now.lng, visit.service_lat, visit.service_lng)) return false;
  if (String(now.bouncie_imei || '').trim() !== visit.bouncie_imei) return false;
  const before = visit.mapping_changed_at ? new Date(visit.mapping_changed_at).getTime() : null;
  const after = now.bouncie_imei_changed_at ? new Date(now.bouncie_imei_changed_at).getTime() : null;
  return before === after;
}

async function recordSuggestion(conn, visit, verdict) {
  try {
    return await conn.transaction(async (trx) => {
      await store.lockCustomer(trx, visit.customer_id);
      // lockCustomer took the row FOR SHARE first: a verify_pin or merge on this customer waits for this
      // transaction, so its own "close the suggestion" step runs after the insert below, never before it.
      const customer = await trx('customers').where({ id: visit.customer_id }).whereNull('deleted_at').first();
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
      if (!(await visitUnchanged(trx, visit))) return { skipped: 'visit_changed' };
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
    // The ET day the truck stood there (not the day the visit was closed out): it is shown as exactly that.
    visit_date: etDateString(verdict.stopStartedAt),
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
    return await truckStops.loadTruckStops(conn, imei, {
      fromMs, toMs, maxGapMeters: radius, now: now.getTime(), minMinutes: BRIEF_STOP_MIN_MINUTES,
    });
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

/** Gate off: every open suggestion becomes superseded and its bell closes. Bounded; the rest goes at the next run. */
async function retireAllOpen(conn) {
  try {
    const open = await conn('customer_pin_suggestions').where({ status: 'open' }).orderBy('created_at').limit(RETIRE_LIMIT).select('id');
    let retired = 0;
    for (const { id } of open) {
      if (await store.closeSuggestion(id, 'superseded', { reason: 'gate_off', resolution: 'Closed: the pin check was switched off', conn })) retired += 1;
    }
    return retired;
  } catch (err) {
    logger.warn(`${LOG} could not retire open suggestions`, { error: err.code || err.name });
    return 0;
  }
}

const tallyKey = (tally, key) => { tally[key] = (tally[key] || 0) + 1; };

/**
 * Each vehicle's stops and home base. One paged read per vehicle over the union of every day its visits need
 * (visitDays, capped at MAX_LOOKBACK_DAYS back). A vehicle whose stops cannot be read maps to null; a vehicle
 * none of whose visits can be judged is not read at all.
 */
/** The newest tracker-mapping instant among a vehicle's visits (one technician owns an imei); null when none. */
function latestMapping(visits, imei) {
  const times = visits.filter((visit) => visit.bouncie_imei === imei && visit.mapping_changed_at)
    .map((visit) => new Date(visit.mapping_changed_at).getTime()).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)) : null;
}

/** A vehicle with its home base. A home-base lookup that fails makes the vehicle unknown, like an unreadable stop query. */
async function withHomeBase(conn, imei, stops, now, mappingChangedAt) {
  try {
    return { stops, home: await loadHomeBase(conn, imei, now, mappingChangedAt) };
  } catch (err) {
    logger.warn(`${LOG} could not read the home base`, { error: err.code || err.name });
    return null;
  }
}

async function loadVehicles(conn, visits, window) {
  const vehicles = new Map();
  for (const imei of new Set(visits.map((visit) => visit.bouncie_imei))) {
    const needed = visits.filter((visit) => visit.bouncie_imei === imei)
      .map((visit) => requiredDays(visit, window.now)).filter((r) => !r.unloadable).flatMap((r) => r.days).sort();
    if (!needed.length) { vehicles.set(imei, { stops: [], home: null }); continue; }
    const stops = await stopsFor(conn, imei, { ...window, fromMs: etDayBounds(needed[0]).startMs });
    vehicles.set(imei, stops ? await withHomeBase(conn, imei, stops, window.now, latestMapping(visits, imei)) : null);
  }
  return vehicles;
}

/**
 * The ET days on which the truck parked inside the arrival radius of the visit's pins (its stamp or the customer's
 * saved pin, as generous as "a stop at the pin") for less than truckStops.MIN_STOP_MINUTES. Never a stop: it cannot
 * settle a pin and cannot be suggested. It only says "the truck did come to the pin that day", before or after the
 * long stop (clearStopsAtOtherCustomers, suggestionExplained).
 */
function briefPinDays(visit, briefStops, radius) {
  const pins = [destinationOf(visit), usablePin(visit.customer_latitude, visit.customer_longitude)].filter(Boolean);
  return [...new Set(briefStops.filter((stop) => isWithin(nearestPinDistance(pins, stop), radius)).map(stopDay))].sort();
}

/**
 * One verdict per visit, judged against its own technician's truck. A visit whose truck data could not be read, or
 * one of whose required days is before the lookback cap, is `unknown`: no suggestion, nothing closed from it.
 */
function judgeVisits(visits, vehicles, { radius, fences, now, pool = visits }) {
  return visits.map((visit) => {
    const vehicle = vehicles.get(visit.bouncie_imei);
    const required = requiredDays(visit, now);
    if (required.unloadable) return { visit, verdict: { flag: false, reason: 'days_not_loaded', unknown: true } };
    if (!vehicle) return { visit, verdict: { flag: false, reason: 'stops_unreadable', unknown: true } };
    const parked = vehicle.stops.filter((stop) => required.days.includes(stopDay(stop)));
    // The stop rules see the same stops as before; a shorter parked gap is kept apart and can only clear a flag.
    const isStop = (stop) => stop.minutes >= truckStops.MIN_STOP_MINUTES;
    const context = { home: vehicle.home, fences, neighbours: neighbourPins(visit, pool) };
    return {
      visit,
      verdict: judgeVisit({ visit, stops: parked.filter(isStop), radius, context }),
      briefPinDays: briefPinDays(visit, parked.filter((stop) => !isStop(stop)), radius),
    };
  });
}

// The distance from a row's pin to a point, in metres, as distanceMeters measures it (same sphere). The column names
// are fixed text from this file; the point and the radius are bindings.
const withinSql = (lat, lng) => `2 * 6371000 * asin(least(1, sqrt(`
  + `power(sin(radians(${lat}::float8 - ?) / 2), 2)`
  + ` + cos(radians(?)) * cos(radians(${lat}::float8)) * power(sin(radians(${lng}::float8 - ?) / 2), 2)))) <= ?`;

/**
 * Is another customer's saved pin inside `radius` of this point? The customer row's coordinates and every active
 * property's count (a rental, a second home), as generous as the neighbour rule. The query itself measures the
 * distance, so one matching row answers it however many pins stand around the point; the box only spares the
 * arithmetic for rows that are far away.
 */
async function otherCustomerPinNear(conn, customerId, point, radius) {
  const latPad = (radius * 1.05) / 110000;
  const lngPad = (radius * 1.05) / (110000 * Math.cos((point.lat * Math.PI) / 180));
  const near = (query, lat, lng) => query
    .whereBetween(lat, [point.lat - latPad, point.lat + latPad])
    .whereBetween(lng, [point.lng - lngPad, point.lng + lngPad])
    .whereRaw(withinSql(lat, lng), [point.lat, point.lat, point.lng, radius])
    .first('c.id');
  const [customer, property] = await Promise.all([
    near(conn('customers as c').whereNull('c.deleted_at').whereNot('c.id', customerId), 'c.latitude', 'c.longitude'),
    near(conn('customer_properties as p').join('customers as c', 'c.id', 'p.customer_id')
      .whereNull('c.deleted_at').whereNot('c.id', customerId).where('p.active', true), 'p.latitude', 'p.longitude'),
  ]);
  return Boolean(customer || property);
}

/**
 * A flagged visit is not a wrong pin when BOTH hold: the truck also parked at this customer's pin on the ET day of the
 * long stop, too briefly to be a stop (entry.briefPinDays), and the long stop stands inside the arrival radius of
 * ANOTHER customer's saved pin. The technician did come to the pin; the long stop was the other customer's. The
 * order of the two does not matter (the other customer's job first, then nobody home here, is the same day seen
 * from the other end). Seen on 2026-11-16:
 * nobody was home, the truck left after 3 minutes and stood 29 minutes at a customer 310 m away who had no
 * completed visit that day, so the neighbour rule did not see them, and the bell offered to move a correct pin
 * to the other customer's house.
 *
 * Either fact alone still flags. A brief stop at a wrong pin is how a technician who follows the map finds out the
 * pin is wrong, and on a dense street the right house is often near another customer's.
 *
 * A read that fails leaves the visit unknown: no suggestion from evidence that was not read.
 */
async function clearStopsAtOtherCustomers(conn, judged, radius) {
  for (const entry of judged) {
    const { verdict } = entry;
    if (!verdict.flag || !(entry.briefPinDays || []).includes(etDateString(verdict.stopStartedAt))) continue;
    try {
      if (await otherCustomerPinNear(conn, entry.visit.customer_id, verdict.parked, radius)) {
        entry.verdict = { flag: false, reason: 'other_customer_stop' };
      }
    } catch (err) {
      logger.warn(`${LOG} could not read other customers' pins`, { error: err.code || err.name });
      entry.verdict = { flag: false, reason: 'other_pins_unreadable', unknown: true };
    }
  }
  return judged;
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

/**
 * Does the two-fact rule (clearStopsAtOtherCustomers) explain this OPEN suggestion? It is judged on the suggestion
 * itself: its parked spot, the ET day the truck stood there, and the truck data of the visit it was made from, read
 * again today (late data can show the short stop at the pin after the suggestion was made). `entryById` holds every
 * judged visit of the run and the source visits (loadSourceVisits), by scheduled service id. Today's verdict for that
 * visit does not matter: an exclusion that only prevents a new suggestion (home base, a fence, a neighbour's visit)
 * does not hide it, and a newer closest stop does not stand in for the suggestion's own.
 * A read that fails answers no: the suggestion stays as it was.
 */
async function suggestionExplained(conn, open, entryById, radius) {
  const spot = usablePin(open.parked_lat, open.parked_lng);
  const source = entryById.get(String(open.scheduled_service_id || ''));
  if (!spot || !open.stop_started_at || !source) return false;
  // Only the truck that made the suggestion: a visit moved to another technician since carries another truck's data.
  // (A technician pointed at another device since is unloadable for those days: requiredDays.)
  if (String(source.visit.technician_id) !== String(open.technician_id)) return false;
  if (!(source.briefPinDays || []).includes(etDateString(new Date(open.stop_started_at)))) return false;
  try {
    return await otherCustomerPinNear(conn, open.customer_id, spot, radius);
  } catch (err) {
    logger.warn(`${LOG} could not check an open suggestion against other customers' pins`, { error: err.code || err.name });
    return false;
  }
}

async function applyDecision(conn, customerId, decision, openByCustomer, tally) {
  const open = openByCustomer.get(String(customerId));
  if (decision.action === 'ok') {
    if (!open) return;
    const closed = await store.closeSuggestion(open.id, 'superseded', {
      reason: 'stop_at_pin', resolution: 'Closed: the truck stopped at the pin', conn,
    });
    if (closed) tally.closed += 1;
    return;
  }
  // Retired BEFORE a newer visit's suggestion is recorded: insertSuggestion keeps an open suggestion for the same
  // pin ("already_open"), which would leave the explained truck spot on offer.
  if (open && decision.retireOpen) {
    const closed = await store.closeSuggestion(open.id, 'superseded', {
      reason: 'other_customer_stop', resolution: "Closed: the truck also came to the pin that day; the long stop was at another customer's", conn,
    });
    if (closed) tally.closed += 1;
  }
  if (decision.action === 'flag') {
    const result = await recordSuggestion(conn, decision.visit, decision.verdict);
    if (result.created) tally.created += 1;
  }
}

/**
 * The visits open suggestions were made from that are not among this run's visits: one left the window (a run was
 * missed), or a grouped partner is the row oneRowPerVisit kept. Read again by id only so suggestionExplained can
 * judge each suggestion on its own visit's truck data. They never make a suggestion and decide nothing else. A visit
 * with a day past the lookback cap is unloadable (requiredDays): its truck is not read. A failed read reads nothing.
 */
async function loadSourceVisits(conn, openByCustomer, visits) {
  const known = new Set(visits.map((visit) => String(visit.id)));
  const ids = [...openByCustomer.values()].map((row) => row.scheduled_service_id)
    .filter((id) => id && !known.has(String(id))).slice(0, RETIRE_LIMIT);
  if (!ids.length) return [];
  try {
    return shapeVisits(await completedVisitQuery(conn).whereIn('s.id', ids));
  } catch (err) {
    logger.warn(`${LOG} could not read the visits of open suggestions`, { error: err.code || err.name });
    return [];
  }
}

/**
 * One decision per customer with a visit in the window. A customer with an open suggestion and no visit in the
 * window decides nothing: only the suggestion is judged again (suggestionExplained).
 */
async function applyDecisions(conn, { judged, sources, openByCustomer, radius, tally }) {
  const entryById = new Map([...sources, ...judged].map((entry) => [String(entry.visit.id), entry]));
  const byCustomer = new Map([...openByCustomer.keys()].map((customerId) => [customerId, []]));
  for (const j of judged) byCustomer.set(String(j.visit.customer_id), [...(byCustomer.get(String(j.visit.customer_id)) || []), j]);
  for (const [customerId, group] of byCustomer) {
    try {
      const decision = decideCustomer(group);
      const open = openByCustomer.get(customerId);
      const retireOpen = decision.action !== 'ok' && Boolean(open) && await suggestionExplained(conn, open, entryById, radius);
      await applyDecision(conn, customerId, { ...decision, retireOpen }, openByCustomer, tally);
    } catch (err) {
      logger.warn(`${LOG} customer skipped`, { customerId, error: err.code || err.name });
    }
  }
}

/**
 * The daily run. Never throws for one bad vehicle or customer; returns counts. Gate off = nothing is read.
 * @returns {Promise<{skipped?:string, visits?:number, created?:number, closed?:number, notified?:number}>}
 */
async function runPinParkedCheck({ now = new Date(), conn = db } = {}) {
  // Rollback is clean: with the gate off (or address review off, so a suggestion could not be applied) the run
  // retires whatever is still open, once, in a bounded pass, and does nothing else.
  if (!pinParkedCheckLive()) return { skipped: 'gated', retired: await retireAllOpen(conn) };
  if (!reviewEnabled()) return { skipped: 'review_disabled', retired: await retireAllOpen(conn) };
  const radius = (await loadArrivalConfig()).radiusMeters;
  // Visits completed in the last COMPLETED_WINDOW_DAYS ET days (today included). Telemetry can arrive up to 12 hours
  // late, so a visit closed late yesterday is judged again today and the day after: every visit gets at least one
  // run after its grace period. Decisions are idempotent per customer, so judging a visit again is harmless.
  const days = [etDateString(addETDays(now, -(COMPLETED_WINDOW_DAYS - 1))), etDateString(now)];
  const window = { fromMs: etDayBounds(days[0]).startMs, toMs: etDayBounds(days[1]).endMs, radius, now };
  const tally = { created: 0, closed: 0 };
  tally.closed += await closeSettledSuggestions(conn);
  const visits = oneRowPerVisit(await loadCompletedVisits(conn, window));
  const openByCustomer = new Map((await conn('customer_pin_suggestions').where({ status: 'open' }).select(store.COLUMNS))
    .map((row) => [String(row.customer_id), row]));
  const sourceVisits = await loadSourceVisits(conn, openByCustomer, visits);
  const vehicles = await loadVehicles(conn, [...visits, ...sourceVisits], window);
  const pool = [...visits, ...await loadNeighbourVisits(conn, visits, now)];
  const fences = await loadFences(conn);
  const judged = await clearStopsAtOtherCustomers(conn, judgeVisits(visits, vehicles, { radius, fences, now, pool }), radius);
  for (const { verdict } of judged) tallyKey(tally, verdict.flag ? 'flagged' : verdict.reason);
  // The source visits are judged for their truck data only (briefPinDays); their verdicts decide nothing.
  const sources = judgeVisits(sourceVisits, vehicles, { radius, fences, now, pool });
  await applyDecisions(conn, { judged, sources, openByCustomer, radius, tally });
  const notified = await postPendingNotifications(conn);
  logger.info(`${LOG} done`, { visits: visits.length, ...tally, notified });
  return { visits: visits.length, notified, ...tally };
}

module.exports = {
  runPinParkedCheck,
  _private: {
    judgeVisit, destinationOf, homeBaseFrom, visitDays, etDayBounds, oneRowPerVisit, excludedStopReason, alertSpec,
    alertDetail, settledReason, visitUnchanged, homeSince, loadNeighbourVisits, usablePin, isWithin, nearestPinDistance, retireAllOpen, requiredDays, judgeVisits, loadVehicles, neighbourPins, effectivePinColumns, decideCustomer, notifyOne, recordSuggestion, closeSettledSuggestions, postPendingNotifications, loadCompletedVisits,
    clearStopsAtOtherCustomers, otherCustomerPinNear, applyDecision, applyDecisions, briefPinDays, loadSourceVisits, suggestionExplained, withinSql, BRIEF_STOP_MIN_MINUTES,
    REPORT_MIN_STOP_MINUTES, MAX_STOP_DISTANCE_M,
  },
};
