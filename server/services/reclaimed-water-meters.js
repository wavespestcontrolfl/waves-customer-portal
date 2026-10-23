/**
 * Reclaimed water meters (GATE_LAWN_RECLAIMED_HALF_N, owner 2026-10-23).
 *
 * Manatee County publishes where its reclaimed (purple pipe) water meters are, as a public ArcGIS layer. This module
 * downloads that layer into `reclaimed_water_meters` and marks the properties that sit at a meter. The match runs HERE,
 * on our own copy: nothing about a property (no coordinate, address or id) is ever sent to the county service. The only
 * outbound request is the constant query below, so the test asserts the URL and headers carry no property data.
 *
 * Sarasota and Charlotte publish no such layer, and a miss in Manatee proves nothing either, so the county only ever says YES (a property at a meter);
 * every other property keeps no county value. An
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

// A raw ArcGIS coordinate as a number, or NaN. null, '' and booleans would coerce to 0 and pass as a real point, so only a number or a
// non-blank numeric string counts.
function rawCoordinate(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

// One in-service feature as a point, or null when its id or geometry is unusable.
function featurePoint(feature) {
  const objectid = Number(feature?.attributes?.OBJECTID);
  const lng = rawCoordinate(feature?.geometry?.x);
  const lat = rawCoordinate(feature?.geometry?.y);
  if (!Number.isInteger(objectid) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return isInService(feature.attributes) ? { objectid, lat, lng } : null;
}

// One ArcGIS answer to points. A feature with no usable geometry, or one that is retired or not in service, is dropped; the server reports its own error as a 200 body.
function parsePage(body) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('county layer answered with no body'), { code: 'bad_body' });
  if (body.error) throw Object.assign(new Error(`county layer error ${body.error.code || ''}`.trim()), { code: 'layer_error' });
  // A page with no features array is a broken answer, never an empty last page: accepting it would end the download early and let a partial layer
  // replace the stored one.
  if (!Array.isArray(body.features)) throw Object.assign(new Error('county layer answered with no features'), { code: 'bad_body' });
  const features = body.features;
  const points = [];
  for (const feature of features) {
    const point = featurePoint(feature);
    if (point) points.push(point);
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
    // An empty page that still advertises more results is a broken answer too.
    if (!received && more) throw Object.assign(new Error('county layer returned an empty page that claims more'), { code: 'empty_page' });
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
  for (const m of meters) {
    const key = `${cellOf(m.lat)}:${cellOf(m.lng)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(m);
  }
  return { cells };
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

/**
 * Is the point at a reclaimed meter (within MATCH_RADIUS_M)? The county layer can only ever say YES. A point with no meter near is not
 * "not reclaimed": the layer covers one county, its extent is not its boundary (a Sarasota point just over the line is inside any bounding
 * box), and a lawn can be reclaimed with its meter beyond 30 m. So a miss writes nothing and the property stays unknown (full nitrogen
 * until the office or a meter says otherwise).
 */
function atMeter(index, lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && nearestMeter(index, lat, lng) !== null;
}

async function loadIndex(knex) {
  return buildIndex((await knex('reclaimed_water_meters').select('objectid', 'lat', 'lng')).map((m) => ({ objectid: m.objectid, lat: Number(m.lat), lng: Number(m.lng) })));
}

/**
 * Settle the county value of the properties that have coordinates and no office or customer value. A property at a meter becomes
 * true / 'county_meter'; a property the county marked earlier whose meter is gone (a new layer dropped it) goes back to no value; a property
 * at no meter keeps no value. Both of those carry the check time only (reclaimed_water and its source NULL). `all: false` visits the properties with no county value, and those
 * marked before the stored layer was fetched (so a refresh whose match pass failed is finished by the next tick). Writes only the
 * county-owned columns, never updated_at, and never a row whose source is 'office' or 'customer' or whose coordinates changed since they
 * were read. Safe to run twice.
 */
async function matchProperties({ knex = defaultDb, now = new Date(), all = true } = {}) {
  const index = await loadIndex(knex);
  const layerAt = (await knex('reclaimed_water_meters').max('fetched_at as latest').first())?.latest || now;
  if (!index.cells.size) return { checked: 0, reclaimed: 0, cleared: 0, written: 0, skipped: 'no_meters' };
  const rows = await knex('customer_properties')
    .where({ active: true })
    .whereNotNull('latitude').whereNotNull('longitude')
    .where((q) => q.whereNull('reclaimed_water_source').orWhere('reclaimed_water_source', 'county_meter'))
    .modify((q) => {
      // Incremental: only rows never checked (a new or moved property, or one the office handed back to Automatic) or checked against an
      // older layer. A miss is stamped too (below), so an unmatched property is not re-matched every day.
      if (!all) q.where((w) => w.whereNull('reclaimed_water_checked_at').orWhere('reclaimed_water_checked_at', '<', layerAt));
    })
    .select('id', 'latitude', 'longitude', 'reclaimed_water_source');
  // One pass: each row lands in exactly one group (a linear classification, never a search of the matched list per row).
  const found = [];
  const gone = [];
  const missed = [];
  for (const row of rows) {
    if (atMeter(index, Number(row.latitude), Number(row.longitude))) found.push(row);
    else if (row.reclaimed_water_source === 'county_meter') gone.push(row);
    else missed.push(row);
  }
  // A property at no meter keeps no value (source and answer NULL) but carries the time it was checked: "no county meter here".
  const at = now.toISOString();
  let written = 0;
  for (const [group, patch] of [[found, { water: true, source: 'county_meter', at }], [gone, { water: null, source: null, at }], [missed, { water: null, source: null, at }]]) {
    for (let i = 0; i < group.length; i += CHUNK) {
      const chunk = group.slice(i, i + CHUNK);
      // The write is guarded by what the verdict was judged on: the same coordinates (a move changes them and the trigger of migration
      // 20261023110000 drops the county's answer), an active row, and still no office or customer value. A row that changed meanwhile is
      // skipped and stays for the next tick, never given the old location's answer.
      const result = await knex.raw(
        `UPDATE customer_properties AS cp
            SET reclaimed_water = ?::boolean, reclaimed_water_source = ?::varchar, reclaimed_water_checked_at = ?::timestamptz
           FROM (VALUES ${chunk.map(() => '(?::uuid, ?::numeric, ?::numeric)').join(', ')}) AS v(id, lat, lng)
          WHERE cp.id = v.id AND cp.latitude = v.lat AND cp.longitude = v.lng AND cp.active
            AND (cp.reclaimed_water_source IS NULL OR cp.reclaimed_water_source = 'county_meter')`,
        [patch.water, patch.source, patch.at, ...chunk.flatMap((row) => [row.id, row.latitude, row.longitude])],
      );
      written += result?.rowCount ?? 0;
    }
  }
  return { checked: rows.length, written, reclaimed: found.length, cleared: gone.length, missed: missed.length };
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
  buildIndex, nearestMeter, atMeter, matchProperties, runDailyTick,
};
