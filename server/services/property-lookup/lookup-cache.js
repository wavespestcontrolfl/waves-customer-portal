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

// Cached lookup data — null when the cache is disabled, the row is missing,
// the data slot is empty (override-only stub row), or the row expired.
async function getCachedLookup(address) {
  if (isCacheDisabled()) return null;
  try {
    const { hash } = addressKey(address);
    const row = await db('property_lookups').where({ address_hash: hash }).first();
    if (!row || !row.property_record) return null;
    if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
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
  try {
    const { hash, normalizedAddress } = addressKey(address);
    const record = result.propertyRecord;
    const expiresAt = new Date(Date.now() + cacheTtlDays() * 24 * 60 * 60 * 1000);
    const payload = {
      address_hash: hash,
      normalized_address: normalizedAddress,
      parcel_id: record._parcel?.parcelId || null,
      county: record.county || record._parcel?.county || null,
      lat: Number.isFinite(result.satellite?.lat) ? result.satellite.lat : null,
      lng: Number.isFinite(result.satellite?.lng) ? result.satellite.lng : null,
      property_record: JSON.stringify(record),
      ai_analysis: result.aiAnalysis ? JSON.stringify(result.aiAnalysis) : null,
      parcel: record._parcel ? JSON.stringify(record._parcel) : null,
      providers: JSON.stringify(record._aiProviders || []),
      enriched_snapshot: result.enriched ? JSON.stringify(result.enriched) : null,
      lookup_ms: Number.isFinite(result.meta?.lookupMs) ? result.meta.lookupMs : null,
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
// override-only stub row when the address was never cached). Returns the
// stored overrides map.
async function saveVerifiedOverride(address, fields, verifiedBy) {
  const entries = Object.entries(fields || {})
    .filter(([field, value]) => VERIFIABLE_FIELDS.has(field) && value !== undefined && value !== null && value !== '');
  if (!entries.length) return null;

  const { hash, normalizedAddress } = addressKey(address);
  const now = new Date().toISOString();
  const additions = {};
  for (const [field, value] of entries) {
    additions[field] = { value, verifiedBy: verifiedBy || null, verifiedAt: now };
  }

  const existing = await db('property_lookups')
    .where({ address_hash: hash })
    .first('id', 'verified_overrides');
  const merged = { ...(existing?.verified_overrides || {}), ...additions };

  if (existing) {
    await db('property_lookups').where({ id: existing.id }).update({
      verified_overrides: JSON.stringify(merged),
      verified_by: verifiedBy || null,
      verified_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
  } else {
    await db('property_lookups').insert({
      address_hash: hash,
      normalized_address: normalizedAddress,
      verified_overrides: JSON.stringify(merged),
      verified_by: verifiedBy || null,
      verified_at: db.fn.now(),
      // No cached data and nothing to expire — the stub exists purely to
      // carry the overrides until the next live lookup fills the row.
      expires_at: null,
    });
  }
  logger.info('[lookup-cache] verified override saved', {
    fields: entries.map(([field]) => field),
  });
  return merged;
}

// Surgically apply overrides to a merged property record: overwrite the
// field value and its _fieldEvidence entry so the UI shows "tech verified"
// winning and the field-verify nudge clears. Leaves all other evidence
// untouched (re-merging a merged record would flatten per-field provenance).
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
      winningProvider: entry.verifiedBy || 'tech',
      score: VERIFIED_SOURCE_WEIGHT,
      disagreement: false,
      fieldVerify: false,
      verifiedAt: entry.verifiedAt || null,
      evidence: [
        {
          field,
          value: entry.value,
          provider: entry.verifiedBy || 'tech',
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
