/**
 * geo-grid-named-searches.js — the eight-search scoreboard on the SEO page.
 *
 * The four priority cities (owner O2: Sarasota, Bradenton, Venice, Parrish)
 * times pest and lawn, each read from the geo-grid tracker's stored scans:
 * the map-pack position in the latest complete scan and the change against a
 * complete scan at least four weeks older.
 *
 * Read-only. It makes no DataForSEO call of its own; a row only has numbers
 * once the weekly scan (GATE_GEO_GRID) has covered that office and keyword.
 */

const db = require('../../models/db');
const GeoGrid = require('./geo-grid-tracker');

// office_id is the WAVES_LOCATIONS key. The 'bradenton' office's GBP is branded
// Lakewood Ranch, but the priority city it stands for is Bradenton.
const NAMED_SEARCH_CITIES = Object.freeze([
  { officeId: 'sarasota', city: 'Sarasota' },
  { officeId: 'bradenton', city: 'Bradenton' },
  { officeId: 'venice', city: 'Venice' },
  { officeId: 'parrish', city: 'Parrish' },
]);
const NAMED_SEARCH_KEYWORDS = Object.freeze([
  { keyword: 'pest control', label: 'Pest control' },
  { keyword: 'lawn care', label: 'Lawn care' },
]);
const BASELINE_MIN_DAYS = 28; // "last month" = a scan at least four weekly scans back
const LOOKBACK_DAYS = 365;

function daysBetween(laterYmd, earlierYmd) {
  return Math.round((Date.parse(`${laterYmd}T00:00:00Z`) - Date.parse(`${earlierYmd}T00:00:00Z`)) / 86400000);
}

function runStats(run) {
  const pins = Number(run.pins) || 0;
  const found = Number(run.found) || 0;
  return {
    scanDate: run.scan_date,
    gridSize: Number(run.grid_size) || null,
    pins,
    found,
    // Average rank over the pins where the office shows at all; null = in no pack.
    position: found && run.avg_rank != null ? Number(Number(run.avg_rank).toFixed(1)) : null,
    top3Pct: pins ? Math.round(((Number(run.top3) || 0) / pins) * 100) : 0,
  };
}

/**
 * Pure: one row per named search from per-run aggregates.
 * runs: [{ office_id, keyword (lowercased), scan_run_id, scan_date 'YYYY-MM-DD',
 *          grid_size, pins, found, avg_rank, top3 }] — complete runs only.
 * liveKeywords: the tracker's current keyword list (what the next scan covers).
 */
function summarizeNamedSearches(runs, liveKeywords = []) {
  const live = new Set(liveKeywords.map((k) => String(k).trim().toLowerCase()));
  const out = [];
  for (const { officeId, city } of NAMED_SEARCH_CITIES) {
    for (const { keyword, label } of NAMED_SEARCH_KEYWORDS) {
      // scan_run_id is an ISO timestamp, so descending = most recent first.
      const mine = runs
        .filter((r) => r.office_id === officeId && r.keyword === keyword)
        .sort((a, b) => String(b.scan_run_id).localeCompare(String(a.scan_run_id)));
      const latest = mine[0] || null;
      // Same grid size only: a 3×3 and a 7×7 scan cover different ground, so
      // their averages are not comparable.
      const earlier = latest
        ? mine.find((r) => Number(r.grid_size) === Number(latest.grid_size)
          && daysBetween(latest.scan_date, r.scan_date) >= BASELINE_MIN_DAYS) || null
        : null;
      const current = latest ? runStats(latest) : null;
      const baseline = earlier ? runStats(earlier) : null;
      out.push({
        officeId,
        city,
        keyword,
        label: `${label} in ${city}`,
        tracked: live.has(keyword),
        current,
        baseline,
        // Positive = moved up the pack (a smaller rank number).
        positionChange: current && baseline && current.position != null && baseline.position != null
          ? Number((baseline.position - current.position).toFixed(1))
          : null,
        top3Change: current && baseline ? current.top3Pct - baseline.top3Pct : null,
      });
    }
  }
  return out;
}

async function getNamedSearches() {
  const keywords = NAMED_SEARCH_KEYWORDS.map((k) => k.keyword);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  // Complete runs only, judged against the run's own grid_size² (same rule as
  // the heat map), so a partial scan never reads as a ranking drop.
  const runs = await db('geo_grid_ranks')
    .whereIn('office_id', NAMED_SEARCH_CITIES.map((c) => c.officeId))
    .whereIn(db.raw('lower(keyword)'), keywords)
    .where('scan_date', '>=', since)
    .groupBy('office_id', db.raw('lower(keyword)'), 'scan_run_id')
    .havingRaw('count(*) >= (max(grid_size) * max(grid_size))')
    .select(
      'office_id',
      'scan_run_id',
      db.raw('lower(keyword) as keyword'),
      db.raw("to_char(min(scan_date), 'YYYY-MM-DD') as scan_date"),
      db.raw('max(grid_size) as grid_size'),
      db.raw('count(*) as pins'),
      db.raw('count(map_pack_rank) as found'),
      db.raw('avg(map_pack_rank) as avg_rank'),
      db.raw('count(*) filter (where map_pack_rank <= 3) as top3'),
    );
  return { searches: summarizeNamedSearches(runs, await GeoGrid.getKeywords()) };
}

module.exports = {
  getNamedSearches,
  summarizeNamedSearches,
  NAMED_SEARCH_CITIES,
  NAMED_SEARCH_KEYWORDS,
  BASELINE_MIN_DAYS,
};
