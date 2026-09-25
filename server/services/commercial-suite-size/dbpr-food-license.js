/**
 * Florida DBPR food-service license extract — the "does a restaurant hold a
 * license at this exact suite" signal for commercial-suite sizing.
 *
 * The Division of Hotels & Restaurants publishes a per-district CSV extract
 * of every active hotel/restaurant license (free, no key). Waves' service
 * area (Manatee / Sarasota / Charlotte) sits in DBPR district 7, so that is
 * the only district fetched.
 *
 * Fetch is on-demand, single-flight, and cached in-process for 24h — a
 * ~2.5MB latin-1 CSV is too large to fetch per lookup, and licenses churn
 * slowly enough that a day-old copy is fine. A fetch/parse failure never
 * throws: the caller treats a null return as "this source has nothing" and
 * falls through to the next one.
 */

const logger = require('../logger');

// Waves' three counties (Manatee, Sarasota, Charlotte) are all DBPR district 7.
const DBPR_FOOD_LICENSE_DISTRICTS = [7];

function dbprExtractUrl(district) {
  return `https://www2.myfloridalicense.com/sto/file_download/extracts/hrfood${district}.csv`;
}

const DBPR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// seats → suite sqft. A dine-in seat needs roughly its own share of BOH
// (kitchen/prep/storage/restrooms) on top of the floor space it occupies —
// 600 sqft covers a minimal kitchen+storage core, and each seat adds ~32 sqft
// of combined dining + proportional kitchen area. Clamped to a plausible
// strip-mall/plaza suite range: a 0-seat license (takeout/ghost kitchen)
// floors at the minimum automatically (600 + 32*0 = 600 < 1000 → 1000).
const SEATS_TO_SQFT_BASE = 600;
const SEATS_TO_SQFT_PER_SEAT = 32;
const SEATS_TO_SQFT_MIN = 1000;
const SEATS_TO_SQFT_MAX = 6000;

function seatsToSqft(seats) {
  const n = Number(seats);
  const clean = Number.isFinite(n) && n > 0 ? n : 0;
  const raw = SEATS_TO_SQFT_BASE + SEATS_TO_SQFT_PER_SEAT * clean;
  return Math.max(SEATS_TO_SQFT_MIN, Math.min(SEATS_TO_SQFT_MAX, Math.round(raw)));
}

// ── CSV parsing ─────────────────────────────────────────────────

// RFC4180-ish parser: quoted fields, doubled-quote escaping, CRLF/LF/CR line
// endings. The extract is small enough (~15k rows/district) that a
// straightforward char scan is fine — no streaming needed.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const len = text.length;
  for (let i = 0; i < len; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseDbprCsv(text) {
  const rows = parseCsvRows(String(text || ''));
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h || '').trim());
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const raw = rows[i];
    if (!raw.length) continue;
    const obj = {};
    for (let c = 0; c < header.length; c += 1) obj[header[c]] = raw[c] !== undefined ? raw[c] : '';
    out.push(obj);
  }
  return out;
}

// ── Address matching ────────────────────────────────────────────

// Street-name normalization: "SR 70 E" and "State Road 70 East" must compare
// equal. Direction words and common highway spellings collapse to their
// abbreviation; punctuation and case fall away.
function normalizeStreetName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\bSTATE\s+ROAD\b/g, 'SR')
    .replace(/\bSTATE\s+RD\b/g, 'SR')
    .replace(/\bCOUNTY\s+ROAD\b/g, 'CR')
    .replace(/\bCOUNTY\s+RD\b/g, 'CR')
    .replace(/\bHIGHWAY\b/g, 'HWY')
    .replace(/\bINTERSTATE\b/g, 'I')
    .replace(/\bNORTH\b/g, 'N')
    .replace(/\bSOUTH\b/g, 'S')
    .replace(/\bEAST\b/g, 'E')
    .replace(/\bWEST\b/g, 'W')
    .replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bSTREET\b/g, 'ST')
    .replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bROAD\b/g, 'RD')
    .replace(/\bPARKWAY\b/g, 'PKWY')
    .replace(/\bCOURT\b/g, 'CT')
    .replace(/\bPLACE\b/g, 'PL')
    .replace(/\bLANE\b/g, 'LN')
    .replace(/\bCIRCLE\b/g, 'CIR')
    .replace(/\bTRAIL\b/g, 'TRL')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const UNIT_TAIL_RE = /(?:^|\s)(?:#|ste\.?|suite|unit|bldg\.?|building)\s*#?\s*([\w-]+)\s*$/i;

// Splits "4400 Test Commons Pkwy E #102" (or "4400 Test Commons Pkwy E,
// Suite 102") into house number / street / unit. Deliberately simple — callers pass an
// already-normalized {street, unit} pair when they have one (the estimator
// engine's address-normalizer output); this is the fallback for a raw
// "Location Street Address" CSV cell, which never carries a separate unit
// column.
function parseAddressLine(line) {
  const cleaned = String(line || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { houseNumber: null, streetName: '', unit: null };
  let rest = cleaned;
  let unit = null;
  const unitMatch = rest.match(UNIT_TAIL_RE);
  if (unitMatch) {
    unit = unitMatch[1].toUpperCase();
    rest = rest.slice(0, unitMatch.index).trim();
  }
  const houseMatch = rest.match(/^(\d+[A-Za-z]?)\s+(.*)$/);
  if (!houseMatch) return { houseNumber: null, streetName: normalizeStreetName(rest), unit };
  return {
    houseNumber: houseMatch[1].toUpperCase(),
    streetName: normalizeStreetName(houseMatch[2]),
    unit,
  };
}

function normalizeUnitValue(value) {
  return String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase() || null;
}

function normalizePhoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normalizeBusinessName(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function businessNameMatches(candidate, hint) {
  const a = normalizeBusinessName(candidate);
  const b = normalizeBusinessName(hint);
  if (!a || !b || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

// A single license row's location address, parsed once.
function rowLocation(row) {
  const parsed = parseAddressLine(row['Location Street Address']);
  return {
    ...parsed,
    zip: String(row['Location Zip Code'] || '').trim().slice(0, 5),
  };
}

/**
 * Find the ONE DBPR row describing the target suite, or null when nothing
 * matches or more than one candidate matches with no disambiguator (the
 * spec's "skip on ambiguity" rule — a wrong match is worse than no match).
 *
 * target: { street, unit, zip } (house number is parsed out of `street`,
 * matching the estimator's normalized {street, unit} address shape),
 * phone (any format), businessNameHint (free text).
 */
function matchDbprRow(rows, { street, unit, zip, phone, businessNameHint } = {}) {
  const targetZip = String(zip || '').trim().slice(0, 5);
  if (!targetZip || !street) return null;
  const targetParsed = parseAddressLine(street);
  const targetHouse = targetParsed.houseNumber;
  const targetStreet = targetParsed.streetName;
  const targetUnit = normalizeUnitValue(unit || targetParsed.unit);
  const targetPhone = normalizePhoneDigits(phone);
  if (!targetHouse || !targetStreet) return null;

  const addressMatches = rows.filter((row) => {
    const loc = rowLocation(row);
    return loc.zip === targetZip
      && loc.houseNumber === targetHouse
      && loc.streetName === targetStreet;
  });
  if (!addressMatches.length) return null;

  const disambiguated = addressMatches.filter((row) => {
    const loc = rowLocation(row);
    const rowUnit = normalizeUnitValue(loc.unit);
    if (targetUnit && rowUnit && rowUnit === targetUnit) return true;
    if (targetPhone) {
      const rowPhone = normalizePhoneDigits(row['Secondary Phone Number'])
        || normalizePhoneDigits(row['Primary Phone Number']);
      if (rowPhone && rowPhone === targetPhone) return true;
    }
    if (businessNameHint && businessNameMatches(row['Business Name'], businessNameHint)) return true;
    return false;
  });

  if (disambiguated.length !== 1) return null;
  return disambiguated[0];
}

// ── Fetch + cache ───────────────────────────────────────────────

const _cache = new Map(); // district -> { rows, fetchedAt }
const _inflight = new Map(); // district -> Promise

async function defaultFetchText(url) {
  const res = await fetch(url);
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder('latin1').decode(buf);
}

async function loadDistrictRows(district, { fetchText = defaultFetchText, now = () => Date.now() } = {}) {
  const cached = _cache.get(district);
  if (cached && (now() - cached.fetchedAt) < DBPR_CACHE_TTL_MS) return cached.rows;
  if (_inflight.has(district)) return _inflight.get(district);
  const promise = (async () => {
    try {
      const text = await fetchText(dbprExtractUrl(district));
      const rows = parseDbprCsv(text);
      _cache.set(district, { rows, fetchedAt: now() });
      return rows;
    } catch (err) {
      logger.warn(`[commercial-suite-size] DBPR extract fetch failed for district ${district}: ${err.message}`);
      return cached ? cached.rows : [];
    } finally {
      _inflight.delete(district);
    }
  })();
  _inflight.set(district, promise);
  return promise;
}

// Test-only: clear the module cache so suites don't leak state across files.
function _resetCacheForTests() {
  _cache.clear();
  _inflight.clear();
}

/**
 * Resolve a suite's size from an active DBPR food-service license, or null.
 * Fail-open: any fetch/parse error resolves null, never throws.
 */
async function resolveViaDbprLicense({ address = {}, phone = null, businessNameHint = null } = {}, opts = {}) {
  try {
    const districts = opts.districts || DBPR_FOOD_LICENSE_DISTRICTS;
    let rows = [];
    for (const district of districts) {
      const districtRows = await loadDistrictRows(district, opts);
      rows = rows.concat(districtRows);
    }
    if (!rows.length) return null;
    const row = matchDbprRow(rows, {
      street: address.street,
      unit: address.unit,
      zip: address.zip,
      phone,
      businessNameHint,
    });
    if (!row) return null;
    const seats = Number(row['Number of Seats or Rental Units']);
    const value = seatsToSqft(seats);
    const businessName = String(row['Business Name'] || '').trim() || null;
    const locationAddress = String(row['Location Street Address'] || '').trim();
    return {
      value,
      businessName,
      seats: Number.isFinite(seats) ? seats : 0,
      evidence: [{
        source: 'license_seats',
        detail: `Florida DBPR food-service license (${row['License Number'] || 'active'}) at ${locationAddress || 'this suite'} — ${Number.isFinite(seats) ? seats : 0} seats → ${value.toLocaleString()} sq ft`,
      }],
    };
  } catch (err) {
    logger.warn(`[commercial-suite-size] DBPR resolve failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  DBPR_FOOD_LICENSE_DISTRICTS,
  dbprExtractUrl,
  parseDbprCsv,
  normalizeStreetName,
  parseAddressLine,
  matchDbprRow,
  seatsToSqft,
  resolveViaDbprLicense,
  loadDistrictRows,
  _resetCacheForTests,
};
