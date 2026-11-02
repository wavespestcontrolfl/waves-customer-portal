'use strict';

/**
 * Public Pest Pressure Index (GET /api/public/pest-pressure-index,
 * GATE_PUBLIC_PEST_PRESSURE_INDEX).
 *
 * Owner 2026-11-02 (backlink plan step 5, "Pest Pressure Index"): publish
 * COUNTY AVERAGES of the technician's on-site pest-activity rating from
 * completed service visits. Nothing below the county leaves the server: no
 * customer name, address, ZIP or visit.
 *
 * What is counted
 *   - service_records.status = 'completed', joined to its pest_pressure_scores
 *     row, and ONLY technician tap readings (the score row carries the
 *     technicianActivityRating component, #4741, since the 2026-09-24 cutover).
 *     The value counted is that component's own value: the technician's 0-5
 *     tap. Never service_records.pressure_index or displayed_score: an admin
 *     override (pest-pressure/store.js applyOverride) rewrites both and keeps
 *     the component, so they can hold a score the technician never gave.
 *     Blended readings (customer-submitted, or recorded before the cutover)
 *     sit on another scale and are never mixed in.
 *   - Window: the 90 calendar days ending yesterday (America/New_York,
 *     inclusive), never starting before the cutover date.
 *   - Internal test customers (internal-test-customers.js) are excluded, by
 *     name and by id.
 *   - The customers table has no county column in production, so each visit's
 *     county comes from the customer's 5-digit ZIP through
 *     resolveRestrictionCounty. A ZIP that does not map to exactly one county
 *     (straddling, unknown, malformed) drops the visit.
 *   - Group = county x service line, service line being
 *     COALESCE(service_line, service_type, 'unknown'). A group is published
 *     only at MIN_VISITS or more visits. Smaller groups are counted
 *     (hidden_groups) but never named.
 *
 * The grouping, rounding and suppression are the pure function
 * computePublicPestPressureIndex (no database); loadRows is the thin query.
 * The computed answer is cached in memory for one hour; a failed query is not
 * cached and surfaces as status 'unavailable'.
 */

const logger = require('./logger');
const { TECH_RATING_CUTOVER_DATE } = require('./pest-pressure/score-scale');
const { INTERNAL_TEST_CUSTOMERS, isInternalTestCustomerId, INTERNAL_TEST_CUSTOMER_IDS } = require('./internal-test-customers');
const { resolveRestrictionCounty } = require('../config/irrigation-restrictions');
const { etDateString, addETDays, etCalendarDaysUntil, parseETDateTime } = require('../utils/datetime-et');

const MIN_VISITS = 20;
const WINDOW_DAYS = 90;
const CACHE_MS = 60 * 60 * 1000;

const NAME = 'Waves Pest Pressure Index';
const PAGE_URL = 'https://www.wavespestcontrol.com/pest-pressure-index/';

// The technician's tap labels, 0-5. Source of truth: DEFAULT_CONFIG.labels in
// pest-pressure/config.js (owner ruling 2026-09-24: six bands, 0 none ...
// 5 high), the same names the tech app's picker shows. Pinned here, not read
// from the editable settings, so a Settings edit never silently rewrites a
// public contract (public-pest-pressure-index.test.js checks they still agree).
const SCALE_LABELS = Object.freeze({
  0: 'None',
  1: 'Very Low',
  2: 'Low',
  3: 'Moderate',
  4: 'Elevated',
  5: 'High',
});

const SOURCE = 'Completed Waves Pest Control service visits rated by the technician on site. Not a survey and not a forecast.';
const CSV_HEADER = 'county,service_line,visits,average,median,window_start,window_end';

// ---- dates (calendar strings, YYYY-MM-DD, via utils/datetime-et) ----

// End = yesterday's ET calendar date (inclusive). Start = the later of the ET
// date WINDOW_DAYS back (end - 89 days) and the tap cutover date. `days` is the
// inclusive count (0 when the window would be empty, i.e. before the cutover
// has a full day behind it).
function windowFor(now = new Date()) {
  const end = etDateString(addETDays(now, -1));
  const earliest = etDateString(addETDays(now, -WINDOW_DAYS));
  const start = earliest > TECH_RATING_CUTOVER_DATE ? earliest : TECH_RATING_CUTOVER_DATE;
  const days = start > end ? 0 : etCalendarDaysUntil(end, parseETDateTime(`${start}T12:00`)) + 1;
  return { start, end, days };
}

// ---- pure computation ----

function round1(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function median(sortedAscending) {
  const n = sortedAscending.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAscending[mid] : (sortedAscending[mid - 1] + sortedAscending[mid]) / 2;
}

function internalName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.toLowerCase();
}

function isInternalRow(row) {
  if (isInternalTestCustomerId(row.customer_id)) return true;
  return INTERNAL_TEST_CUSTOMERS.includes(internalName(row));
}

function dateOnly(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(value || ''));
  return m ? m[0] : null;
}

function countyForZip(zip) {
  const five = String(zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(five)) return null;
  const county = resolveRestrictionCounty({ zip: five });
  return typeof county === 'string' && county.trim() ? county.trim() : null;
}

function serviceLineOf(value) {
  const text = String(value ?? '').trim();
  return text || 'unknown';
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// One visit row -> { county, line, value }, or null when it does not count.
function eligibleVisit(row, window) {
  if (!row || row.is_tap === false) return null; // technician taps only
  const raw = row.tap_rating;
  const value = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 5) return null;
  const day = dateOnly(row.service_date);
  if (!day || day < window.start || day > window.end) return null;
  if (isInternalRow(row)) return null;
  const county = countyForZip(row.zip);
  if (!county) return null;
  return { county, line: serviceLineOf(row.service_line), value };
}

/**
 * rows: { customer_id, first_name, last_name, zip, service_line, service_date,
 *         tap_rating, is_tap } — one per completed visit. The query already
 * filters; every rule is applied here again so the function is correct on its own.
 */
function computePublicPestPressureIndex(rows, { now = new Date() } = {}) {
  const window = windowFor(now);
  const buckets = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const visit = eligibleVisit(row, window);
    if (!visit) continue;
    const key = JSON.stringify([visit.county, visit.line]);
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { county: visit.county, service_line: visit.line, values: [] }; buckets.set(key, bucket); }
    bucket.values.push(visit.value);
  }

  const groups = [];
  let hidden = 0;
  for (const bucket of buckets.values()) {
    if (bucket.values.length < MIN_VISITS) { hidden += 1; continue; }
    const sorted = bucket.values.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((total, v) => total + v, 0);
    groups.push({
      county: bucket.county,
      service_line: bucket.service_line,
      visits: sorted.length,
      average: round1(sum / sorted.length),
      median: round1(median(sorted)),
    });
  }
  groups.sort((a, b) => compare(a.county, b.county) || compare(a.service_line, b.service_line));

  return {
    name: NAME,
    region: 'Southwest Florida',
    window,
    scale: {
      min: 0,
      max: 5,
      labels: { ...SCALE_LABELS },
      meaning: "Technician's on-site pest activity rating at a completed Waves service visit.",
    },
    min_visits: MIN_VISITS,
    groups,
    hidden_groups: hidden,
    source: SOURCE,
    license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    citation: `Waves Pest Control. Southwest Florida Pest Pressure Index. ${PAGE_URL}`,
    page_url: PAGE_URL,
    generated_at: new Date(now).toISOString(),
  };
}

// ---- CSV ----

// RFC 4180 quoting, plus a leading apostrophe on anything a spreadsheet would
// read as a formula.
function csvCell(value) {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(body) {
  const lines = [CSV_HEADER];
  for (const g of body.groups) {
    lines.push([g.county, g.service_line, g.visits, g.average.toFixed(1), g.median.toFixed(1), body.window.start, body.window.end]
      .map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ---- database ----

const NAME_SQL = "LOWER(COALESCE(customers.first_name, '') || ' ' || COALESCE(customers.last_name, ''))";

// jsonb_exists, never the `?` operator: knex reads `?` as a binding.
function buildQuery(window) {
  const bindings = [window.start, window.end];
  const where = [
    "service_records.status = 'completed'",
    "(pps.component_scores->'technicianActivityRating'->>'value') IS NOT NULL",
    "jsonb_exists(pps.component_scores, 'technicianActivityRating')",
    'service_records.service_date >= ?',
    'service_records.service_date <= ?',
  ];
  if (INTERNAL_TEST_CUSTOMERS.length) {
    where.push(`${NAME_SQL} NOT IN (${INTERNAL_TEST_CUSTOMERS.map(() => '?').join(', ')})`);
    bindings.push(...INTERNAL_TEST_CUSTOMERS);
  }
  if (INTERNAL_TEST_CUSTOMER_IDS.length) {
    where.push(`service_records.customer_id::text NOT IN (${INTERNAL_TEST_CUSTOMER_IDS.map(() => '?').join(', ')})`);
    bindings.push(...INTERNAL_TEST_CUSTOMER_IDS);
  }
  const sql = `
    SELECT
      service_records.customer_id AS customer_id,
      customers.first_name AS first_name,
      customers.last_name AS last_name,
      customers.zip AS zip,
      COALESCE(service_records.service_line, service_records.service_type, 'unknown') AS service_line,
      to_char(service_records.service_date, 'YYYY-MM-DD') AS service_date,
      pps.component_scores->'technicianActivityRating'->>'value' AS tap_rating,
      TRUE AS is_tap
    FROM service_records
    JOIN pest_pressure_scores pps ON pps.service_record_id = service_records.id
    JOIN customers ON customers.id = service_records.customer_id
    WHERE ${where.join('\n      AND ')}
  `;
  return { sql, bindings };
}

async function loadRows(window, knex) {
  const { sql, bindings } = buildQuery(window);
  const result = await knex.raw(sql, bindings);
  return Array.isArray(result?.rows) ? result.rows : [];
}

// ---- cache + entry point ----

let cached = null; // { body, expiresAt }
let inFlight = null;

function _clearCache() { cached = null; inFlight = null; }

/**
 * { status: 'ok', body, csv, expiresAt } or { status: 'unavailable' }.
 * `now` and `knex` are injectable for tests.
 */
async function getPublicPestPressureIndex({ now = new Date(), knex } = {}) {
  const nowMs = new Date(now).getTime();
  if (cached && cached.expiresAt > nowMs) return { status: 'ok', ...cached };
  if (!inFlight) {
    inFlight = (async () => {
      const db = knex || require('../models/db');
      const window = windowFor(now);
      const rows = await loadRows(window, db);
      const body = computePublicPestPressureIndex(rows, { now });
      cached = { body, csv: toCsv(body), expiresAt: nowMs + CACHE_MS };
      return cached;
    })().finally(() => { inFlight = null; });
  }
  try {
    return { status: 'ok', ...(await inFlight) };
  } catch (err) {
    logger.error(`[public-pest-pressure-index] query failed: ${err.message}`);
    return { status: 'unavailable' };
  }
}

module.exports = {
  MIN_VISITS,
  WINDOW_DAYS,
  SCALE_LABELS,
  CSV_HEADER,
  windowFor,
  computePublicPestPressureIndex,
  toCsv,
  getPublicPestPressureIndex,
  _private: { buildQuery, countyForZip, csvCell, round1, _clearCache },
};
