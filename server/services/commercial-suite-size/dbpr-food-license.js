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
const UNIT_DESIGNATOR_RE = /\b(?:suite|ste|unit|apt|apartment|bldg|building|bay|space)\b\.?|#/gi;

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

  const disambiguated = addressMatches.filter((row) => {
    const loc = rowLocation(row);
    const rowUnit = normalizeUnitValue(loc.unit);
    // A license for a DIFFERENT suite at this address is never this suite,
    // whatever the phone or name says (a shared owner's phone, a loose name
    // hit) — only rows with no unit, or searches with no target unit, may be
    // picked out by phone/name.
    if (targetUnit && rowUnit && rowUnit !== targetUnit) return false;
    if (targetUnit && rowUnit && rowUnit === targetUnit) return true;
    return hintMatches(row);
  });
  // Exact-unit matches are the candidate set; when more than one license
  // names the same suite, the caller's phone or business name picks one.
  const final = disambiguated.length > 1 ? disambiguated.filter(hintMatches) : disambiguated;
  if (final.length !== 1) return null;
  return final[0];

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
const DBPR_FETCH_TIMEOUT_MS = 15000;
const DBPR_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

async function defaultFetchText(url, timeoutMs = DBPR_FETCH_TIMEOUT_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder('latin1').decode(buf);
}

async function loadDistrictRows(district, { fetchText = defaultFetchText, now = () => Date.now(), timeoutMs } = {}) {
  const cached = _cache.get(district);
  if (cached && (now() - cached.fetchedAt) < DBPR_CACHE_TTL_MS) return cached.rows;
  if (_inflight.has(district)) {
    // Joining a fetch another request started (possibly with the full 15s
    // budget) must still honor THIS caller's remaining budget.
    const joined = _inflight.get(district);
    if (!(timeoutMs > 0)) return joined;
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(cached ? cached.rows : []), timeoutMs); });
    try {
      return await Promise.race([joined, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
  const failedAt = _failedAt.get(district);
  if (failedAt != null && (now() - failedAt) < DBPR_FAILURE_BACKOFF_MS) return cached ? cached.rows : [];
  const promise = (async () => {
    try {
      // A caller with a bounded remaining lookup budget (property-lookup-v2's
      // applyCommercialSuiteSize, primary review of PR #4840 r5 P2) can
      // shorten this below the 15s default; absent, the default stands.
      const text = await fetchText(dbprExtractUrl(district), timeoutMs ?? DBPR_FETCH_TIMEOUT_MS);
      const rows = parseDbprCsv(text);
      _cache.set(district, { rows, fetchedAt: now() });
      _failedAt.delete(district);
      return rows;
    } catch (err) {
      _failedAt.set(district, now());
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
  _failedAt.clear();
}

// Synchronous, zero-I/O peek: the warm rows for a district, or null when the
// in-process cache is cold/expired. Never triggers a fetch — a cache-hit
// property lookup (server/routes/property-lookup-v2.js
// buildResultFromCachedLookup) must never await a download, so it uses this
// instead of loadDistrictRows to decide whether DBPR has anything to offer
// right now.
function peekDistrictRows(district, { now = () => Date.now() } = {}) {
  const cached = _cache.get(district);
  if (cached && (now() - cached.fetchedAt) < DBPR_CACHE_TTL_MS) return cached.rows;
  return null;
}

// Fire-and-forget warm-up for a cold district: kicks the real (single-flight,
// bounded, backed-off) fetch WITHOUT awaiting it, so a cache-hit request that
// found the cache cold isn't blocked by it, but a LATER request — fresh or
// cache-hit — may find it warm. loadDistrictRows already never throws; this
// wraps it once more defensively so a background task can never surface as
// an unhandled rejection.
function warmDistrictRowsInBackground(district, opts = {}) {
  Promise.resolve(loadDistrictRows(district, opts)).catch(() => {});
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
 *
 * opts.requireWarmCache: true — the cache-hit fast path. Uses ONLY the
 * synchronous in-process cache (peekDistrictRows); a cold/expired district
 * skips DBPR entirely for THIS call (kicking a background warm-up for next
 * time) rather than awaiting a fetch, so a cache-hit property lookup can
 * never be blocked on a download.
 */
async function resolveViaDbprLicense({ address = {}, phone = null, businessNameHint = null } = {}, opts = {}) {
  try {
    const districts = opts.districts || DBPR_FOOD_LICENSE_DISTRICTS;
    let rows = [];
    if (opts.requireWarmCache) {
      for (const district of districts) {
        const warm = peekDistrictRows(district, opts);
        if (warm == null) {
          warmDistrictRowsInBackground(district, opts);
          return null;
        }
        rows = rows.concat(warm);
      }
    } else {
      for (const district of districts) {
        const districtRows = await loadDistrictRows(district, opts);
        rows = rows.concat(districtRows);
      }
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
  peekDistrictRows,
  warmDistrictRowsInBackground,
  _resetCacheForTests,
};
