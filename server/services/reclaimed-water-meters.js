/**
 * Reclaimed water meters (GATE_LAWN_RECLAIMED_HALF_N, owner 2026-10-23).
 *
 * Manatee County publishes where its reclaimed (purple pipe) water meters are, as a public ArcGIS layer. This module
 * downloads that layer into `reclaimed_water_meters` and marks the properties that sit at a meter. The match runs HERE,
 * on our own copy: nothing about a property (no coordinate, address or id) is ever sent to the county service. The only
 * outbound request is the constant query below, so the test asserts the URL and headers carry no property data.
 *
 * Sarasota and Charlotte publish no such layer, so a property outside the Manatee extent gets no automatic value. An
 * office or customer value (reclaimed_water_source 'office' or 'customer') is never overwritten by this job.
 */
const defaultDb = require('../models/db');
const logger = require('./logger');

const LAYER_QUERY_URL = 'https://www.mymanatee.org/gisutil/rest/services/Reclaim_UN_Breakdown/MapServer/5/query';
const PAGE_SIZE = 2000;
const MAX_PAGES = 60; // 40k points / 2,000 = 21 pages; a runaway server never loops forever
const REQUEST_TIMEOUT_MS = 30000;
// The county server answers 403 to some non-browser agents; a plain browser-style agent is accepted (checked 2026-10-23).
const USER_AGENT = 'Mozilla/5.0 (compatible; WavesPestControlPortal/1.0; +https://www.wavespestcontrol.com)';
const SOURCE = 'manatee_county';

// A meter counts only while it is in service. Checked 2026-10-23 on all 40,347 points of the layer: RETIREDDATE is empty on every one, and
// LIFECYCLESTATUS is 8 on every one (the county publishes no code list for it: the field has no domain, no subtypes, and queryDomains is empty).
// So 8 is the in-service value of this layer, and the rule is: no RETIRED date, and a status of 8 (or none stated). Any other status code, or any
// retired date, drops the meter, and a layer that drops too many is refused whole by storeMeters (MIN_PLAUSIBLE_METERS), keeping the stored copy.
const IN_SERVICE_LIFECYCLE = 8;
const isInService = (attributes) => attributes?.RETIREDDATE == null
  && (attributes?.LIFECYCLESTATUS == null || Number(attributes.LIFECYCLESTATUS) === IN_SERVICE_LIFECYCLE);

// A property is "at a meter" within 30 m. The meter sits at the curb, so its own lot's geocode is one front setback
// (about 7 to 10 m) plus the geocoder's error (rooftop about 5 m, parcel centroid up to about 15 m) away: 25 m at most.
// Wider than that starts to reach the next lot's meter (lots are 18 m wide or more), and the next lot on a street with
// reclaimed service shares the service. The office can always set the value by hand, and that value wins.
const MATCH_RADIUS_M = 30;

// A weekly refresh. The daily tick only downloads when the stored layer is older than this.
const REFRESH_AFTER_MS = 6 * 24 * 60 * 60 * 1000;
// A pull this short is a broken answer, not a shrunken layer: never replace the stored layer with it.
const MIN_PLAUSIBLE_METERS = 5000;
const CHUNK = 1000;

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
function distanceM(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ── download ────────────────────────────────────────────────────────────────

function pageUrl(offset) {
  const url = new URL(LAYER_QUERY_URL);
  url.search = new URLSearchParams({
    where: '1=1', outFields: 'OBJECTID,LIFECYCLESTATUS,RETIREDDATE', returnGeometry: 'true', outSR: '4326', f: 'json',
    orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE_SIZE),
  }).toString();
  return url.toString();
}

// One ArcGIS answer to points. A feature with no usable geometry, or one that is retired or not in service, is dropped; the server reports its own error as a 200 body.
function parsePage(body) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('county layer answered with no body'), { code: 'bad_body' });
  if (body.error) throw Object.assign(new Error(`county layer error ${body.error.code || ''}`.trim()), { code: 'layer_error' });
  const features = Array.isArray(body.features) ? body.features : [];
  const points = [];
  for (const feature of features) {
    const objectid = Number(feature?.attributes?.OBJECTID);
    const lng = Number(feature?.geometry?.x);
    const lat = Number(feature?.geometry?.y);
    if (!Number.isInteger(objectid) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (!isInService(feature.attributes)) continue;
    points.push({ objectid, lat, lng });
  }
  return { points, received: features.length, more: body.exceededTransferLimit === true };
}

async function fetchPage(offset, fetchImpl) {
  const res = await fetchImpl(pageUrl(offset), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw Object.assign(new Error(`county layer HTTP ${res.status}`), { code: `http_${res.status}` });
  return parsePage(await res.json());
}

/** Every point of the layer, paged by OBJECTID, de-duplicated. Throws on any failed page: a partial layer is never returned. */
async function fetchAllMeters({ fetchImpl = globalThis.fetch } = {}) {
  const byId = new Map();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { points, received, more } = await fetchPage(offset, fetchImpl);
    for (const point of points) byId.set(point.objectid, point);
    if (!received || !more) return [...byId.values()];
    offset += received;
  }
  throw Object.assign(new Error('county layer did not end'), { code: 'too_many_pages' });
}

// ── store ───────────────────────────────────────────────────────────────────

/** Replace the stored layer with `meters`: upsert them all, then drop what this pull no longer lists. One transaction. */
async function storeMeters(meters, { knex = defaultDb, now = new Date() } = {}) {
  const existing = Number((await knex('reclaimed_water_meters').count('* as n').first())?.n || 0);
  if (meters.length < MIN_PLAUSIBLE_METERS || (existing > 0 && meters.length < existing * 0.5)) {
    throw Object.assign(new Error(`county layer returned ${meters.length} meters; keeping the stored ${existing}`), { code: 'implausible_pull' });
  }
  await knex.transaction(async (trx) => {
    for (let i = 0; i < meters.length; i += CHUNK) {
      const rows = meters.slice(i, i + CHUNK).map((m) => ({ objectid: m.objectid, lat: m.lat, lng: m.lng, source: SOURCE, fetched_at: now }));
      await trx('reclaimed_water_meters').insert(rows).onConflict('objectid').merge(['lat', 'lng', 'source', 'fetched_at']);
    }
    await trx('reclaimed_water_meters').where('fetched_at', '<', now).del();
  });
  return meters.length;
}

async function layerIsStale(knex, now) {
  const row = await knex('reclaimed_water_meters').max('fetched_at as latest').first();
  return !row?.latest || now.getTime() - new Date(row.latest).getTime() > REFRESH_AFTER_MS;
}

// ── match ───────────────────────────────────────────────────────────────────

// 0.0005 degrees is 55 m of latitude and 49 m of longitude at Manatee: wider than the 30 m radius, so the 3 by 3 cells
// around a point hold every meter that can be within it.
const CELL_DEG = 0.0005;
const cellOf = (value) => Math.floor(value / CELL_DEG);

function buildIndex(meters) {
  const cells = new Map();
  let minLat = Infinity; let maxLat = -Infinity; let minLng = Infinity; let maxLng = -Infinity;
  for (const m of meters) {
    const key = `${cellOf(m.lat)}:${cellOf(m.lng)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(m);
    minLat = Math.min(minLat, m.lat); maxLat = Math.max(maxLat, m.lat);
    minLng = Math.min(minLng, m.lng); maxLng = Math.max(maxLng, m.lng);
  }
  return { cells, extent: meters.length ? { minLat, maxLat, minLng, maxLng } : null };
}

/** The closest meter within `radiusM` of the point, as `{ objectid, distanceM }`, else null. */
function nearestMeter(index, lat, lng, radiusM = MATCH_RADIUS_M) {
  const cy = cellOf(lat); const cx = cellOf(lng);
  let best = null;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (const m of index.cells.get(`${cy + dy}:${cx + dx}`) || []) {
        const d = distanceM(lat, lng, m.lat, m.lng);
        if (d <= radiusM && (!best || d < best.distanceM)) best = { objectid: m.objectid, distanceM: d };
      }
    }
  }
  return best;
}

const insideExtent = (index, lat, lng) => !!index.extent
  && lat >= index.extent.minLat && lat <= index.extent.maxLat && lng >= index.extent.minLng && lng <= index.extent.maxLng;

/**
 * What the county layer says about one point: `{ reclaimed: true }` at a meter, `{ reclaimed: false }` inside the Manatee
 * extent with no meter near, `{ reclaimed: null }` outside it (no layer, no opinion).
 */
function judgePoint(index, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { reclaimed: null };
  if (nearestMeter(index, lat, lng)) return { reclaimed: true };
  return { reclaimed: insideExtent(index, lat, lng) ? false : null };
}

async function loadIndex(knex) {
  return buildIndex((await knex('reclaimed_water_meters').select('objectid', 'lat', 'lng')).map((m) => ({ objectid: m.objectid, lat: Number(m.lat), lng: Number(m.lng) })));
}

/**
 * Settle the county value of the properties that have coordinates and no office or customer value. `all: false` only
 * visits properties never checked (a new property, or one the office handed back to automatic) or checked before the stored layer was fetched. Writes only the
 * county-owned columns, never updated_at, and never a row whose source is 'office' or 'customer' or whose coordinates changed since they were read. Safe to run twice.
 */
async function matchProperties({ knex = defaultDb, now = new Date(), all = true } = {}) {
  const index = await loadIndex(knex);
  const layerAt = (await knex('reclaimed_water_meters').max('fetched_at as latest').first())?.latest || now;
  if (!index.extent) return { checked: 0, reclaimed: 0, notFound: 0, outside: 0, skipped: 'no_meters' };
  const rows = await knex('customer_properties')
    .where({ active: true })
    .whereNotNull('latitude').whereNotNull('longitude')
    .where((q) => q.whereNull('reclaimed_water_source').orWhere('reclaimed_water_source', 'county_meter'))
    // Not `all`: the properties never checked, and those last checked BEFORE the stored layer was fetched (a refresh whose match pass failed or
    // was cut short is finished by the next tick, not left stale until the next download).
    .modify((q) => { if (!all) q.where((w) => w.whereNull('reclaimed_water_checked_at').orWhere('reclaimed_water_checked_at', '<', layerAt)); })
    .select('id', 'latitude', 'longitude');
  const groups = { true: [], false: [], null: [] };
  for (const row of rows) groups[String(judgePoint(index, Number(row.latitude), Number(row.longitude)).reclaimed)].push(row);
  let written = 0;
  for (const [value, group] of Object.entries(groups)) {
    const verdict = value === 'null' ? { water: null, source: null } : { water: value === 'true', source: 'county_meter' };
    for (let i = 0; i < group.length; i += CHUNK) {
      const chunk = group.slice(i, i + CHUNK);
      // The write is guarded by what the verdict was judged on: the same coordinates (an address move clears or replaces them and drops the
      // answer, customer-properties.js reclaimedResetOnMove), an active row, and still no office or customer value. A row that changed
      // meanwhile is skipped and stays unchecked for the next tick, never given the old location's answer.
      const result = await knex.raw(
        `UPDATE customer_properties AS cp
            SET reclaimed_water = ?::boolean, reclaimed_water_source = ?::varchar, reclaimed_water_checked_at = ?::timestamptz
           FROM (VALUES ${chunk.map(() => '(?::uuid, ?::numeric, ?::numeric)').join(', ')}) AS v(id, lat, lng)
          WHERE cp.id = v.id AND cp.latitude = v.lat AND cp.longitude = v.lng AND cp.active
            AND (cp.reclaimed_water_source IS NULL OR cp.reclaimed_water_source = 'county_meter')`,
        [verdict.water, verdict.source, now.toISOString(), ...chunk.flatMap((row) => [row.id, row.latitude, row.longitude])],
      );
      written += result?.rowCount ?? 0;
    }
  }
  return { checked: rows.length, written, reclaimed: groups.true.length, notFound: groups.false.length, outside: groups.null.length };
}

/**
 * The daily tick (the layer itself is downloaded about weekly): download when the stored layer is missing or older than
 * six days, then match every property when the layer was just refreshed, else only the properties never checked. A failed
 * download keeps the stored layer and the stored values. Returns a small summary for the log and the job row.
 */
async function runDailyTick({ knex = defaultDb, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  let refreshed = null;
  if (await layerIsStale(knex, now)) {
    try {
      refreshed = await storeMeters(await fetchAllMeters({ fetchImpl }), { knex, now });
    } catch (err) {
      logger.warn(`[reclaimed-water] county layer not refreshed (${err?.code || err?.name || 'Error'}); keeping the stored layer`);
      if (!Number((await knex('reclaimed_water_meters').count('* as n').first())?.n)) throw err; // nothing usable stored at all
    }
  }
  const matched = await matchProperties({ knex, now, all: refreshed != null });
  return { refreshed, ...matched };
}

module.exports = {
  LAYER_QUERY_URL, PAGE_SIZE, IN_SERVICE_LIFECYCLE, MATCH_RADIUS_M, USER_AGENT, REFRESH_AFTER_MS, MIN_PLAUSIBLE_METERS,
  distanceM, pageUrl, parsePage, fetchPage, fetchAllMeters, storeMeters, layerIsStale,
  buildIndex, nearestMeter, judgePoint, matchProperties, runDailyTick,
};
