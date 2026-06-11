/**
 * Property-lookup cache + tech-verified overrides.
 *
 * Every successful lookup persists to property_lookups keyed on a sha256 of
 * the normalized address. Repeat lookups inside the TTL return the stored
 * record (fast, free, and day-to-day consistent); tech field-verified values
 * live in verified_overrides on the same row and NEVER expire — they
 * re-apply to cache hits and to every fresh lookup of the same address.
 *
 * Fail-open everywhere: any DB error degrades to a live lookup.
 *
 * Tunables:
 *   PROPERTY_LOOKUP_CACHE_TTL_DAYS — cached-data lifetime (default 180)
 *   PROPERTY_LOOKUP_CACHE_DISABLED=1 — kill switch (reads AND writes skip;
 *     verified overrides still apply — they are corrections, not cache)
 *
 * All logs are prefixed `[lookup-cache]` so they're greppable in Railway.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { normalizeLeadAddress } = require('../../utils/address-normalizer');
const { buildPropertyDataQuality } = require('./ai-property-lookup');

const DEFAULT_TTL_DAYS = 180;

// Fields a tech may verify from the field. Mirrors the estimator's editable
// dimensions; anything else in a /verify payload is dropped.
const VERIFIABLE_FIELDS = new Set([
  'squareFootage',
  'lotSize',
  'stories',
  'propertyType',
  'yearBuilt',
  'constructionMaterial',
  'roofType',
  'foundationType',
  'hasPool',
]);

// Evidence weight for tech-verified values — above live county (100): a
// person who stood on the property beats every remote source.
const VERIFIED_SOURCE_WEIGHT = 110;

// Overrides never expire and out-rank county data, so one bad save would
// poison every future estimate for the address — values are sanity-bounded
// before persisting and anything out of range is dropped.
function intInRange(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  return rounded >= min && rounded <= max ? rounded : undefined;
}

// Construction/roof/foundation overrides must land on the canonical enums
// the pricing modifiers compare against (CBS / TILE / RAISED / …) — a stored
// "tile" would clear the field-verify nudge while leaving the rodent/termite
// modifiers at baseline. Mirrors the route's normalizers, but unrecognized
// values are DROPPED rather than stored as UNKNOWN.
function normalizeVerifiedConstruction(raw) {
  const s = String(raw || '').toUpperCase();
  if (/CONCRETE|CBS|BLOCK|MASONRY|STUCCO/.test(s)) return 'CBS';
  if (/WOOD|FRAME|TIMBER/.test(s)) return 'WOOD_FRAME';
  if (/METAL|STEEL|PREFAB/.test(s)) return 'METAL';
  if (/BRICK/.test(s)) return 'BRICK';
  return undefined;
}

function normalizeVerifiedFoundation(raw) {
  const s = String(raw || '').toUpperCase();
  if (/SLAB|CONCRETE/.test(s)) return 'SLAB';
  if (/CRAWL/.test(s)) return 'CRAWLSPACE';
  if (/RAISED|PIER|PILING|STILT/.test(s)) return 'RAISED';
  if (/BASEMENT/.test(s)) return 'BASEMENT';
  return undefined;
}

function normalizeVerifiedRoof(raw) {
  const s = String(raw || '').toUpperCase();
  if (/TILE|CLAY|BARREL/.test(s)) return 'TILE';
  if (/SHINGLE|ASPHALT|COMP/.test(s)) return 'SHINGLE';
  if (/METAL|STANDING SEAM|TIN/.test(s)) return 'METAL';
  if (/FLAT|BUILT-UP|TPO|MEMBRANE/.test(s)) return 'FLAT';
  return undefined;
}

function sanitizeVerifiedValue(field, value) {
  switch (field) {
    case 'squareFootage': return intInRange(value, 100, 50000);
    case 'lotSize': return intInRange(value, 100, 200000);
    case 'stories': return intInRange(value, 1, 4);
    case 'yearBuilt': return intInRange(value, 1880, new Date().getFullYear() + 2);
    case 'hasPool': {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toUpperCase();
      if (['TRUE', 'YES', 'Y', '1'].includes(text)) return true;
      if (['FALSE', 'NO', 'N', '0'].includes(text)) return false;
      return undefined;
    }
    case 'constructionMaterial': return normalizeVerifiedConstruction(value);
    case 'roofType': return normalizeVerifiedRoof(value);
    case 'foundationType': return normalizeVerifiedFoundation(value);
    case 'propertyType': {
      const text = String(value ?? '').trim();
      return text && text.length <= 60 ? text : undefined;
    }
    default: return undefined;
  }
}

function cacheTtlDays() {
  const n = Number(process.env.PROPERTY_LOOKUP_CACHE_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
}

function isCacheDisabled() {
  return process.env.PROPERTY_LOOKUP_CACHE_DISABLED === '1'
    || process.env.PROPERTY_LOOKUP_CACHE_DISABLED === 'true';
}

function addressKey(address) {
  const normalized = normalizeLeadAddress({ raw: address });
  const canonical = (normalized.fullAddress || normalized.raw || String(address || '')).toUpperCase();
  return {
    hash: crypto.createHash('sha256').update(canonical).digest('hex'),
    normalizedAddress: canonical,
  };
}

function overridesNewerThanData(row) {
  const overrides = row?.verified_overrides || {};
  const entries = Object.values(overrides);
  if (!entries.length) return false;
  // Rows written before data_saved_at existed (or stubs) cannot prove the
  // data is newer than the correction — fail toward the live lookup.
  const dataSavedAt = row?.data_saved_at ? new Date(row.data_saved_at).getTime() : 0;
  if (!dataSavedAt) return true;
  return entries.some((entry) => {
    const verifiedAt = entry?.verifiedAt ? new Date(entry.verifiedAt).getTime() : 0;
    return verifiedAt > dataSavedAt;
  });
}

// Cached lookup data — null when the cache is disabled, the row is missing,
// the data slot is empty (override-only stub row), or the row expired.
async function getCachedLookup(address) {
  if (isCacheDisabled()) return null;
  try {
    const { hash } = addressKey(address);
    const row = await db('property_lookups').where({ address_hash: hash }).first();
    if (!row || !row.property_record) return null;
    if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
    // Defense in depth vs. partial rows (saveLookup refuses to write them):
    // no stored coordinates = no satellite regeneration = treat as a miss.
    if (row.lat == null || row.lng == null) return null;
    // A field verified AFTER the data was cached invalidates the hit: the
    // stored aiAnalysis (turf, pool cage, pest pressure) was derived from the
    // pre-correction facts. The live re-run folds the corrections into the
    // vision pass and re-saves with a fresh data_saved_at, so hits resume.
    if (overridesNewerThanData(row)) {
      logger.info('[lookup-cache] cached data predates a verified override — treating as miss');
      return null;
    }
    return row;
  } catch (err) {
    logger.warn('[lookup-cache] read failed', { error: err.message });
    return null;
  }
}

// Verified overrides are corrections, not cache: read them even when the
// cache is disabled or the row's data slot has expired.
async function getVerifiedOverrides(address) {
  try {
    const { hash } = addressKey(address);
    const row = await db('property_lookups')
      .where({ address_hash: hash })
      .first('verified_overrides');
    const overrides = row?.verified_overrides || {};
    return Object.keys(overrides).length ? overrides : null;
  } catch (err) {
    logger.warn('[lookup-cache] override read failed', { error: err.message });
    return null;
  }
}

async function saveLookup(address, result) {
  if (isCacheDisabled()) return;
  // Never cache a failed lookup — a transient outage must not become a
  // 180-day "no data" answer.
  if (!result?.propertyRecord) return;
  // Same rule for partial lookups: no geocode means no satellite imagery and
  // no vision pass — a cached no-geometry row would skip both for the whole
  // TTL (neither the estimator UI nor the public route sends refresh).
  if (!Number.isFinite(result.satellite?.lat) || !Number.isFinite(result.satellite?.lng)) return;
  // And for vision: a lookup where all three vision models failed has no
  // turf/pool/pest-pressure analysis — caching it would serve defaulted
  // pricing inputs for the whole TTL. Let the next lookup retry instead.
  if (!result.aiAnalysis) return;
  try {
    const { hash, normalizedAddress } = addressKey(address);
    const record = result.propertyRecord;
    // Anchor the data timestamp to the lookup START (meta.timestamp = t0,
    // captured before the route's overrides snapshot): an override verified
    // mid-lookup wasn't applied to this result, and anchoring here makes it
    // compare as newer than the data so the next hit invalidates.
    const dataAsOf = result.meta?.timestamp ? new Date(result.meta.timestamp) : new Date();
    const expiresAt = new Date(Date.now() + cacheTtlDays() * 24 * 60 * 60 * 1000);
    const payload = {
      address_hash: hash,
      normalized_address: normalizedAddress,
      parcel_id: record._parcel?.parcelId || null,
      county: record.county || record._parcel?.county || null,
      lat: Number.isFinite(result.satellite?.lat) ? result.satellite.lat : null,
      lng: Number.isFinite(result.satellite?.lng) ? result.satellite.lng : null,
      property_record: JSON.stringify(record),
      ai_analysis: JSON.stringify(result.aiAnalysis),
      parcel: record._parcel ? JSON.stringify(record._parcel) : null,
      providers: JSON.stringify(record._aiProviders || []),
      enriched_snapshot: result.enriched ? JSON.stringify(result.enriched) : null,
      lookup_ms: Number.isFinite(result.meta?.lookupMs) ? result.meta.lookupMs : null,
      // Freshness anchor for the override-vs-data comparison in
      // getCachedLookup (updated_at also moves on override saves).
      data_saved_at: dataAsOf,
      expires_at: expiresAt,
      updated_at: db.fn.now(),
    };
    // Upsert preserves verified_overrides — they are deliberately absent
    // from the merge payload.
    await db('property_lookups').insert(payload).onConflict('address_hash').merge(payload);
    logger.info('[lookup-cache] saved lookup', {
      county: payload.county,
      hasParcel: Boolean(record._parcel),
      ttlDays: cacheTtlDays(),
    });
  } catch (err) {
    logger.warn('[lookup-cache] write failed', { error: err.message });
  }
}

// Merge one or more verified field values into the row (creating an
// override-only stub row when the address was never cached). The merge is a
// single atomic JSONB `||` upsert — concurrent /verify requests for the same
// address each fold in their own fields without clobbering the other's.
// Returns the stored overrides map.
async function saveVerifiedOverride(address, fields, verifiedBy) {
  const now = new Date().toISOString();
  const additions = {};
  for (const [field, value] of Object.entries(fields || {})) {
    if (!VERIFIABLE_FIELDS.has(field)) continue;
    const sanitized = sanitizeVerifiedValue(field, value);
    if (sanitized === undefined) continue;
    additions[field] = { value: sanitized, verifiedBy: verifiedBy || null, verifiedAt: now };
  }
  if (!Object.keys(additions).length) return null;

  const { hash, normalizedAddress } = addressKey(address);
  await db('property_lookups')
    .insert({
      address_hash: hash,
      normalized_address: normalizedAddress,
      verified_overrides: JSON.stringify(additions),
      verified_by: verifiedBy || null,
      verified_at: db.fn.now(),
      // No cached data and nothing to expire — an override-only stub carries
      // the corrections until the next live lookup fills the row.
      expires_at: null,
    })
    .onConflict('address_hash')
    .merge({
      verified_overrides: db.raw('property_lookups.verified_overrides || excluded.verified_overrides'),
      verified_by: verifiedBy || null,
      verified_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

  const row = await db('property_lookups')
    .where({ address_hash: hash })
    .first('verified_overrides');
  logger.info('[lookup-cache] verified override saved', {
    fields: Object.keys(additions),
  });
  return row?.verified_overrides || additions;
}

// Surgically apply overrides to a merged property record: overwrite the
// field value and its _fieldEvidence entry so the UI shows "tech verified"
// winning and the field-verify nudge clears. Leaves all other evidence
// untouched (re-merging a merged record would flatten per-field provenance).
// The evidence carries a generic 'tech' provider — verifier identity stays in
// the DB row only, because enriched.fieldEvidence flows verbatim through the
// UNAUTHENTICATED public estimator response.
function applyVerifiedOverrides(record, overrides) {
  if (!record || !overrides) return record;
  const applied = [];
  for (const [field, entry] of Object.entries(overrides)) {
    if (!VERIFIABLE_FIELDS.has(field) || entry?.value === undefined) continue;
    const priorEvidence = record._fieldEvidence?.[field]?.evidence || [];
    record[field] = entry.value;
    record._fieldEvidence = record._fieldEvidence || {};
    record._fieldEvidence[field] = {
      value: entry.value,
      confidence: 'high',
      sourceType: 'verified',
      sourceLabel: 'tech verified',
      winningSource: null,
      winningProvider: 'tech',
      score: VERIFIED_SOURCE_WEIGHT,
      disagreement: false,
      fieldVerify: false,
      verifiedAt: entry.verifiedAt || null,
      evidence: [
        {
          field,
          value: entry.value,
          provider: 'tech',
          url: null,
          sourceType: 'verified',
          sourceQuality: VERIFIED_SOURCE_WEIGHT,
          confidence: 'high',
        },
        ...priorEvidence,
      ],
    };
    applied.push(field);
  }
  if (applied.length) {
    record._verifiedFields = applied;
    if (record._raw) record._raw._verifiedFields = applied;
    // The aggregate quality summary drives the weak-data banner
    // (buildFieldVerifyFlags reads _dataQuality.level / fieldVerifyCount) —
    // recompute it so verifying the flagged fields actually clears it.
    record._dataQuality = buildPropertyDataQuality(record._fieldEvidence, record._aiProviders || []);
    if (record._raw) record._raw._dataQuality = record._dataQuality;
  }
  return record;
}

module.exports = {
  addressKey,
  applyVerifiedOverrides,
  getCachedLookup,
  getVerifiedOverrides,
  isCacheDisabled,
  saveLookup,
  saveVerifiedOverride,
  VERIFIABLE_FIELDS,
  VERIFIED_SOURCE_WEIGHT,
};
