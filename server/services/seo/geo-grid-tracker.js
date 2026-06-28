/**
 * geo-grid-tracker.js — native geo-grid map-pack rank tracking (Pillar 3).
 *
 * For each office we drop an N×N grid of lat/lng pins, query the Google Maps
 * local pack at each pin (DataForSEO serpMaps already accepts a "lat,lng,radius"
 * coordinate via serpLocation), and record where the office's GBP ranks in the
 * pack at that point. The result is a per-office heat map: green where we win
 * the map pack, red where we don't — the measurement layer for local SEO.
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

// ── Config (tune to control DataForSEO spend) ────────────────────────────────
const GRID_SIZE = 5; // N×N pins per office/keyword (5×5 = 25)
const GRID_SPACING_MILES = 2; // distance between adjacent pins (≈ 8mi × 8mi area)
const KEYWORDS = ['pest control', 'exterminator', 'termite control'];
const COORDINATE_RADIUS_KM = 5; // DataForSEO location_coordinate search radius
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

/** This office's rank within the map-pack items (by place_id; fallback title). null if absent. */
function findOfficeRank(items, office) {
  for (const m of items) {
    const pid = m.place_id || '';
    const title = String(m.title || '').toLowerCase();
    const rank = m.rank_absolute || m.rank_group || null;
    if ((office.googlePlaceId && pid === office.googlePlaceId) || title.includes('waves pest control')) {
      return rank;
    }
  }
  return null;
}

async function scanOfficeKeyword(office, keyword, scanDate) {
  const pins = buildGrid(office);
  let stored = 0;
  for (const pin of pins) {
    let rank = null;
    let top = [];
    try {
      const data = await dataforseo.serpMaps(keyword, `${pin.latitude},${pin.longitude},${COORDINATE_RADIUS_KM}`);
      const items = data?.tasks?.[0]?.result?.[0]?.items || [];
      rank = findOfficeRank(items, office);
      top = items.slice(0, 3).map((m) => ({ title: m.title, rank: m.rank_absolute || m.rank_group || null }));
    } catch (err) {
      logger.warn(`[geo-grid] ${office.id}/${keyword} pin ${pin.row},${pin.col} failed: ${err.message}`);
    }
    await db('geo_grid_ranks')
      .insert({
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
      .onConflict(['scan_date', 'office_id', 'keyword', 'pin_row', 'pin_col'])
      .merge();
    stored++;
  }
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
    logger.warn('[geo-grid] a scan is already in progress — skipping');
    return { skipped: 'in_progress' };
  }
  scanning = true;
  const scanDate = etDateString();
  const offices = WAVES_LOCATIONS.filter((o) => !officeId || o.id === officeId);
  const keywords = keyword ? [keyword] : KEYWORDS;
  let pins = 0;
  try {
    for (const office of offices) {
      for (const kw of keywords) {
        pins += await scanOfficeKeyword(office, kw, scanDate);
      }
    }
  } finally {
    scanning = false;
  }
  logger.info(`[geo-grid] scan ${scanDate}: ${offices.length} office(s) × ${keywords.length} keyword(s) = ${pins} pins`);
  return { scanDate, offices: offices.length, keywords: keywords.length, pins };
}

/** Latest grid + stats for one office+keyword (drives the heat map). */
async function getHeatmap(officeId, keyword) {
  const latest = await db('geo_grid_ranks').where({ office_id: officeId, keyword }).max('scan_date as d').first();
  const scanDate = latest && latest.d;
  if (!scanDate) return { scanDate: null, gridSize: GRID_SIZE, pins: [], stats: null };
  const pins = await db('geo_grid_ranks')
    .where({ office_id: officeId, keyword, scan_date: scanDate })
    .select('pin_row', 'pin_col', 'latitude', 'longitude', 'map_pack_rank', 'found_in_pack', 'top_competitors');
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

module.exports = { runScan, getHeatmap, config, buildGrid, findOfficeRank, isScanning: () => scanning, GRID_SIZE, KEYWORDS };
