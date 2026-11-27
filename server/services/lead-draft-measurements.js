'use strict';

// Real home and lot size for website lead drafts (owner 2026-10-24, option A
// of the lead draft page). The website forms collect no size, so a lead draft
// is priced on the default home (2,000 sq ft) and lot (8,000 sq ft) and
// flagged `property_measurements_defaulted`. This module gives it the county-
// assessed sizes instead, in two steps:
//
//   1. When the draft is built, a free cache-only read of the property lookup
//      (cachedLeadMeasurements). Only about 1 lead in 15 has a cached lookup
//      at that moment (production, 10-24).
//   2. For a draft still on the default, one live lookup in the background
//      after the lead is saved (scheduleLeadDraftPropertyLookup): a full
//      lookup takes about 10 s, up to a minute, so it never runs inside the
//      webhook's request or its phone-lock transaction. It then re-prices
//      the draft through the caller's own builder, only while the row is
//      exactly as it was created: never written since (updated_at =
//      created_at) and the same whole-row witness (estimateEditVersion)
//      before and after the lookup. A staff member with the draft open is
//      protected by the send and save checks on that same witness. The AI
//      triage rebuild of the same draft (lead-webhook.js) waits for this
//      lookup's sizes (pendingLeadMeasurements) and prices with them, so a
//      triage write that lands first never discards them.
//
// Only a county-assessed home AND lot for a single-family home at an address
// with no unit line, inside residential ranges, and only when the lookup did
// not snap to a different house; anything else keeps the default and the
// flag for staff. Imputed sizes are never written to the customer or the
// property row: they stay on the draft's engine input, with provenance.
// Dark behind GATE_LEAD_DRAFT_PROPERTY_LOOKUP (read at call time). Logs carry
// ids and outcomes only, never an address.

const db = require('../models/db');
const logger = require('./logger');
const { leadDraftPropertyLookupLive, isEnabled } = require('../config/feature-gates');
const { lookupOptionsFor } = require('./property-lookup/lookup-callers');
const { resolvePropertyFacts, SQFT_SOURCES } = require('./estimator-engine/source-arbitration');
const {
  hasWrongPremiseFlag,
  hasGlobalVerifyFlag,
  lookupDimensionIsTrustworthy,
  lookupFeaturesAreTrustworthy,
  lookupLawnAreaIsTheOnlyFeatureDoubt,
  lookupDisputedPhotoFields,
  lookupTurfEstimateIsTrustworthy,
  lookupTurfZeroIsObserved,
  recordPropertyTypeIsTrustworthy,
  lookupPropertyTypeIsTrustworthy,
  poolFeaturesAreRecordBacked,
  poolCageIsRecordBacked,
} = require('./lookup-confidence');
const { fourSizeOf, twoSizeOf, isHeldFourSize } = require('./property-lookup/cage-sizes');
const { unitAnywhereOnLine } = require('../utils/address-normalizer');

const MEASUREMENTS_SOURCE = 'county_assessed';
const DEFAULTED_REVIEW = 'property_measurements_defaulted';
const FROM_COUNTY_REVIEW = 'property_measurements_from_county';
// Residential bounds: a county figure outside them (a whole condo building,
// a farm parcel) is not a house to price from a lead form.
const HOME_SQFT_RANGE = [400, 10000];
const LOT_SQFT_RANGE = [1000, 435600];
const REPRICE_STATUSES = new Set(['generated', 'manual_review_required']);
// The lookup record's own type label for a detached home (the county
// mapper's 'Single Family'). Checked on the raw label, not on the pricing
// normalizer's key: that maps any label with "family" in it, a county
// 'Multifamily' triplex or apartment building included, to single_family
// (codex P2 on #6666).
const SINGLE_FAMILY_LABEL = /^single[\s_-]*family$/i;
// The triage rebuild's longest wait for an in-flight lookup (a lookup runs
// about 10 s, 71 s at p90); past it the rebuild reads the cache as before.
const PENDING_WAIT_MS = 3 * 60 * 1000;

// In-flight background lookups by estimate id: a promise of the county
// sizes the lookup proved, or null when it proved none.
const pendingMeasurements = new Map();

const inRange = (value, [low, high]) => Number.isFinite(value) && value >= low && value <= high;

// Only carry propertyType into lead drafts when the field itself has authoritative county/assessor/cadastral/verified
// provenance and no propertyType verify flag on the lookup (satellite/listing-only guesses stay unverified).
const TRUSTED_PROPERTY_TYPE_SOURCES = new Set(['county', 'assessor', 'cadastral', 'verified']);
function trustedCountyPropertyType(propertyRecord, enriched) {
  const raw = String(propertyRecord?.propertyType || '').trim();
  if (!SINGLE_FAMILY_LABEL.test(raw)) return null;
  if (!recordPropertyTypeIsTrustworthy(propertyRecord)) return null;
  if (enriched && !lookupPropertyTypeIsTrustworthy({ ...enriched, propertyType: raw })) return null;
  const ev = propertyRecord._fieldEvidence?.propertyType;
  if (ev) {
    const src = String(ev.sourceType || '').trim().toLowerCase();
    if (!TRUSTED_PROPERTY_TYPE_SOURCES.has(src) || ev.fieldVerify === true) return null;
    return raw;
  }
  if (propertyRecord._propertyTypeSource != null) {
    const directSource = String(propertyRecord._propertyTypeSource).trim().toLowerCase();
    return TRUSTED_PROPERTY_TYPE_SOURCES.has(directSource) ? raw : null;
  }
  const recordSource = String(propertyRecord._source || '').trim().toLowerCase();
  return TRUSTED_PROPERTY_TYPE_SOURCES.has(recordSource) ? raw : null;
}

// An address the lookup can describe as one house: a street number and no
// unit in any position ("Apt 4", "#4", "Unit B", "Bldg 9", unit-first).
function wholeHomeAddress(address) {
  if (typeof address !== 'string' || !/\d/.test(address)) return false;
  return !unitAnywhereOnLine(address);
}

function normalizedPhotoWord(value, allowed) {
  const word = String(value || '').trim().toLowerCase();
  return allowed.includes(word) ? word : null;
}

function trustedCountyPoolCageFeatures(enriched, featuresTrusted) {
  const up = (value) => String(value ?? '').trim().toUpperCase();
  const cageRecordBacked = poolCageIsRecordBacked(enriched);
  const poolRecordBacked = poolFeaturesAreRecordBacked(enriched);
  const poolCage = cageRecordBacked || (featuresTrusted && up(enriched.poolCage) === 'YES');
  const pool = (poolRecordBacked && up(enriched.pool) === 'YES')
    || poolCage
    || (featuresTrusted && up(enriched.pool) === 'YES');
  const out = {};
  if (pool) out.pool = true;
  if (poolCage) {
    out.poolCage = true;
    const twoSizesOn = require('../config/feature-gates').cageTwoSizesLive?.() === true;
    const four = fourSizeOf(enriched);
    const two = twoSizeOf(enriched);
    const size = twoSizesOn ? two : four;
    if (size) out.poolCageSize = size.toLowerCase();
    if (twoSizesOn && isHeldFourSize(four)) out.poolCageReview = true;
    if (cageRecordBacked) out.poolCageSqft = Math.round(Number(enriched.poolCageSqft));
  }
  return out;
}

function isPhotoFactTrusted(disputed, obs, field) {
  return !disputed.has(field) && (!obs || obs[field] !== false);
}

const PEST_PHOTO_FACT_READS = [
  ['shrubs', 'shrubDensity', { LIGHT: 'light', MODERATE: 'moderate', HEAVY: 'heavy' }],
  ['complexity', 'landscapeComplexity', { SIMPLE: 'simple', MODERATE: 'moderate', COMPLEX: 'complex' }],
  ['nearWater', 'nearWater', { YES: true, NO: false, NONE: false }],
];

function trustedSharedPhotoFacts(enriched, aiAnalysis, featuresTrusted) {
  if (!featuresTrusted) return {};
  const obs = enriched._observed && typeof enriched._observed === 'object' ? enriched._observed : null;
  const disputed = lookupDisputedPhotoFields(aiAnalysis);
  const out = {};
  if (isPhotoFactTrusted(disputed, obs, 'shrubDensity')) {
    const shrubs = normalizedPhotoWord(enriched.shrubDensity, ['light', 'moderate', 'heavy']);
    if (shrubs) out.shrubs = shrubs;
  }
  if (isPhotoFactTrusted(disputed, obs, 'landscapeComplexity')) {
    const complexity = normalizedPhotoWord(enriched.landscapeComplexity, ['simple', 'moderate', 'complex']);
    if (complexity) out.complexity = complexity;
  }
  if (isPhotoFactTrusted(disputed, obs, 'nearWater')) {
    const water = String(enriched.nearWater ?? '').trim().toUpperCase();
    if (water && !['NONE', 'NO', 'FALSE', 'UNKNOWN'].includes(water)) out.nearWater = true;
  }
  return out;
}

// Mirrors customer-pricing-ai.js pestPhotoFactsFor: when lawn area is the ONLY
// feature doubt, carry explicitly observed, non-disputed photo facts ONLY via
// `pestPhotoFacts` (never shared features) so non-pest lines keep strict gating.
function trustedCountyPestPhotoFacts(lookup) {
  const enriched = lookup?.enriched;
  if (!enriched || typeof enriched !== 'object' || hasGlobalVerifyFlag(enriched)) return null;
  if (lookupFeaturesAreTrustworthy(enriched)) return null;
  if (require('../config/feature-gates').pestPricePhotoFactsLive?.() !== true) return null;
  if (!lookupLawnAreaIsTheOnlyFeatureDoubt(enriched)) return null;
  const observed = enriched._observed;
  const aiAnalysis = lookup?.aiAnalysis;
  if (!observed || typeof observed !== 'object' || !aiAnalysis || typeof aiAnalysis !== 'object') return null;
  const disputed = lookupDisputedPhotoFields(aiAnalysis);
  const facts = {};
  for (const [fact, field, known] of PEST_PHOTO_FACT_READS) {
    const word = String(enriched[field] ?? '').trim().toUpperCase();
    if (Object.hasOwn(known, word) && observed[field] === true && !disputed.has(field)) facts[fact] = known[word];
  }
  return Object.keys(facts).length ? facts : null;
}

function trustedCountyFeatures(lookup) {
  const enriched = lookup?.enriched;
  if (!enriched || typeof enriched !== 'object' || hasGlobalVerifyFlag(enriched)) return null;
  const featuresTrusted = lookupFeaturesAreTrustworthy(enriched);
  const out = {
    ...trustedCountyPoolCageFeatures(enriched, featuresTrusted),
    ...trustedSharedPhotoFacts(enriched, lookup?.aiAnalysis, featuresTrusted),
    ...(enriched.hasAttachedGarage === true ? { attachedGarage: true } : {}),
  };
  return Object.keys(out).length ? out : null;
}

function trustedCountyTurf(enriched) {
  if (!enriched || typeof enriched !== 'object' || hasGlobalVerifyFlag(enriched)) return null;
  if (String(enriched.turfObservation || '').trim().toLowerCase() === 'unobservable') return null;
  if (lookupTurfZeroIsObserved(enriched)) {
    return {
      estimatedTurfSf: 0,
      turfSource: enriched.turfSource || null,
      turfCappedToParcel: false,
      turfKnownZero: true,
    };
  }
  if (!lookupTurfEstimateIsTrustworthy(enriched)) return null;
  return {
    estimatedTurfSf: Math.round(Number(enriched.estimatedTurfSf)),
    turfSource: enriched.turfSource || null,
    turfCappedToParcel: enriched.turfCappedToParcel === true,
  };
}

function trustedCountyStories(propertyRecord, facts, enriched) {
  const { storiesSourceForPricing, storyCountHasEvidence } = require('./estimator-engine/draft-builder');
  const { statedStoryCount } = require('./voice-agent/story-count');
  const storiesVerified = propertyRecord._storiesSource === 'verified';
  const storiesKnown = (storiesVerified || (storiesSourceForPricing(facts) === 'lookup' && storyCountHasEvidence(propertyRecord)))
    && lookupDimensionIsTrustworthy(enriched, 'stories');
  return storiesKnown ? statedStoryCount(propertyRecord.stories) : null;
}

// The county-assessed home and lot size a lookup result proves for a single-
// family home, or null. Same arbitration as the estimator engine
// (resolvePropertyFacts), held to its county-assessed source only.
function countyMeasurements(lookup) {
  const propertyRecord = lookup?.propertyRecord;
  if (!propertyRecord) return null;
  // The geocoder snapped to a different premise: the county figures describe
  // another parcel (estimator-engine parcelSignalsDescribeGatheredAddress).
  if (hasWrongPremiseFlag(lookup.enriched) || propertyRecord._addressAudit?.snappedRecord) return null;
  if (!SINGLE_FAMILY_LABEL.test(String(propertyRecord.propertyType || '').trim())) return null;
  const facts = resolvePropertyFacts({ extraction: null, propertyRecord, customer: null, isCommercial: false });
  if (facts.newConstruction) return null;
  if ([facts.home, facts.lot].some((f) => f?.source !== SQFT_SOURCES.COUNTY_ASSESSED)) return null;
  const homeSqFt = Math.round(Number(facts.home.value));
  const lotSqFt = Math.round(Number(facts.lot.value));
  if (!inRange(homeSqFt, HOME_SQFT_RANGE) || !inRange(lotSqFt, LOT_SQFT_RANGE)) return null;
  const stories = trustedCountyStories(propertyRecord, facts, lookup.enriched);
  const propertyType = trustedCountyPropertyType(propertyRecord, lookup.enriched);
  const features = trustedCountyFeatures(lookup);
  const pestPhotoFacts = trustedCountyPestPhotoFacts(lookup);
  const turf = trustedCountyTurf(lookup.enriched);
  return {
    homeSqFt,
    lotSqFt,
    ...(stories ? { stories } : {}),
    ...(propertyType ? { propertyType } : {}),
    ...(features ? { features } : {}),
    ...(pestPhotoFacts ? { pestPhotoFacts } : {}),
    ...(turf ? { turf } : {}),
    source: MEASUREMENTS_SOURCE,
  };
}

// The draft builder's read: cache only, never spends, never throws.
async function cachedLeadMeasurements(address) {
  if (!leadDraftPropertyLookupLive() || !wholeHomeAddress(address)) return null;
  try {
    const { performPropertyLookup } = require('../routes/property-lookup-v2');
    const lookup = await performPropertyLookup(address, lookupOptionsFor('lead_draft', { cacheOnly: true, persist: false }));
    return countyMeasurements(lookup);
  } catch (err) {
    logger.warn(`[lead-draft-measurements] cache read failed (${err.code || err.name || 'error'})`);
    return null;
  }
}

function parsedData(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

// A lead draft the automation priced on the default size (the lead gave no
// home or lot size) that nobody has written since: the only row the
// background step may re-price.
function untouchedDefaultedDraft(row) {
  if (!row || row.source !== 'lead_webhook' || row.status !== 'draft') return false;
  if (row.archived_at || row.sent_at || row.price_locked_at) return false;
  if (!row.created_at || !row.updated_at || new Date(row.updated_at).getTime() !== new Date(row.created_at).getTime()) return false;
  const draft = parsedData(row.estimate_data)?.automation?.draftEstimateAutomation;
  return !!draft && draft.source === 'lead_webhook_automation' && REPRICE_STATUSES.has(draft.status)
    && draft.sizeSource === 'default';
}

/**
 * The background step. `rebuild(measurements)` is the caller's own draft
 * builder bound to the lead's inputs; it returns the builder's result.
 * Resolves { skipped } or { outcome }: repriced | no_trusted_size | changed |
 * not_rebuilt | lookup_failed. A database error rejects (the scheduler
 * logs it); the draft then stays as it was.
 */
async function runLeadDraftPropertyLookup({ estimateId, address, rebuild, conn = db, onMeasurements = () => {} }) {
  if (!leadDraftPropertyLookupLive() || !isEnabled('leadEstimateAutomation')) return { skipped: 'disabled' };
  if (!estimateId || typeof rebuild !== 'function' || !wholeHomeAddress(address)) return { skipped: 'not_eligible' };
  const { estimateEditVersion } = require('./admin-estimate-persistence');
  const before = await conn('estimates').where({ id: estimateId }).first();
  if (!untouchedDefaultedDraft(before)) return { skipped: 'not_eligible' };
  const witness = estimateEditVersion(before);

  let lookup;
  try {
    const { performPropertyLookup } = require('../routes/property-lookup-v2');
    lookup = await performPropertyLookup(address, lookupOptionsFor('lead_draft'));
  } catch (err) {
    logger.warn(`[lead-draft-measurements] lookup failed for estimate ${estimateId} (${err.code || err.name || 'error'})`);
    return { outcome: 'lookup_failed' };
  }
  const measurements = countyMeasurements(lookup);
  onMeasurements(measurements);
  if (!measurements) return { outcome: 'no_trusted_size' };

  // Priced before the row lock: the builder reads only the lead's in-memory
  // inputs and the catalog, and the witness below proves the row is still
  // the one those inputs priced.
  const draft = await rebuild(measurements);
  const status = draft?.automation?.status;
  if (!draft?.estimateData || !REPRICE_STATUSES.has(status)
      || draft.automation.sizeSource !== MEASUREMENTS_SOURCE) return { outcome: 'not_rebuilt' };

  return conn.transaction(async (trx) => {
    const row = await trx('estimates').where({ id: estimateId }).forUpdate().first();
    if (!untouchedDefaultedDraft(row) || estimateEditVersion(row) !== witness) return { outcome: 'changed' };
    await trx('estimates').where({ id: estimateId }).update({
      monthly_total: draft.monthly || null,
      annual_total: draft.annual || null,
      onetime_total: draft.oneTimeTotal || null,
      // Same stamp as the webhook's insert: an engine-generated price is
      // SERVER, a parked draft stays unstamped (the auto-send lane fails
      // closed on anything but SERVER).
      pricing_authority: status === 'generated' ? 'SERVER' : null,
      estimate_data: JSON.stringify(draft.estimateData),
      updated_at: trx.fn.now(),
    });
    return { outcome: 'repriced' };
  });
}

// Fire-and-forget from the lead webhook: the website's answer never waits on
// the lookup, and a failure only leaves the draft flagged, as before. The
// pending entry is set before this returns, so the triage rebuild the
// webhook starts after it always finds it. Returns a promise that settles
// (never rejects) when the step is done; the webhook does not wait on it.
function scheduleLeadDraftPropertyLookup(args) {
  if (!leadDraftPropertyLookupLive()) return Promise.resolve();
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  pendingMeasurements.set(args.estimateId, pending);
  return new Promise((done) => {
    setImmediate(() => {
      runLeadDraftPropertyLookup({ ...args, onMeasurements: settle })
        .then((result) => logger.info(`[lead-draft-measurements] estimate ${args.estimateId}: ${result.outcome || result.skipped}`))
        .catch((err) => logger.warn(`[lead-draft-measurements] estimate ${args.estimateId} failed (${err.code || err.name || 'error'})`))
        .finally(() => {
          settle(null);
          if (pendingMeasurements.get(args.estimateId) === pending) pendingMeasurements.delete(args.estimateId);
          done();
        });
    });
  });
}

// For a rebuild of the same draft (the webhook's AI triage): the sizes an
// in-flight lookup proves (null = none), waited for up to PENDING_WAIT_MS.
// undefined when no lookup is in flight or the wait ran out: the builder
// then reads the cache itself, as for any other build.
async function pendingLeadMeasurements(estimateId, { waitMs = PENDING_WAIT_MS } = {}) {
  const pending = estimateId ? pendingMeasurements.get(estimateId) : null;
  if (!pending) return undefined;
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); });
  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  cachedLeadMeasurements,
  pendingLeadMeasurements,
  runLeadDraftPropertyLookup,
  scheduleLeadDraftPropertyLookup,
  MEASUREMENTS_SOURCE,
  DEFAULTED_REVIEW,
  FROM_COUNTY_REVIEW,
  _private: { countyMeasurements, wholeHomeAddress, untouchedDefaultedDraft },
};
