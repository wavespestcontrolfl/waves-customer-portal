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
const { parse: parseCsvSync } = require('csv-parse/sync');

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

// The repository's installed parser (csv-parse), not a second bespoke one:
// the extract is externally controlled, so malformed quoting and format
// drift get the same handling as every other CSV import. A parse error
// THROWS — loadDistrictRows treats it as a failed refresh (never cached).
function parseDbprCsv(text) {
  return parseCsvSync(String(text || ''), {
    columns: (header) => header.map((h) => String(h || '').trim()),
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
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

// A compound designator ("Bldg 9 Unit 204") is TWO designator+value pairs,
// not one — the trailing `+` captures every pair in the run, not just the
// last, so the whole compound (not merely "204") is pulled out of the
// street name (primary review of PR #4840 r5 P2). A bare single pair
// ("#102") still matches as one iteration, unchanged.
const UNIT_TAIL_RE = /(?:^|\s)((?:(?:#|ste\.?|suite|unit|bldg\.?|building|space|spc\.?|bay)\s*#?\s*[\w-]+\s*)+)$/i;

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
// Unit key, compared on both sides (caller address and DBPR row). Every
// designator word is dropped (whole words only, so "WEST" keeps its "ST"),
// then each remaining value keeps its own boundary: "Bldg 9 Unit 204" and
// "BLDG 9 UNIT 204" -> "9-204", never "9204" (which "Bldg 92 Unit 04" would
// also produce). "#102", "Suite 102", "102" -> "102".
const UNIT_DESIGNATOR_RE = /\b(?:suite|ste|unit|apt|apartment|bldg|building|bay|space|spc)\b\.?|#/gi;

function normalizeUnitValue(value) {
  const parts = String(value || '').replace(UNIT_DESIGNATOR_RE, ' ')
    .split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p.toUpperCase());
  return parts.length ? parts.join('-') : null;
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
// The suite can sit in its own column ("Location Address Line 2") rather
// than the street line, so both are joined before the unit is parsed.
function rowLocation(row) {
  const street = String(row['Location Street Address'] || '').trim();
  const line2 = String(row['Location Address Line 2'] || '').trim();
  // A bare "102" in line 2 gets a "#" so the unit parser recognizes it.
  // A bare suite value in line 2 ("102", "A", "A-1") gets a "#" so the unit
  // parser recognizes it; a designator-led value ("STE 102") is left as is.
  const line2Unit = /^[A-Za-z0-9]{1,4}(?:-[A-Za-z0-9]{1,4})?$/.test(line2) ? `#${line2}` : line2;
  const parsed = parseAddressLine(line2 && !parseAddressLine(street).unit ? `${street} ${line2Unit}` : street);
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

  // Exact-unit licenses are the candidate set whenever one exists — a
  // unitless row that only hint-matches (phone / name) must never displace
  // the license that names this very suite. Hint-only matching applies
  // only when no exact-unit license exists, and never to a row that names
  // a DIFFERENT suite (a shared owner's phone, a loose name hit).
  const exactUnit = targetUnit
    ? addressMatches.filter((row) => normalizeUnitValue(rowLocation(row).unit) === targetUnit)
    : [];
  let candidates;
  if (exactUnit.length) {
    // Two licenses on the same suite: the caller's phone or name picks one.
    candidates = exactUnit.length > 1 ? exactUnit.filter(hintMatches) : exactUnit;
  } else {
    candidates = addressMatches.filter((row) => {
      const rowUnit = normalizeUnitValue(rowLocation(row).unit);
      if (targetUnit && rowUnit && rowUnit !== targetUnit) return false;
      return hintMatches(row);
    });
  }
  if (candidates.length !== 1) return null;
  return candidates[0];

  function hintMatches(row) {
    if (targetPhone) {
      // Either license phone can be the business line — compare both.
      const rowPhones = [row['Secondary Phone Number'], row['Primary Phone Number']].map(normalizePhoneDigits);
      if (rowPhones.includes(targetPhone)) return true;
    }
    if (businessNameHint && businessNameMatches(row['Business Name'], businessNameHint)) return true;
    return false;
  }
}

// ── Fetch + cache ───────────────────────────────────────────────

const _cache = new Map(); // district -> { rows, fetchedAt }
const _inflight = new Map(); // district -> Promise
const _failedAt = new Map(); // district -> ms of last failed fetch

// A hung state server must never hang a property lookup: bound the download,
// and after a failure back off instead of re-downloading on every lookup.
// A failed refresh may keep serving the last good extract only for a
// bounded window past its TTL (stale-if-error) — never indefinitely, or a
// closed restaurant or a changed seat count would keep pricing as a current
// license through a long outage; past the window the resolver gets no rows
// and falls through to the low-confidence default.
const DBPR_FETCH_TIMEOUT_MS = 15000;
const DBPR_FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const DBPR_STALE_IF_ERROR_MS = 48 * 60 * 60 * 1000;

async function defaultFetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DBPR_FETCH_TIMEOUT_MS) });
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder('latin1').decode(buf);
}

async function loadDistrictRows(district, { fetchText = defaultFetchText, now = () => Date.now() } = {}) {
  const cached = _cache.get(district);
  if (cached && (now() - cached.fetchedAt) < DBPR_CACHE_TTL_MS) return cached.rows;
  const staleIfError = () => (cached && (now() - cached.fetchedAt) < DBPR_CACHE_TTL_MS + DBPR_STALE_IF_ERROR_MS
    ? cached.rows
    : []);
  if (_inflight.has(district)) return _inflight.get(district);
  const failedAt = _failedAt.get(district);
  if (failedAt != null && (now() - failedAt) < DBPR_FAILURE_BACKOFF_MS) return staleIfError();
  const promise = (async () => {
    try {
      const text = await fetchText(dbprExtractUrl(district));
      // A malformed or truncated HTTP-200 body is a failed refresh, not an
      // empty license list: it throws (parse error) or parses to no rows (a
      // real district extract carries thousands), and either way it goes
      // down the failure path below — never cached for 24h, and the last
      // good extract keeps serving within the stale-if-error window.
      const rows = parseDbprCsv(text);
      if (!rows.length) throw new Error('empty or unparseable extract');
      _cache.set(district, { rows, fetchedAt: now() });
      _failedAt.delete(district);
      return rows;
    } catch (err) {
      _failedAt.set(district, now());
      logger.warn(`[commercial-suite-size] DBPR extract fetch failed for district ${district}: ${err.message}`);
      return staleIfError();
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
  _failedAt.clear();
}

// Only an ACTIVE PERMANENT food-service license sizes a suite. The extract
// also carries mobile food units (2014), caterers (2013), vending (2015) and
// temporary events (2016) — none of them occupy the bay — plus inactive
// licenses a prior tenant left behind (primary status other than 20).
// Seats must be a clean integer: a seated place (rank SEAT) needs at least
// one, a takeout-only place (rank NOST) legitimately has zero.
const DBPR_PERMANENT_FOOD_SERVICE = '2010';
const DBPR_ACTIVE_STATUS = '20';

function isEligibleDineInLicense(row) {
  if (!row) return false;
  if (String(row['License Type Code'] || '').trim() !== DBPR_PERMANENT_FOOD_SERVICE) return false;
  if (String(row['Primary Status Code'] || '').trim() !== DBPR_ACTIVE_STATUS) return false;
  const seatsRaw = String(row['Number of Seats or Rental Units'] || '').trim();
  if (!/^\d+$/.test(seatsRaw)) return false;
  const rank = String(row['Rank Code'] || '').trim().toUpperCase();
  if (rank === 'NOST') return true;
  return rank === 'SEAT' && Number(seatsRaw) > 0;
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
      rows = rows.concat(await loadDistrictRows(district, opts));
    }
    rows = rows.filter(isEligibleDineInLicense);
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
  normalizeUnitValue,
  seatsToSqft,
  resolveViaDbprLicense,
  loadDistrictRows,
  isEligibleDineInLicense,
  _resetCacheForTests,
};
