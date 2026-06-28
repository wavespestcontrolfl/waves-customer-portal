/**
 * geo-grid-tracker.js — native geo-grid map-pack rank tracking (Pillar 3).
 *
 * For each office we drop an N×N grid of lat/lng pins, query the Google Maps
 * local pack at each pin (DataForSEO serpMaps with a "lat,lng,zoom" coordinate
 * and search_places off), and record where the office's GBP ranks in the pack at
 * that point. The result is a per-office heat map: green where we win the map
 * pack, red where we don't — the measurement layer for local SEO.
 *
 * Matching: the office's googlePlaceId vs each map item's place_id (fallback: a
 * "waves pest control" title match). null rank = not in the returned pack there.
 *
 * COST: this hits DataForSEO live (pay-per-call). One run = OFFICES × KEYWORDS ×
 * GRID_SIZE² calls. The constants below are the spend knob — keep the grid lean.
 * Gated opt-in (geoGridTracking); the underlying serpMaps also needs the
 * seoIntelligence gate (DataForSEO master) on.
 */

const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const { WAVES_LOCATIONS } = require('../../config/locations');
const { etDateString } = require('../../utils/datetime-et');
const { runExclusive, isLocked } = require('../../utils/cron-lock');

// ── Config (tune to control DataForSEO spend) ────────────────────────────────
const GRID_SIZE = 5; // N×N pins per office/keyword (5×5 = 25)
const GRID_SPACING_MILES = 2; // distance between adjacent pins (≈ 8mi × 8mi area)
const KEYWORDS = ['pest control', 'exterminator', 'termite control'];
// DataForSEO Maps `location_coordinate` is "lat,lng,ZOOM" (0–21z, default 17z) —
// NOT a km radius. Lower zoom = wider area, higher = tighter/more local. The grid
// effect comes from the per-pin lat/lng; this is the viewport. Tunable.
const GRID_ZOOM = 14;
const MILES_PER_DEG_LAT = 69.0;

// Simple in-process guard so a manual run + the cron can't overlap (a full run
// is many slow live calls). The cron additionally takes a runExclusive lock.
let scanning = false;

/** N×N grid of { row, col, latitude, longitude } centered on the office. Row 0 = north. */
function buildGrid(office) {
  const pins = [];
  const half = (GRID_SIZE - 1) / 2;
  const dLat = GRID_SPACING_MILES / MILES_PER_DEG_LAT;
  const dLng = GRID_SPACING_MILES / (MILES_PER_DEG_LAT * Math.cos((office.latitude * Math.PI) / 180));
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      pins.push({
        row,
        col,
        latitude: Number((office.latitude + (half - row) * dLat).toFixed(6)),
        longitude: Number((office.longitude + (col - half) * dLng).toFixed(6)),
      });
    }
  }
  return pins;
}

/** This office's rank within the map-pack items. Matches THIS office's GBP by
 *  place_id (a different Waves office's listing must not count as this office's
 *  win); the "waves pest control" title fallback applies ONLY to items with no
 *  place_id to disambiguate. null if absent. */
function findOfficeRank(items, office) {
  for (const m of items) {
    const pid = m.place_id || '';
    const rank = m.rank_group || m.rank_absolute || null; // rank within the organic pack
    if (office.googlePlaceId && pid) {
      if (pid === office.googlePlaceId) return rank;
      continue; // a known, different place_id — not this office
    }
    if (String(m.title || '').toLowerCase().includes('waves pest control')) return rank;
  }
  return null;
}

async function scanOfficeKeyword(office, keyword, scanDate, runId) {
  const pins = buildGrid(office);
  let stored = 0;
  let skipped = 0;
  for (const pin of pins) {
    let succeeded = false;
    let items = [];
    try {
      // search_places:false — the default mode can return a DIFFERENT location's
      // pack than the coordinate; each pin must measure the rank at THAT point.
      const data = await dataforseo.serpMaps(keyword, `${pin.latitude},${pin.longitude},${GRID_ZOOM}`, { search_places: false });
      const task = data?.tasks?.[0];
      // A successful Maps task returns `result` as an array — possibly EMPTY (no
      // listings shown at this coordinate). That's a real "no pack here" answer,
      // NOT a failure: treat it as success and store a null-rank miss below. Only
      // a missing/non-array result (null data, gate off, API/task error) is
      // skipped, so a transient failure can't overwrite a valid cell or make a
      // partial run look complete.
      if (task && Array.isArray(task.result)) {
        succeeded = true;
        // Organic local-pack entries only — exclude ads (maps_paid_item). rank_group
        // is position WITHIN the organic pack (rank_absolute counts across ad items).
        items = (task.result[0]?.items || []).filter((m) => m.type === 'maps_search');
      }
    } catch (err) {
      logger.warn(`[geo-grid] ${office.id}/${keyword} pin ${pin.row},${pin.col} failed: ${err.message}`);
    }
    if (!succeeded) {
      skipped++;
      continue;
    }
    const rank = findOfficeRank(items, office);
    const top = items.slice(0, 3).map((m) => ({ title: m.title, rank: m.rank_group || m.rank_absolute || null }));
    await db('geo_grid_ranks')
      .insert({
        scan_run_id: runId,
        scan_date: scanDate,
        office_id: office.id,
        keyword,
        pin_row: pin.row,
        pin_col: pin.col,
        latitude: pin.latitude,
        longitude: pin.longitude,
        map_pack_rank: rank,
        found_in_pack: rank != null,
        top_competitors: JSON.stringify(top),
      })
      .onConflict(['scan_run_id', 'office_id', 'keyword', 'pin_row', 'pin_col'])
      .merge();
    stored++;
  }
  if (skipped) logger.warn(`[geo-grid] ${office.id}/${keyword}: ${skipped}/${pins.length} pins skipped (no SERP result) — not stored`);
  return stored;
}

/**
 * Run a geo-grid scan. Pass {officeId, keyword} to scope to one (manual run);
 * omit for the full weekly sweep. Returns a summary.
 */
async function runScan({ officeId = null, keyword = null } = {}) {
  if (!dataforseo.configured) {
    logger.warn('[geo-grid] DataForSEO not configured — skipping');
    return { skipped: 'dataforseo_unconfigured' };
  }
  if (scanning) {
    logger.warn('[geo-grid] a scan is already in progress (this instance) — skipping');
    return { skipped: 'in_progress' };
  }
  // Cross-instance lock — a manual run + the weekly cron + a Railway deploy
  // overlap must not double-spend live API calls or race the same-day upserts.
  // runExclusive returns { skipped:true } when the lease is held elsewhere.
  const result = await runExclusive('geo-grid-scan', async () => {
    scanning = true;
    const scanDate = etDateString();
    // Unique per invocation so a same-day rerun is a DISTINCT run — a partial
    // rerun can't leave stale earlier-run pins that make the date look complete.
    const runId = new Date().toISOString();
    const offices = WAVES_LOCATIONS.filter((o) => !officeId || o.id === officeId);
    const keywords = keyword ? [keyword] : KEYWORDS;
    let pins = 0;
    try {
      for (const office of offices) {
        for (const kw of keywords) {
          pins += await scanOfficeKeyword(office, kw, scanDate, runId);
        }
      }
    } finally {
      scanning = false;
    }
    logger.info(`[geo-grid] scan ${scanDate} (${runId}): ${offices.length} office(s) × ${keywords.length} keyword(s) = ${pins} pins`);
    return { scanDate, runId, offices: offices.length, keywords: keywords.length, pins };
  });
  if (result && result.skipped) {
    logger.info('[geo-grid] scan lease held elsewhere — skipped');
    return { skipped: 'locked' };
  }
  return result;
}

/** Latest grid + stats for one office+keyword (drives the heat map). */
async function getHeatmap(officeId, keyword) {
  // Latest RUN with a COMPLETE grid only — a partial scan (transient DataForSEO
  // failures skip pins) is its own run and is ignored; the last fully-stored run
  // still shows. scan_run_id is an ISO timestamp, so desc = most recent.
  const expected = GRID_SIZE * GRID_SIZE;
  const run = await db('geo_grid_ranks')
    .where({ office_id: officeId, keyword })
    .select('scan_run_id')
    .groupBy('scan_run_id')
    .havingRaw('count(*) >= ?', [expected])
    .orderBy('scan_run_id', 'desc')
    .first();
  const runId = run && run.scan_run_id;
  if (!runId) return { scanDate: null, gridSize: GRID_SIZE, pins: [], stats: null };
  const pins = await db('geo_grid_ranks')
    .where({ office_id: officeId, keyword, scan_run_id: runId })
    .select('pin_row', 'pin_col', 'latitude', 'longitude', 'map_pack_rank', 'found_in_pack', 'top_competitors', 'scan_date');
  const scanDate = pins[0] ? pins[0].scan_date : null;
  const ranked = pins.filter((p) => p.map_pack_rank != null).map((p) => p.map_pack_rank);
  const stats = {
    total: pins.length,
    found: ranked.length,
    top3Pct: pins.length ? Math.round((pins.filter((p) => p.map_pack_rank != null && p.map_pack_rank <= 3).length / pins.length) * 100) : 0,
    avgRank: ranked.length ? Number((ranked.reduce((a, b) => a + b, 0) / ranked.length).toFixed(1)) : null,
    // Share of Local Voice — avg of (21-rank)/20 across ALL pins (0 where absent), 0–100%.
    solv: pins.length
      ? Math.round((pins.reduce((a, p) => a + (p.map_pack_rank != null ? Math.max(0, 21 - p.map_pack_rank) / 20 : 0), 0) / pins.length) * 100)
      : 0,
  };
  return { scanDate, gridSize: GRID_SIZE, pins, stats };
}

/** Cross-instance "is a scan running" — a run holds the 'geo-grid-scan' advisory
 *  lock, so this is true even when the scan is on another Railway instance. Used
 *  by the status endpoint the UI polls; falls back to the local flag on error. */
async function isScanRunning() {
  try {
    return await isLocked('geo-grid-scan');
  } catch {
    return scanning;
  }
}

/** Static config for the UI (offices, keywords, grid size). */
function config() {
  return {
    gridSize: GRID_SIZE,
    spacingMiles: GRID_SPACING_MILES,
    keywords: KEYWORDS,
    offices: WAVES_LOCATIONS.map((o) => ({
      id: o.id,
      name: o.name,
      latitude: o.latitude,
      longitude: o.longitude,
    })),
  };
}

module.exports = { runScan, getHeatmap, config, buildGrid, findOfficeRank, isScanning: () => scanning, isScanRunning, GRID_SIZE, KEYWORDS };
