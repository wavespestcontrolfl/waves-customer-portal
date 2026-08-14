/**
 * County pool / screen-enclosure permit lookup by parcel (pool facts Step 2).
 *
 * POSITIVE-ONLY evidence: a recent pool or enclosure permit proves a pool
 * the ANNUAL assessment roll hasn't caught up to (new construction) — the
 * exact gap the extra-features parsers can't see. Nothing found is NOT a
 * negative signal: Manatee's layer carries OPEN permits only, Charlotte's
 * covers new-construction records only, unpermitted pools are common, and
 * Sarasota has no public permit service at all.
 *
 * Live-probe findings (2026-06-12, curl-verified — keep in sync if a layer
 * moves):
 *   - Manatee: gisbads BuildingDeptSearch/MapServer/1 ("Building Permits").
 *     SELECTPIN = clean 10-digit parcel PIN (matches the PAO parid the
 *     lookup already carries). Closed PERMIT_TYPE vocabulary: pool =
 *     'Pool_Spa'; screen enclosure / cage / lanai = 'Aluminum Structure'.
 *     PERMIT_ISSUE is epoch-ms. STAT='O' rows only (open permits) — live
 *     through yesterday at probe time.
 *   - Charlotte: agis3 CCGIS_ComDev_Internal/MapServer/159 ("BuildingPermits",
 *     Accela join; anonymously queryable). ACCOUNT = 12-digit parcel account
 *     (the PAO account the lookup already carries). No standalone pool/cage
 *     record types — detection is DESCRIPTION text match on new-construction
 *     records ("NEW CONSTRUCTION RESIDENTIAL WITH POOL"), so additions to
 *     existing homes are NOT visible here.
 *   - Sarasota: NO publicly queryable permit layer (8 discovery attempts —
 *     building.scgov.net is a Blazor app with no REST backend). Unsupported;
 *     the county XFOB extra-features roll remains the Sarasota pool signal.
 *
 * String WHERE clauses are verified-supported on both county MapServers
 * (these are county-hosted, not the hosted-layer 400-on-string trap), and
 * parcel ids are validated digits-only BEFORE interpolation — anything else
 * returns null rather than reaching the URL.
 *
 * Tunables (mirror parcel-gis / fema-nfhl):
 *   COUNTY_PERMITS_TIMEOUT_MS — request timeout (default 3500)
 *   COUNTY_PERMITS_DISABLED=1 — kill switch (lookups return null)
 *   MANATEE_PERMITS_URL / CHARLOTTE_PERMITS_URL — endpoint overrides
 *
 * Logs are prefixed `[county-permits]`; parcel ids never appear in logs
 * (AGENTS.md PII rule) — county + elapsed only.
 */

const logger = require('../logger');

const DEFAULT_MANATEE_PERMITS_URL = 'https://www.mymanatee.org/gisbads/rest/services/landdevelopment/BuildingDeptSearch/MapServer/1/query';
const DEFAULT_CHARLOTTE_PERMITS_URL = 'https://agis3.charlottecountyfl.gov/arcgis/rest/services/Internal/CCGIS_ComDev_Internal/MapServer/159/query';
const DEFAULT_COUNTY_PERMITS_TIMEOUT_MS = 3500;

function countyPermitsTimeoutMs() {
  const n = Number(process.env.COUNTY_PERMITS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_COUNTY_PERMITS_TIMEOUT_MS;
}

function isCountyPermitsDisabled() {
  const flag = process.env.COUNTY_PERMITS_DISABLED;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// Injection guard: both counties key permits on an all-digits parcel id
// (Manatee 10-digit PIN, Charlotte 12-digit account). Anything else never
// reaches a WHERE clause.
function cleanParcelDigits(parcelId) {
  const s = String(parcelId ?? '').trim();
  return /^\d{8,14}$/.test(s) ? s : null;
}

function epochMsToIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function queryArcgis(url, where, outFields, timeoutMs) {
  const params = new URLSearchParams({
    f: 'json',
    where,
    outFields: outFields.join(','),
    returnGeometry: 'false',
    resultRecordCount: '20',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${url}?${params.toString()}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`permit layer ${resp.status}`);
    const data = await resp.json();
    if (data?.error) throw new Error(`permit layer error: ${data.error.message || data.error.code}`);
    return Array.isArray(data?.features) ? data.features.map((f) => f?.attributes || {}) : [];
  } finally {
    clearTimeout(timer);
  }
}

// Newest-first reduce: keep the most recent permit per category.
function keepNewest(current, candidate) {
  if (!candidate.issuedAt) return current || candidate;
  if (!current || !current.issuedAt || candidate.issuedAt > current.issuedAt) return candidate;
  return current;
}

async function lookupManateePermits(pin, timeoutMs, address) {
  // GIS outage must not take the synced-table backstop down with it — the
  // sync exists precisely for what the live layer can't see. A GIS failure
  // is only rethrown at the END when the backstop found nothing, so the
  // caller's null-means-retry contract still holds for truly-unchecked
  // parcels; positive synced evidence wins over retry semantics.
  let gisError = null;
  let rows = [];
  try {
    rows = await queryArcgis(
      process.env.MANATEE_PERMITS_URL || DEFAULT_MANATEE_PERMITS_URL,
      `SELECTPIN='${pin}' AND PERMIT_TYPE IN ('Pool_Spa','Aluminum Structure')`,
      ['PERMIT_NO', 'PERMIT_TYPE', 'PERMIT_ISSUE'],
      timeoutMs,
    );
  } catch (err) {
    gisError = err;
  }
  let poolPermit = null;
  let enclosurePermit = null;
  for (const row of rows) {
    const permit = {
      permitNo: String(row.PERMIT_NO || '') || null,
      type: String(row.PERMIT_TYPE || '') || null,
      issuedAt: epochMsToIso(row.PERMIT_ISSUE),
    };
    if (row.PERMIT_TYPE === 'Pool_Spa') poolPermit = keepNewest(poolPermit, permit);
    else if (row.PERMIT_TYPE === 'Aluminum Structure') enclosurePermit = keepNewest(enclosurePermit, permit);
  }
  // Closed-permit backstop: the GIS layer above carries OPEN permits only
  // (STAT='O'), so a pool whose permit closed since the last assessment
  // roll is invisible to both live sources. pool_permit_records is the
  // weekly ACA "Pool Permits (CSV)" sync (Pool-Spa only — enclosures stay
  // GIS-only). Its own try/catch: a missing table (migration not run,
  // sync gate never flipped) or DB blip must not sink the GIS evidence.
  try {
    // Lazy require: keeps this module free of a load-time db dependency
    // (tests drive it with a mocked global.fetch only).
    const { findSyncedPoolPermit, looseKeyFromFreeform } = require('./manatee-permit-sync');
    const synced = await findSyncedPoolPermit({
      parcelPin: pin,
      looseKey: looseKeyFromFreeform(address),
    });
    if (synced) poolPermit = keepNewest(poolPermit, synced);
  } catch (err) {
    // Code/name only — a raw Knex error message can echo the failing SQL
    // with parcel/address bindings (AGENTS.md PII rule).
    logger.warn('[county-permits] synced-permit read failed', {
      error: err?.code || err?.name || 'db_error',
    });
  }
  if (gisError && !poolPermit) throw gisError;
  // gisUnavailable: the pool evidence is real (synced table), but the
  // enclosure side was NEVER checked — callers must not persist this
  // result as a completed "checked" marker, or the GIS layer is never
  // retried for the enclosure.
  if (gisError) return { poolPermit, enclosurePermit: null, gisUnavailable: true };
  return { poolPermit, enclosurePermit };
}

async function lookupCharlottePermits(account, timeoutMs) {
  const rows = await queryArcgis(
    process.env.CHARLOTTE_PERMITS_URL || DEFAULT_CHARLOTTE_PERMITS_URL,
    `ACCOUNT='${account}' AND UPPER(DESCRIPTION) LIKE '%POOL%'`,
    ['RECORD_ID', 'RECORD_TYPE', 'DESCRIPTION', 'DATE_OPENED'],
    timeoutMs,
  );
  let poolPermit = null;
  for (const row of rows) {
    // Code-enforcement rows mention pools too ("pool cage missing screens")
    // — they are complaints, not construction evidence.
    if (/code enforcement/i.test(String(row.RECORD_TYPE || ''))) continue;
    poolPermit = keepNewest(poolPermit, {
      permitNo: String(row.RECORD_ID || '') || null,
      type: String(row.RECORD_TYPE || '') || null,
      issuedAt: epochMsToIso(row.DATE_OPENED),
    });
  }
  // Charlotte's descriptions don't separate enclosures from the pool build.
  return { poolPermit, enclosurePermit: null };
}

// Returns { poolPermit, enclosurePermit } (each { permitNo, type, issuedAt }
// or null — a successful empty query returns the empty object so callers can
// persist "checked"), or null entirely when the county is unsupported, the
// parcel id is unusable, the gate is off, or the provider failed (fail-open).
async function lookupPoolPermitsByParcel({ county, parcelId, address } = {}, options = {}) {
  if (isCountyPermitsDisabled()) {
    logger.info('[county-permits] skipped — COUNTY_PERMITS_DISABLED');
    return null;
  }
  const digits = cleanParcelDigits(parcelId);
  if (!digits) return null;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : countyPermitsTimeoutMs();

  const t0 = Date.now();
  try {
    let result = null;
    if (county === 'Manatee') result = await lookupManateePermits(digits, timeoutMs, address);
    else if (county === 'Charlotte') result = await lookupCharlottePermits(digits, timeoutMs);
    else return null; // Sarasota (no public layer) and anything unknown
    // A SUCCESSFUL empty query still returns the (empty) object: callers
    // persist it as a "checked" marker so permit-less parcels aren't
    // re-queried on every cache hit. Only failures return null (retry).
    if (result.poolPermit || result.enclosurePermit) {
      logger.info('[county-permits] permit evidence found', {
        county,
        hasPoolPermit: Boolean(result.poolPermit),
        hasEnclosurePermit: Boolean(result.enclosurePermit),
        elapsedMs: Date.now() - t0,
      });
    }
    return result;
  } catch (err) {
    logger.warn('[county-permits] lookup failed', {
      county: county || null,
      error: err?.message || String(err),
      elapsedMs: Date.now() - t0,
    });
    return null;
  }
}

module.exports = {
  lookupPoolPermitsByParcel,
  countyPermitsTimeoutMs,
  _private: { cleanParcelDigits, epochMsToIso, keepNewest },
};
