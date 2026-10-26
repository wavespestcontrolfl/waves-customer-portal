'use strict';

/**
 * Trip link (GATE_TRIP_LINK, owner "TRIP LINK" and "BOTH" 2026-10-26).
 *
 * Links each Bouncie trip and truck stop to the completed visit it served, and stores, per visit, the truck's GPS
 * arrival and departure, the GPS minutes on site, and the drive minutes and miles that got it there
 * (visit_gps_legs); and, per trip, where it ended and a business / personal SUGGESTION (trip_links). The per-tech
 * job cost reads visit_gps_legs; the mileage review may read the suggestions.
 *
 * SHADOW DATA ONLY. This file writes visit_gps_legs and trip_links and nothing else: never mileage_log,
 * scheduled_services, job_costs, customer pins or alerts, and it sends nothing. Gate off: the nightly job reads
 * nothing and writes nothing (runTripLinkNightly). linkDay itself is gate-agnostic so the backfill script can call it.
 *
 * One ET day, one technician at a time:
 *   1. The vehicle's trips of the day, and its stops (a gap of 5+ minutes between two trips, bouncie-truck-stops.js).
 *   2. The technician's COMPLETED visits of the day, one physical visit per visit_id group; destination as the pin
 *      check resolves it (visit-gps-context.js).
 *   3. Match a visit to the stop inside the GPS arrival radius of its destination that overlaps the visit window
 *      [ (arrived_at or completed_at) - WINDOW_BEFORE_MIN, completed_at + WINDOW_AFTER_MIN ]: greatest overlap,
 *      then the start nearest the arrival stamp; still equal = 'ambiguous'. Several visits on one stop split its minutes.
 *   4. Drive leg: from the end of the previous stop of the day (the day's first trip start for the first stop) to the
 *      stop's start. Trips inside that interval give the miles (NULL when one has no mileage_log row).
 *   5. Every trip gets what its end is and a purpose suggestion.
 * A day that starts before the technician's tracker was remapped is not judged (visits there are 'no_vehicle').
 * A re-run replaces the day, in one transaction per technician-day.
 */
const db = require('../models/db');
const logger = require('./logger');
const gates = require('../config/feature-gates');
const { distanceMeters, loadArrivalConfig } = require('./gps-arrival-detector');
const truckStops = require('./bouncie-truck-stops');
const ctx = require('./visit-gps-context');
const { etDateString, addETDays } = require('../utils/datetime-et');

const LOG = '[trip-link]';
const ALGORITHM_VERSION = 1;
// The visit window: a stop counts for a visit when it overlaps [anchor - 120 min, completed_at + 30 min], where the
// anchor is the arrival stamp (else the completion stamp).
const WINDOW_BEFORE_MIN = 120;
const WINDOW_AFTER_MIN = 30;
const MS_PER_MIN = 60000;
const INSERT_CHUNK = 200;

const tripLinkLive = () => typeof gates.tripLinkLive === 'function' && gates.tripLinkLive();

const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const ms = (value) => (value ? new Date(value).getTime() : NaN);

// ---------- pure rules ----------

/** What a point is: the nearest active fence it stands in (its type), else the home base, else 'other'. */
function kindOfPoint(point, { radius, fences, home }) {
  let best = null;
  for (const fence of fences) {
    const d = distanceMeters(fence.lat, fence.lng, point.lat, point.lng);
    if (!ctx.isWithin(d, Math.max(radius, fence.radius))) continue;
    if (!best || d < best.d) best = { d, type: fence.type };
  }
  if (best) return best.type;
  return ctx.within(home, point, radius) ? 'home' : 'other';
}

/** The window one physical visit (all its members) may have been on site, and the stamp a tie is broken against. */
function visitWindow(members) {
  const completed = members.map((m) => ms(m.completed_at)).filter(Number.isFinite);
  const anchors = members.map((m) => ms(m.arrived_at || m.completed_at)).filter(Number.isFinite);
  if (!completed.length) return null;
  const completedMs = Math.max(...completed);
  const anchorMs = anchors.length ? Math.min(...anchors) : completedMs;
  return {
    anchorMs,
    startMs: Math.min(anchorMs, completedMs) - WINDOW_BEFORE_MIN * MS_PER_MIN,
    endMs: completedMs + WINDOW_AFTER_MIN * MS_PER_MIN,
  };
}

const overlapMs = (stop, window) => Math.max(0, Math.min(stop.endMs, window.endMs) - Math.max(stop.startMs, window.startMs));

/**
 * The stop one physical visit was at.
 * @returns {{status:'matched', index:number, distanceM:number} | {status:'no_destination'|'no_stop'|'ambiguous'}}
 */
function matchVisit({ destination, window, stops, radius }) {
  if (!destination) return { status: 'no_destination' };
  if (!window) return { status: 'no_stop' };
  const candidates = [];
  stops.forEach((stop, index) => {
    const distanceM = distanceMeters(destination.lat, destination.lng, stop.lat, stop.lng);
    const overlap = overlapMs(stop, window);
    if (ctx.isWithin(distanceM, radius) && overlap > 0) {
      candidates.push({ index, distanceM, overlap, gap: Math.abs(stop.startMs - window.anchorMs) });
    }
  });
  if (!candidates.length) return { status: 'no_stop' };
  candidates.sort((a, b) => b.overlap - a.overlap || a.gap - b.gap);
  if (candidates.length > 1 && candidates[0].overlap === candidates[1].overlap && candidates[0].gap === candidates[1].gap) {
    return { status: 'ambiguous' };
  }
  return { status: 'matched', index: candidates[0].index, distanceM: candidates[0].distanceM };
}

/**
 * The drive that ended at stops[index]: from the end of the previous stop (the day's first trip start for the first
 * stop) to this stop's start. `kinds[i]` says what stop i is.
 */
function driveLeg({ index, stops, trips, kinds, mileageByTrip, radius, home }) {
  const stop = stops[index];
  let fromMs;
  let fromKind;
  if (index > 0) {
    fromMs = stops[index - 1].endMs;
    fromKind = kinds[index - 1];
  } else {
    const first = trips[0];
    fromMs = first ? first.startMs : stop.startMs;
    fromKind = first && ctx.within(home, { lat: first.startLat, lng: first.startLng }, radius) ? 'home' : 'day_start';
  }
  const inside = trips.filter((trip) => trip.startMs >= fromMs && trip.endMs <= stop.startMs);
  const known = inside.map((trip) => mileageByTrip.get(trip.tripId));
  const miles = inside.length && known.every((row) => row && row.miles != null)
    ? round(known.reduce((sum, row) => sum + row.miles, 0), 2) : null;
  return {
    driveMinutes: round(Math.max(0, stop.startMs - fromMs) / MS_PER_MIN, 2),
    driveMiles: miles,
    driveFromKind: fromKind,
    driveTripIds: inside.map((trip) => trip.tripId),
  };
}

const purposeFor = (kind) => {
  if (kind === 'visit' || kind === 'supplier' || kind === 'business') return 'business';
  return kind === 'personal' ? 'personal' : 'unclassified';
};

/**
 * One technician-day, pure. `groups` are the physical visits ({ key, members, destination }); `trips` the day's
 * trips in time order; `stops` the day's stops in time order; `mileageByTrip` a Map tripId -> { id, miles }.
 * @returns {{legs:object[], links:object[]}} legs: one per member service; links: one per trip
 */
function computeDay({ groups, trips, stops, mileageByTrip = new Map(), radius, fences = [], home = null }) {
  const matches = groups.map((group) => ({
    group,
    ...matchVisit({ destination: group.destination, window: visitWindow(group.members), stops, radius }),
  }));
  const usersOfStop = new Map();
  for (const m of matches) {
    if (m.status === 'matched') usersOfStop.set(m.index, [...(usersOfStop.get(m.index) || []), m.group]);
  }
  const kinds = stops.map((stop, index) => (usersOfStop.has(index) ? 'visit' : kindOfPoint(stop, { radius, fences, home })));

  const legs = [];
  for (const m of matches) {
    const base = { leg_group_key: m.group.key, status: m.status, shared_stop_count: 1 };
    if (m.status !== 'matched') {
      for (const member of m.group.members) legs.push({ scheduled_service_id: member.id, ...base });
      continue;
    }
    const stop = stops[m.index];
    const sharers = usersOfStop.get(m.index).length;
    const leg = driveLeg({ index: m.index, stops, trips, kinds, mileageByTrip, radius, home });
    for (const member of m.group.members) {
      legs.push({
        scheduled_service_id: member.id,
        ...base,
        gps_arrived_at: new Date(stop.startMs),
        gps_departed_at: new Date(stop.endMs),
        gps_on_site_minutes: round(stop.minutes / sharers, 2),
        shared_stop_count: sharers,
        drive_minutes: leg.driveMinutes,
        drive_miles: leg.driveMiles,
        drive_from_kind: leg.driveFromKind,
        drive_trip_ids: leg.driveTripIds,
        match_distance_m: round(m.distanceM, 1),
      });
    }
  }

  const stopStartingAt = new Map(stops.map((stop, index) => [stop.startMs, index]));
  const links = trips.map((trip) => {
    const stopIndex = stopStartingAt.get(trip.endMs);
    const visitGroup = stopIndex != null ? usersOfStop.get(stopIndex)?.[0] : null;
    const endsAt = visitGroup ? 'visit' : kindOfPoint({ lat: trip.endLat, lng: trip.endLng }, { radius, fences, home });
    return {
      bouncie_trip_id: trip.tripId,
      ends_at_kind: endsAt,
      ends_at_scheduled_service_id: visitGroup ? visitGroup.members[0].id : null,
      suggested_purpose: purposeFor(endsAt),
    };
  });
  return { legs, links };
}

// ---------- reads ----------

function groupVisits(visits) {
  const groups = new Map();
  for (const visit of visits) {
    const key = visit.visit_id ? String(visit.visit_id) : String(visit.id);
    const id = `${visit.technician_id}|${key}`;
    const group = groups.get(id) || { key, technicianId: visit.technician_id, members: [] };
    group.members.push(visit);
    groups.set(id, group);
  }
  // Members in a fixed order (earliest completed, then id): the first one is the visit trip_links points at.
  const byCompleted = (a, b) => ms(a.completed_at) - ms(b.completed_at) || (String(a.id) < String(b.id) ? -1 : 1);
  return [...groups.values()].map((group) => {
    const members = [...group.members].sort(byCompleted);
    return { ...group, members, destination: members.map((member) => ctx.destinationOf(member)).find(Boolean) || null };
  });
}

async function loadMileage(conn, tripIds) {
  const byTrip = new Map();
  for (let i = 0; i < tripIds.length; i += 500) {
    const rows = await conn('mileage_log').whereIn('bouncie_trip_id', tripIds.slice(i, i + 500))
      .select('id', 'bouncie_trip_id', 'distance_miles');
    for (const row of rows) {
      byTrip.set(String(row.bouncie_trip_id), { id: row.id, miles: row.distance_miles == null ? null : Number(row.distance_miles) });
    }
  }
  return byTrip;
}

// ---------- the write: one transaction per technician-day ----------

async function insertChunks(trx, table, key, rows) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await trx(table).insert(rows.slice(i, i + INSERT_CHUNK)).onConflict(key).merge();
  }
}

async function writeTechnicianDay(conn, { day, bounds, technicianId, imei, legRows, linkRows }) {
  await conn.transaction(async (trx) => {
    await insertChunks(trx, 'visit_gps_legs', 'scheduled_service_id', legRows);
    await insertChunks(trx, 'trip_links', 'bouncie_trip_id', linkRows);
    // A re-run replaces the day: rows for visits no longer completed here, or trips no longer read, go.
    await trx('visit_gps_legs').where({ technician_id: technicianId, service_date: day })
      .whereNotIn('scheduled_service_id', legRows.map((row) => row.scheduled_service_id)).del();
    if (imei) {
      await trx('trip_links').where({ vehicle_imei: imei })
        .where('trip_start', '>=', new Date(bounds.startMs)).where('trip_start', '<', new Date(bounds.endMs))
        .whereNotIn('bouncie_trip_id', linkRows.map((row) => row.bouncie_trip_id)).del();
    }
  });
}

/** One vehicle's day: its trips, stops, the mileage rows of those trips and its home base. */
async function readVehicleDay(conn, technician, bounds, etDay, radius, now) {
  const { trips, stops } = await truckStops.loadTruckDay(conn, technician.imei, {
    fromMs: bounds.startMs, toMs: bounds.endMs, maxGapMeters: radius, now: now.getTime(),
  });
  const mileageByTrip = await loadMileage(conn, trips.map((trip) => trip.tripId));
  const home = await ctx.loadHomeBase(conn, technician.imei, new Date(bounds.endMs - 1), technician.changedAt, etDay);
  return { trips, stops, mileageByTrip, home };
}

const emptyTally = () => ({ matched: 0, no_vehicle: 0, no_destination: 0, no_stop: 0, ambiguous: 0 });

/** Technicians, the day's completed visits grouped by technician, and technicians that already hold rows for the day. */
async function loadDayInputs(conn, etDay, bounds, only) {
  let techQuery = conn('technicians').select('id', 'bouncie_imei', 'bouncie_imei_changed_at');
  if (only) techQuery = techQuery.whereIn('id', only);
  const technicians = new Map((await techQuery).map((row) => [String(row.id), {
    id: String(row.id), imei: String(row.bouncie_imei || '').trim(), changedAt: row.bouncie_imei_changed_at,
  }]));
  let visitQuery = ctx.completedVisitQuery(conn, { requireVehicle: false })
    .where('s.completed_at', '>=', new Date(bounds.startMs)).where('s.completed_at', '<', new Date(bounds.endMs));
  if (only) visitQuery = visitQuery.whereIn('s.technician_id', only);
  const groupsByTech = new Map();
  for (const group of groupVisits(ctx.shapeVisits(await visitQuery))) {
    const id = String(group.technicianId);
    groupsByTech.set(id, [...(groupsByTech.get(id) || []), group]);
  }
  let staleQuery = conn('visit_gps_legs').where({ service_date: etDay }).distinct('technician_id');
  if (only) staleQuery = staleQuery.whereIn('technician_id', only);
  const staleIds = (await staleQuery).map((row) => row.technician_id).filter(Boolean).map(String);
  const withVehicle = [...technicians.values()].filter((t) => t.imei).map((t) => t.id);
  return { technicians, groupsByTech, ids: new Set([...withVehicle, ...groupsByTech.keys(), ...staleIds]) };
}

/** The rows to store for one technician-day: legs per member service, links per trip. */
function buildRows({ etDay, technician, groups, read, radius, fences, now }) {
  const computed = read
    ? computeDay({ groups, ...read, radius, fences })
    : { legs: groups.flatMap((group) => group.members.map((member) => ({
      scheduled_service_id: member.id, leg_group_key: group.key, status: 'no_vehicle', shared_stop_count: 1,
    }))), links: [] };
  const stamp = { algorithm_version: ALGORITHM_VERSION, computed_at: new Date(now) };
  const legRows = computed.legs.map((leg) => ({
    gps_arrived_at: null, gps_departed_at: null, gps_on_site_minutes: null, drive_minutes: null, drive_miles: null,
    drive_from_kind: null, drive_trip_ids: null, match_distance_m: null,
    ...leg,
    technician_id: technician.id,
    vehicle_imei: technician.imei || null,
    service_date: etDay,
    ...stamp,
  }));
  const tripById = new Map((read ? read.trips : []).map((trip) => [trip.tripId, trip]));
  const linkRows = computed.links.map((link) => {
    const trip = tripById.get(link.bouncie_trip_id);
    const mileage = read.mileageByTrip.get(link.bouncie_trip_id);
    return {
      ...link,
      mileage_log_id: mileage ? mileage.id : null,
      technician_id: technician.id,
      vehicle_imei: technician.imei,
      trip_start: new Date(trip.startMs),
      trip_end: new Date(trip.endMs),
      distance_miles: mileage && mileage.miles != null ? mileage.miles : null,
      ...stamp,
    };
  });
  return { legRows, linkRows };
}

/**
 * Links one ET day (YYYY-MM-DD) for every technician with a vehicle, a completed visit or stored rows that day.
 * @param {object} conn knex or transaction
 * @param {string} etDay
 * @param {{technicianIds?:string[], dryRun?:boolean, now?:Date, radius?:number}} opts dryRun computes and writes nothing
 * @returns {Promise<{day:string, technicians:number, legs:object, trips:number, errors:number, rows?:object}>}
 */
async function linkDay(conn, etDay, { technicianIds = null, dryRun = false, now = new Date(), radius = null } = {}) {
  const bounds = ctx.etDayBounds(etDay);
  const arrivalRadius = radius || (await loadArrivalConfig()).radiusMeters;
  const fences = await ctx.loadFences(conn);
  const only = technicianIds && technicianIds.length ? technicianIds.map(String) : null;
  const { technicians, groupsByTech, ids } = await loadDayInputs(conn, etDay, bounds, only);
  const summary = { day: etDay, technicians: 0, legs: { total: 0, ...emptyTally() }, trips: 0, errors: 0 };
  if (dryRun) summary.rows = { legs: [], links: [] };

  for (const technicianId of ids) {
    const technician = technicians.get(technicianId);
    if (!technician) continue; // technician deleted: its leftover rows go with it
    try {
      const vehicle = technician.imei && !ctx.dayBeforeMapping(etDay, technician.changedAt);
      const read = vehicle ? await readVehicleDay(conn, technician, bounds, etDay, arrivalRadius, now) : null;
      const { legRows, linkRows } = buildRows({
        etDay, technician, groups: groupsByTech.get(technicianId) || [], read, radius: arrivalRadius, fences, now,
      });
      if (dryRun) {
        summary.rows.legs.push(...legRows); summary.rows.links.push(...linkRows);
      } else {
        await writeTechnicianDay(conn, { day: etDay, bounds, technicianId, imei: vehicle ? technician.imei : null, legRows, linkRows });
      }
      summary.technicians += 1;
      summary.trips += linkRows.length;
      for (const row of legRows) { summary.legs.total += 1; summary.legs[row.status] += 1; }
    } catch (err) {
      summary.errors += 1;
      logger.warn(`${LOG} technician-day skipped`, { day: etDay, technicianId, error: err.code || err.name });
    }
  }
  return summary;
}

/**
 * The nightly run: yesterday (ET), then the day before again. A trip-data event can reach us up to 12 hours late
 * (bouncie-truck-stops.js), so at 01:40 yesterday may still miss a few; a day later they are all in. A re-run replaces
 * a day, so linking it twice is safe. Gate off = nothing is read and nothing is written.
 */
async function runTripLinkNightly({ now = new Date(), conn = db } = {}) {
  if (!tripLinkLive()) return { skipped: 'gated' };
  const day = etDateString(addETDays(now, -1));
  const summary = await linkDay(conn, day, { now });
  const relinkDay = etDateString(addETDays(now, -2));
  const relinked = await linkDay(conn, relinkDay, { now });
  logger.info(`${LOG} done`, {
    day, technicians: summary.technicians, legs: summary.legs, trips: summary.trips, errors: summary.errors,
    relinked: { day: relinkDay, legs: relinked.legs, trips: relinked.trips, errors: relinked.errors },
  });
  const errors = summary.errors + relinked.errors;
  if (errors) throw new Error(`${LOG} ${errors} technician-day(s) failed for ${day} and ${relinkDay}`);
  return { ...summary, relinked: { day: relinkDay, technicians: relinked.technicians, legs: relinked.legs, trips: relinked.trips, errors: relinked.errors } };
}

module.exports = {
  linkDay, runTripLinkNightly, computeDay, matchVisit, visitWindow, driveLeg, kindOfPoint, purposeFor, groupVisits, tripLinkLive,
  ALGORITHM_VERSION, WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN,
};
