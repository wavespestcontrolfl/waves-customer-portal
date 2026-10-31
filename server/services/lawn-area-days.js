/**
 * Lawn rounds neighborhood days (owner 2026-10-31: "build"). A lawn 9x plan
 * books one visit a round in nine fixed rounds (lawn-rounds.js). The engine
 * places every visit of a series from the series ANCHOR's offset in its round
 * and its weekday, so two series with the SAME anchor land on the same date in
 * every round. An AREA (a set of ZIPs and cities) owns one anchor date; a NEW
 * lawn_rounds_9 series in the area is born with that anchor, so neighbors are
 * treated together on one shared day in every round.
 *
 * Config: system_settings key `lawn_round_area_days` (JSON text or jsonb), read
 * at call time like scheduling/zone-route-days.js:
 *   {"parrish": {"label": "Parrish", "zips": ["34219"], "cities": ["parrish"], "anchor": "2027-01-12"}}
 *   - key ABSENT       -> DEFAULT_LAWN_ROUND_AREA_DAYS (below)
 *   - `{}`             -> no areas (the kill switch: every series keeps its own anchor)
 *   - invalid JSON, a non-object value or a read failure -> no areas (logged once)
 *   - anchor           one real weekday (Mon-Fri) inside a round whose in-round offset leaves at
 *                      least 7 days on both sides, so a one-week move never crosses a round edge.
 *                      An area with any other anchor is ignored (logged once).
 *
 * Matching: ZIP first (the first 5 digits of the series parent's
 * service_address_zip, else the customer's zip), then city (parent
 * service_address_city, else the customer's city; lower-cased, trimmed, spaces
 * collapsed). ZIP beats city: live data 10-31 had 9 of 11 lawn 9x customers
 * whose city reads "Bradenton" in Lakewood Ranch ZIPs. No area -> null: the
 * series keeps its own anchor (the behavior before this module).
 *
 * The anchor is STAMPED on the series parent at creation
 * (recurring_round_anchor_date), so a later config edit does not move an
 * existing series. Only rows whose pattern is lawn_rounds_9 reach this module,
 * and those exist only behind GATE_LAWN_9X_ROUNDS (or the one-time re-date).
 */

const logger = require('./logger');
const { LAWN_ROUNDS_9, roundOf, lawnRoundDateFrom } = require('./lawn-rounds');

const LAWN_ROUND_AREA_DAYS_KEY = 'lawn_round_area_days';

// First follow-up floor: a new series whose area date in the next round is
// closer than this to the parent's own visit uses parent date + this many days
// for that one follow-up. Later rounds follow the area anchor.
const AREA_FIRST_FOLLOW_UP_MIN_DAYS = 28;
// An anchor needs this many days on both sides inside its round.
const ANCHOR_MARGIN_DAYS = 7;

const DEFAULT_LAWN_ROUND_AREA_DAYS = Object.freeze({
  parrish: Object.freeze({
    label: 'Parrish',
    zips: Object.freeze(['34219']),
    cities: Object.freeze(['parrish', 'duette']),
    anchor: '2027-01-12',
  }),
  lakewood_ranch: Object.freeze({
    label: 'Lakewood Ranch',
    zips: Object.freeze(['34202', '34211', '34212']),
    cities: Object.freeze(['lakewood ranch', 'lakewood rch']),
    anchor: '2027-01-19',
  }),
});

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  try { logger.warn(`[lawn-area-days] ${message}`); } catch { /* logging never breaks a series write */ }
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function utcDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function diffDays(fromStr, toStr) {
  return Math.round((utcDay(toStr) - utcDay(fromStr)) / 86400000);
}

function addDays(dateStr, days) {
  return new Date(utcDay(dateStr) + days * 86400000).toISOString().slice(0, 10);
}

function normalizeZip(value) {
  const zip = String(value == null ? '' : value).trim().slice(0, 5);
  return /^\d{5}$/.test(zip) ? zip : null;
}

function normalizeCity(value) {
  const city = String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
  return city || null;
}

// A usable area anchor: a real YYYY-MM-DD on Monday-Friday whose offset in its
// round leaves ANCHOR_MARGIN_DAYS on both sides inside the round. Returns the
// date string or null.
function validAreaAnchor(value) {
  const anchor = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return null;
  const parsed = new Date(`${anchor}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== anchor) return null;
  const weekday = parsed.getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  const home = roundOf(anchor);
  if (!home) return null;
  const offset = diffDays(home.start, anchor);
  if (offset < ANCHOR_MARGIN_DAYS || home.length - 1 - offset < ANCHOR_MARGIN_DAYS) return null;
  return anchor;
}

function listOf(value, normalize) {
  return (Array.isArray(value) ? value : []).map(normalize).filter(Boolean);
}

// Pure parse of the stored value (JSON text, or an already-parsed object from
// a jsonb column) into an ORDERED list of valid areas:
// [{ key, label, zips: Set, cities: Set, anchor }]. A malformed value, an
// invalid area (bad anchor) and a ZIP or city already claimed by an earlier
// area are dropped with a one-time warning.
function parseLawnAreaDays(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch {
      warnOnce('invalid-json', `${LAWN_ROUND_AREA_DAYS_KEY} is not valid JSON (no areas)`);
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnOnce('invalid-shape', `${LAWN_ROUND_AREA_DAYS_KEY} is not an object (no areas)`);
    return [];
  }
  const areas = [];
  const claimedZips = new Map();
  const claimedCities = new Map();
  for (const [rawKey, rule] of Object.entries(parsed)) {
    const key = String(rawKey || '').trim();
    if (!key || !rule || typeof rule !== 'object') continue;
    const anchor = validAreaAnchor(rule.anchor);
    if (!anchor) {
      warnOnce(`anchor:${key}:${rule.anchor}`, `area "${key}" ignored: anchor ${JSON.stringify(rule.anchor)} must be a Mon-Fri date at least ${ANCHOR_MARGIN_DAYS} days inside its round`);
      continue;
    }
    const zips = new Set();
    for (const zip of listOf(rule.zips, normalizeZip)) {
      if (claimedZips.has(zip)) warnOnce(`zip:${zip}`, `ZIP ${zip} is listed by "${claimedZips.get(zip)}" and "${key}": the first wins`);
      else { claimedZips.set(zip, key); zips.add(zip); }
    }
    const cities = new Set();
    for (const city of listOf(rule.cities, normalizeCity)) {
      if (claimedCities.has(city)) warnOnce(`city:${city}`, `city "${city}" is listed by "${claimedCities.get(city)}" and "${key}": the first wins`);
      else { claimedCities.set(city, key); cities.add(city); }
    }
    areas.push({ key, label: String(rule.label || key), zips, cities, anchor });
  }
  return areas;
}

// The configured areas, read at call time. Never throws.
async function readLawnAreaDays(conn) {
  try {
    const dbh = conn || require('../models/db');
    const row = await dbh('system_settings').where('key', LAWN_ROUND_AREA_DAYS_KEY).first('value');
    if (!row) return parseLawnAreaDays(DEFAULT_LAWN_ROUND_AREA_DAYS);
    return parseLawnAreaDays(row.value);
  } catch (err) {
    warnOnce('read-failure', `config lookup failed (no areas): ${err.message}`);
    return [];
  }
}

// Pure: the area for an address, or null. ZIP beats city.
function matchLawnArea(areas, { zip = null, city = null } = {}) {
  const wantZip = normalizeZip(zip);
  if (wantZip) {
    const byZip = (areas || []).find((area) => area.zips.has(wantZip));
    if (byZip) return byZip;
  }
  const wantCity = normalizeCity(city);
  if (wantCity) {
    const byCity = (areas || []).find((area) => area.cities.has(wantCity));
    if (byCity) return byCity;
  }
  return null;
}

// The address a series is matched on: the parent's service address, field by
// field, else the customer's. The parent row is trusted when it carries the
// service_address_* keys; otherwise it is read by id (only the columns that
// exist, so a missing column cannot abort a caller's transaction).
async function seriesAddress(conn, parentRow) {
  let zip = parentRow?.service_address_zip;
  let city = parentRow?.service_address_city;
  const rowHasAddress = parentRow && ('service_address_zip' in parentRow || 'service_address_city' in parentRow);
  if (!rowHasAddress && parentRow?.id) {
    const cols = await conn('scheduled_services').columnInfo();
    const wanted = ['service_address_zip', 'service_address_city'].filter((c) => cols[c]);
    if (wanted.length) {
      const row = await conn('scheduled_services').where({ id: parentRow.id }).first(...wanted);
      zip = row?.service_address_zip;
      city = row?.service_address_city;
    }
  }
  if ((!normalizeZip(zip) || !normalizeCity(city)) && parentRow?.customer_id) {
    const customer = await conn('customers').where({ id: parentRow.customer_id }).first('zip', 'city');
    if (!normalizeZip(zip)) zip = customer?.zip;
    if (!normalizeCity(city)) city = customer?.city;
  }
  return { zip, city };
}

// The area anchor for a series parent (a row, or { customer_id } before the
// parent exists), or null when no area applies. Never throws.
async function lawnAreaRoundAnchor(conn, parentRow) {
  try {
    const areas = await readLawnAreaDays(conn);
    if (!areas.length) return null;
    const area = matchLawnArea(areas, await seriesAddress(conn, parentRow));
    return area ? area.anchor : null;
  } catch (err) {
    warnOnce('anchor-failure', `area lookup failed (series keeps its own anchor): ${err.message}`);
    return null;
  }
}

// The anchor a NEW series is born with: the area anchor when the pattern is
// lawn_rounds_9 and the parent has no stored recurring_round_anchor_date, else
// null. Every creator and its planner call this one helper so the plan and the
// write agree.
async function newSeriesAreaAnchor(conn, parentRow, pattern) {
  if (pattern !== LAWN_ROUNDS_9 || dateOnly(parentRow?.recurring_round_anchor_date)) return null;
  return lawnAreaRoundAnchor(conn, parentRow);
}

// First follow-up floor. `areaDate` is the area's date in the next round,
// `baseDate` the parent's own visit: when the area date is fewer than
// AREA_FIRST_FOLLOW_UP_MIN_DAYS after the visit, the first follow-up is the
// visit + that many days. Inside the next round by construction: the area date
// is on or after the round start, so a visit within the window sits after
// start - 28 and +28 reaches past the start; the visit is on or before the
// previous round's last day and +28 stays under the 40-day round length.
function areaFirstFollowUpDate(baseDate, areaDate) {
  const base = dateOnly(baseDate);
  const area = dateOnly(areaDate);
  if (!base || !area || !/^\d{4}-\d{2}-\d{2}$/.test(base) || !/^\d{4}-\d{2}-\d{2}$/.test(area)) return areaDate;
  return diffDays(base, area) < AREA_FIRST_FOLLOW_UP_MIN_DAYS ? addDays(base, AREA_FIRST_FOLLOW_UP_MIN_DAYS) : area;
}

// The rounds date walk with the optional first follow-up floor, shared by the
// seeder, the office planners and the prepay schedule: lawnRoundDateFrom, and
// for a NEW series on an area anchor (`firstGapFloor`) visit 1 of the walk
// (`i` = 1) is floored by areaFirstFollowUpDate.
function lawnRoundDateFromFloored(anchorDateStr, baseDateStr, i, firstGapFloor) {
  const date = lawnRoundDateFrom(anchorDateStr, baseDateStr, i);
  return firstGapFloor && i === 1 ? areaFirstFollowUpDate(baseDateStr, date) : date;
}

module.exports = {
  LAWN_ROUND_AREA_DAYS_KEY,
  DEFAULT_LAWN_ROUND_AREA_DAYS,
  AREA_FIRST_FOLLOW_UP_MIN_DAYS,
  parseLawnAreaDays,
  readLawnAreaDays,
  matchLawnArea,
  validAreaAnchor,
  lawnAreaRoundAnchor,
  newSeriesAreaAnchor,
  areaFirstFollowUpDate,
  lawnRoundDateFromFloored,
  _resetWarnings: () => warned.clear(),
};
