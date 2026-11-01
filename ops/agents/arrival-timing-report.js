#!/usr/bin/env node
/**
 * READ-ONLY: how early the Bouncie GPS arrival fires against when the truck actually parked, and what an arrival
 * rule tied to the truck parking (the planned GATE_ARRIVAL_ENGINE_OFF) needs to be true before it goes live (owner
 * 2026-11-01: the arrival triggers early; tie it to the truck turning off).
 *
 *   PG_CA_FILE=~/ops-oneshots/certs/railway-pg-root.pem railway run --service Postgres -- \
 *     railway run --service waves-customer-portal node ops/agents/arrival-timing-report.js --from 2026-10-01 --to 2026-10-31 [--json]
 *
 * The outer run gives DATABASE_PUBLIC_URL; the inner run gives the portal's GPS_ARRIVAL_* variables, which override
 * the arrival radius in system_settings. The database login is the pinned-root TLS + SCRAM-SHA-256-PLUS connection
 * of ops/agents/second-tech-handover.js: PG_CA_FILE is required for the public proxy (see that file's header).
 *
 * Per ET day (at most 120 per run), trip link's own DRY RUN (server/services/trip-link.js linkDay, which writes
 * nothing) matches each completed visit to the truck stop it served. A stop starts at the truck's last GPS sample
 * before a 5+ minute stop: when the truck parked. Against that the report reads each visit's arrived_at and the GPS
 * arrival audit row that set it (gps_arrival.mark_on_property: the rule that fired, distance, speed, ignition):
 *   1. GPS arrivals by rule, and minutes from the arrival to the truck parking (positive = marked before it parked);
 *   2. GPS-arrived visits with no engine-off stop near the house, with the longest still stretch Bouncie reported
 *      during the visit and the longest silence: whether a "stood still 90 seconds" rule for a truck left idling
 *      (A/C) can see it at all;
 *   3. trip-end and trip-start rows in bouncie_webhook_log with and without a GPS point and an end time (each event
 *      is logged by both receivers): whether an engine-off reaches the detector with a position of its own.
 * A technician-day trip link could not judge (it counts those and drops their rows) is named on an INCOMPLETE line
 * (`incomplete` in --json) and the run exits 1: the numbers are evidence for a rule change, never silently partial.
 * Visit ids print as 8-character prefixes; no names, addresses, coordinates or device ids. Every connection is
 * read-only (PGOPTIONS plus a session READ ONLY pool), and a zero-row write probe must be refused before any read.
 */
'use strict';

if (require.main === module) {
  // Before any server module loads: every connection this process opens is read-only, and the app's own knex
  // (loadArrivalConfig reads system_settings through it) loads pointed at a dead port. main() hands it the pinned
  // connection settings; if that ever fails to take, its read-only probe errors and the run refuses.
  process.env.PGOPTIONS = '-c default_transaction_read_only=on';
  process.env.DATABASE_URL = 'postgres://127.0.0.1:1/arrival-timing-report-unused';
}

const { firstPresent, normalizeEventType, pointFromPayload, pointFromSource, tripIdentity } = require('../../server/services/bouncie-payload');
const { distanceMeters } = require('../../server/services/gps-arrival-detector');

// "Standing still" as the planned idle rule judges it: 2 mph or less, within 25 m, on one trip.
const STILL_MAX_SPEED_MPH = 2;
const STILL_MAX_DRIFT_METERS = 25;
const ARRIVAL_MATCH_MS = 2 * 60 * 1000; // an audit row this close to arrived_at is the arrival that set it
const LATE_ARRIVAL_MS = 12 * 60 * 60 * 1000; // a trip-data event can reach us this late (bouncie-truck-stops.js)
const PAGE = 500;

const ms = (value) => {
  if (!value) return null;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
const asObject = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function median(values) {
  return percentile([...values].sort((a, b) => a - b), 50);
}

/** The GPS arrival row that set arrived_at: the closest one within ARRIVAL_MATCH_MS (a restarted visit has more). */
function gpsArrivalFor(rows = [], arrivedAt) {
  const at = ms(arrivedAt);
  if (at == null) return null;
  let best = null;
  for (const row of rows) {
    const created = ms(row.created_at);
    const gap = created == null ? Infinity : Math.abs(created - at);
    if (gap <= ARRIVAL_MATCH_MS && (!best || gap < best.gap)) best = { row, gap };
  }
  return best ? { ...best.row, metadata: asObject(best.row.metadata) || {} } : null;
}

/** One visit: its trip-link leg, its arrival and, for a GPS arrival, the minutes from it to the truck parking. */
function visitRow({ leg, visit, gps }) {
  const parked = ms(leg.gps_arrived_at);
  const arrived = ms(visit?.arrived_at);
  let arrival = 'none';
  if (gps) arrival = 'gps';
  else if (arrived != null) arrival = 'other';
  return {
    visit: String(leg.scheduled_service_id).slice(0, 8),
    day: leg.service_date,
    status: leg.status,
    arrival,
    rule: gps ? gps.metadata.decision_reason || null : null,
    distanceM: gps ? gps.metadata.distance_meters ?? null : null,
    ignition: gps ? gps.metadata.ignition ?? null : null,
    earlyMin: parked != null && arrived != null ? round1((parked - arrived) / 60000) : null,
  };
}

function timing(rows) {
  const early = rows.map((row) => row.earlyMin).filter((n) => n != null).sort((a, b) => a - b);
  return {
    n: early.length,
    medianMin: percentile(early, 50),
    p75Min: percentile(early, 75),
    p90Min: percentile(early, 90),
    maxMin: early.length ? early[early.length - 1] : null,
    over1Min: early.filter((n) => n > 1).length,
    over3Min: early.filter((n) => n > 3).length,
    over5Min: early.filter((n) => n > 5).length,
    afterParking: early.filter((n) => n < 0).length,
  };
}

function summarize(rows) {
  const count = (pick) => {
    const out = {};
    for (const row of rows) out[pick(row)] = (out[pick(row)] || 0) + 1;
    return out;
  };
  const gps = rows.filter((row) => row.arrival === 'gps');
  const rules = [...new Set(gps.map((row) => row.rule))];
  return {
    visits: rows.length,
    byStatus: count((row) => row.status),
    arrivals: count((row) => row.arrival),
    gpsVsParked: timing(gps),
    byRule: Object.fromEntries(rules.map((rule) => {
      const ofRule = gps.filter((row) => row.rule === rule);
      const distances = ofRule.map((row) => row.distanceM).filter((n) => n != null);
      return [rule, { ...timing(ofRule), medianDistanceM: distances.length ? median(distances) : null }];
    })),
    gpsWithIgnitionOff: gps.filter((row) => row.ignition === false).length,
    gpsWithoutStop: gps.filter((row) => row.status === 'no_stop').length,
  };
}

/** The timestamped samples of one logged trip-data payload, tagged with its trip. */
function samplesOf(rawPayload) {
  const payload = asObject(rawPayload);
  if (!payload) return [];
  const trip = tripIdentity(payload);
  const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.samples) ? payload.samples : [];
  return list.map(pointFromSource).filter(Boolean)
    .map((point) => ({ trip, lat: point.lat, lng: point.lng, speed: point.speed_mph, ms: ms(point.reported_at) }))
    .filter((sample) => sample.ms != null);
}

/**
 * What Bouncie reported while the truck stood at a visit it never shut off for: the longest stretch of samples at
 * 2 mph or less within 25 m on one trip, and the longest silence, counted from the arrival to the first sample,
 * between samples, and from the last sample to completion (a visit with no sample was silent throughout). A long
 * still stretch means the idle rule can see an idling truck; a long silence means Bouncie goes quiet while it idles.
 */
function stillEvidence(samples, { fromMs, toMs }) {
  const inWindow = samples.filter((s) => s.ms >= fromMs && s.ms <= toMs).sort((a, b) => a.ms - b.ms);
  let longestStill = 0;
  let longestSilence = 0;
  let lastHeardMs = fromMs;
  let run = null;
  for (const s of inWindow) {
    longestSilence = Math.max(longestSilence, s.ms - lastHeardMs);
    lastHeardMs = s.ms;
    const still = s.speed != null && s.speed <= STILL_MAX_SPEED_MPH;
    const drift = run ? distanceMeters(run.lat, run.lng, s.lat, s.lng) : null;
    const continues = still && run && s.trip === run.trip && drift != null && drift <= STILL_MAX_DRIFT_METERS;
    if (continues) run.end = s.ms;
    else run = still ? { trip: s.trip, lat: s.lat, lng: s.lng, start: s.ms, end: s.ms } : null;
    if (run) longestStill = Math.max(longestStill, run.end - run.start);
  }
  longestSilence = Math.max(longestSilence, toMs - lastHeardMs);
  return {
    samples: inWindow.length,
    longestStillS: Math.round(longestStill / 1000),
    longestSilenceS: Math.round(longestSilence / 1000),
  };
}

/** Folds one trip-start / trip-end log row into the tally of which ones carry a GPS point and an end time. */
function tallyEvent(tally, row) {
  const type = normalizeEventType(row.event_type);
  const payload = asObject(row.payload) || {};
  const entry = tally[type] || (tally[type] = { rows: 0, withGps: 0, withEndTime: 0 });
  entry.rows += 1;
  if (pointFromPayload(payload, type)) entry.withGps += 1;
  if (type === 'trip-end' && firstPresent(payload.end?.timestamp, payload.timestamp)) entry.withEndTime += 1;
  return tally;
}

// ---------- reads (read-only connection) ----------

async function chunked(ids, read) {
  const out = [];
  for (let i = 0; i < ids.length; i += PAGE) out.push(...await read(ids.slice(i, i + PAGE)));
  return out;
}

async function loadVisits(conn, ids) {
  const rows = await chunked(ids, (chunk) => conn('scheduled_services').whereIn('id', chunk)
    .select('id', 'arrived_at', 'completed_at'));
  return new Map(rows.map((row) => [String(row.id), row]));
}

async function loadGpsArrivals(conn, ids) {
  const rows = await chunked(ids, (chunk) => conn('audit_log')
    .where({ resource_type: 'scheduled_service', action: 'gps_arrival.mark_on_property' })
    .whereIn('resource_id', chunk)
    .select('resource_id', 'created_at', 'metadata'));
  const byVisit = new Map();
  for (const row of rows) byVisit.set(String(row.resource_id), [...(byVisit.get(String(row.resource_id)) || []), row]);
  return byVisit;
}

async function visitSamples(conn, imei, fromMs, toMs) {
  const rows = await conn('bouncie_webhook_log')
    .where({ vehicle_imei: String(imei), event_type: 'trip-data' })
    .where('received_at', '>=', new Date(fromMs))
    .where('received_at', '<', new Date(toMs + LATE_ARRIVAL_MS))
    .select('payload');
  return rows.flatMap((row) => samplesOf(row.payload));
}

async function eventShapes(conn, { fromMs, toMs }) {
  const tally = {};
  for (let afterId = 0; ;) {
    const rows = await conn('bouncie_webhook_log')
      .whereIn('event_type', ['trip-end', 'tripEnd', 'trip-start', 'tripStart'])
      .where('received_at', '>=', new Date(fromMs))
      .where('received_at', '<', new Date(toMs))
      .where('id', '>', afterId)
      .orderBy('id').limit(PAGE)
      .select('id', 'event_type', 'payload');
    for (const row of rows) tallyEvent(tally, row);
    if (rows.length < PAGE) break;
    afterId = rows[rows.length - 1].id;
  }
  return tally;
}

/**
 * Every day's trip-link legs, and the days where a technician-day failed: linkDay catches that, counts it in
 * `errors` and drops its rows, so the report must say which numbers are missing instead of passing them off as
 * complete.
 */
async function linkedLegs(linkDay, conn, days, radius) {
  const legs = [];
  const failed = [];
  for (const day of days) {
    const result = await linkDay(conn, day, { dryRun: true, radius });
    legs.push(...(result.rows?.legs || []));
    if (result.errors) failed.push({ day, technicianDays: result.errors });
  }
  return { legs, failed };
}

// A zero-row write that Postgres must refuse: proof the session is read-only before anything is read.
async function assertReadOnly(conn) {
  try {
    await conn.raw('UPDATE bouncie_webhook_log SET processed = processed WHERE false');
  } catch (err) {
    if (/read-only transaction/i.test(err.message)) return;
    throw new Error(`read-only self-check errored without the read-only rejection, refusing to run: ${err.message}`);
  }
  throw new Error('READ-ONLY SELF-CHECK FAILED: a write was not refused. Refusing to run.');
}

// ---------- output ----------

function printReport({ from, to, radius, summary, idle, events, incomplete }) {
  const t = summary.gpsVsParked;
  const pct = (n) => (t.n ? `${Math.round((n / t.n) * 100)}%` : '-');
  const v = (n) => (n == null ? '-' : n);
  const missing = incomplete.reduce((n, day) => n + day.technicianDays, 0);
  const lines = [
    ...(incomplete.length ? [`INCOMPLETE: trip link could not judge ${missing} technician-day(s) on`
      + ` ${incomplete.map((day) => day.day).join(', ')}; their visits are missing from every number below.`] : []),
    `Arrival timing ${from} to ${to} (ET days), arrival radius ${radius} m`,
    `Completed visits judged: ${summary.visits} ${JSON.stringify(summary.byStatus)}`,
    `Arrivals: ${JSON.stringify(summary.arrivals)} (gps = set by the GPS detector; other = a tap or a grouped sibling)`,
    `GPS arrival vs truck parked (positive = minutes BEFORE it parked), n=${t.n}:`
      + ` median ${v(t.medianMin)}, p75 ${v(t.p75Min)}, p90 ${v(t.p90Min)}, max ${v(t.maxMin)}`,
    `  more than 1 min early ${t.over1Min} (${pct(t.over1Min)}), 3 min ${t.over3Min} (${pct(t.over3Min)}),`
      + ` 5 min ${t.over5Min} (${pct(t.over5Min)}); marked after parking ${t.afterParking}`,
    '  by rule (timed = the visit has an engine-off stop):',
    ...Object.entries(summary.byRule).map(([rule, r]) => `    ${String(rule).padEnd(28)} timed n=${r.n}`
      + `  median ${v(r.medianMin)} min early, p90 ${v(r.p90Min)}, median distance ${v(r.medianDistanceM)} m`),
    `GPS arrivals with ignition off: ${summary.gpsWithIgnitionOff}`,
    `GPS-arrived visits with no engine-off stop near the house: ${summary.gpsWithoutStop}`,
    ...idle.map((v) => `    ${v.visit} ${v.day}  longest still ${v.longestStillS}s,`
      + ` longest silence ${v.longestSilenceS}s, ${v.samples} samples`),
    'Bouncie trip events in the window (log rows; each event is logged by both receivers):',
    ...Object.entries(events).map(([type, e]) => `    ${type.padEnd(10)} ${e.rows} rows, ${e.withGps} with GPS`
      + (type === 'trip-end' ? `, ${e.withEndTime} with an end time` : '')),
  ];
  console.log(lines.join('\n'));
}

async function main(argv) {
  const json = argv.includes('--json');
  const { parseArgs, daysBetween } = require('../../server/scripts/trip-link-backfill');
  const opts = parseArgs(argv.filter((arg) => arg !== '--json'));
  const days = daysBetween(opts.from, opts.to);
  if (!process.env.DATABASE_PUBLIC_URL) {
    throw new Error('DATABASE_PUBLIC_URL is not set: run via railway run --service Postgres -- railway run --service'
      + ' waves-customer-portal node ops/agents/arrival-timing-report.js (with PG_CA_FILE, see the header)');
  }
  const { readOnlyConn } = require('./second-tech-handover');
  const sharedDb = require('../../server/models/db');
  const { linkDay } = require('../../server/services/trip-link');
  const { loadArrivalConfig } = require('../../server/services/gps-arrival-detector');
  const { etDayBounds } = require('../../server/services/visit-gps-context');
  // Pinned root, discrete fields (a URL ssl* option is refused) and a SCRAM-SHA-256-PLUS-only login; the app's knex
  // takes the very same settings before its first query.
  const conn = readOnlyConn(process.env.DATABASE_PUBLIC_URL);
  sharedDb.client.connectionSettings = conn.client.connectionSettings;
  try {
    await assertReadOnly(conn);
    await assertReadOnly(sharedDb);
    const radius = (await loadArrivalConfig()).radiusMeters;
    const { legs, failed } = await linkedLegs(linkDay, conn, days, radius);
    const ids = [...new Set(legs.map((leg) => String(leg.scheduled_service_id)))];
    const visits = await loadVisits(conn, ids);
    const gpsRows = await loadGpsArrivals(conn, ids);
    const rows = [];
    const idle = [];
    for (const leg of legs) {
      const id = String(leg.scheduled_service_id);
      const visit = visits.get(id);
      const gps = gpsArrivalFor(gpsRows.get(id), visit?.arrived_at);
      const row = visitRow({ leg, visit, gps });
      rows.push(row);
      const window = { fromMs: ms(visit?.arrived_at), toMs: ms(visit?.completed_at) };
      if (row.arrival === 'gps' && row.status === 'no_stop' && leg.vehicle_imei && window.fromMs != null && window.toMs != null) {
        const samples = await visitSamples(conn, leg.vehicle_imei, window.fromMs, window.toMs);
        idle.push({ visit: row.visit, day: row.day, ...stillEvidence(samples, window) });
      }
    }
    const events = await eventShapes(conn, { fromMs: etDayBounds(days[0]).startMs, toMs: etDayBounds(days[days.length - 1]).endMs });
    const report = { from: opts.from, to: opts.to, radius, incomplete: failed, summary: summarize(rows), rows, idle, events };
    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    if (failed.length) process.exitCode = 1;
  } finally {
    await conn.destroy();
    await sharedDb.destroy();
  }
}

module.exports = {
  gpsArrivalFor, visitRow, summarize, samplesOf, stillEvidence, tallyEvent, percentile, assertReadOnly, linkedLegs,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
