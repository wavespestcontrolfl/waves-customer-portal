/**
 * Estimator Engine — property-fact source arbitration.
 *
 * Resolves the property facts the pricing engine needs (home/building sqft,
 * lot sqft) from every sourceable signal, with EVIDENCE-WEIGHTED arbitration
 * rather than a blind fallback ladder. Two live-call traps drove this design
 * (2026-07-15 replay tests):
 *
 *   - Commercial TENANT: county GIS returns the WHOLE building ("Multiple
 *     Unit Stores", 14,250 sqft) while the caller's unit is ~1,590 — pricing
 *     the county number was a 2.26× overquote. Caller-stated unit size
 *     OUTRANKS county building sqft when the caller is a tenant.
 *   - NEW CONSTRUCTION: the county roll shows "Vacant Residential Platted" /
 *     0 living sqft for a house the caller lives in (assessment lag). The
 *     lot IS usually assessed; house sqft falls to the subdivision median of
 *     already-assessed neighbors (268 samples for the live test parcel).
 *
 * Every resolved fact carries { value, source, confidence, rejected[] } so
 * the draft's notes show WHY a number was chosen — that provenance is what
 * lets the operator verify a draft in seconds. Facts resolved from fallback
 * sources (subdivision median, lot-derived, none) force the YELLOW lane
 * downstream; this module never silently defaults.
 */

const logger = require('../logger');

const SQFT_SOURCES = {
  CALLER_STATED: 'caller_stated',
  COUNTY_ASSESSED: 'county_assessed',
  PROFILE: 'customer_profile',
  SUBDIVISION_MEDIAN: 'subdivision_median',
  LOOKUP_ESTIMATE: 'property_lookup_estimate',
  NONE: 'unresolved',
};

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Caller-stated sqft from the enriched extraction (approximate_living_sqft is
// set only when a size was actually spoken on the call).
function callerStatedSqft(extraction) {
  return positive(extraction?.property?.approximate_living_sqft);
}

function callerStatedLotAcres(extraction) {
  return positive(extraction?.property?.approximate_lot_size_acres);
}

function isTenant(extraction) {
  return String(extraction?.caller?.relationship_to_property || '').toLowerCase() === 'tenant';
}

// County vacant/unassessed detection off the parcel record the property
// lookup carries. Vacant land-use with no building record means the ANNUAL
// roll hasn't caught up — NOT that nothing is standing (vacant ≠ new
// construction; the caller's own words decide occupancy).
function countyLooksUnassessed(parcel) {
  if (!parcel) return false;
  // A normalized parcel view carries the #2749 detector's verdict directly.
  if (parcel.unassessedVacant === true) return true;
  const landUse = String(parcel.landUseDescription || '').toLowerCase();
  const noBuilding = !positive(parcel.livingAreaSqft);
  return noBuilding && (landUse.includes('vacant') || !parcel.yearBuilt);
}

/**
 * Resolve building/home sqft.
 *
 * @param {object} args
 *   extraction     — enriched call extraction (may be null)
 *   parcel         — propertyRecord._parcel from performPropertyLookup (may be null)
 *   lookupSqft     — propertyRecord.squareFootage (lookup's own best estimate)
 *   (customers.property_sqft is treated LAWN area — never a home-sqft source)
 *   isCommercial   — composer/extraction commercial signal
 *   subdivisionMedian — { medianSqft, sampleCount } | null (pre-fetched)
 */
function resolveHomeSqft({ extraction, parcel, lookupSqft, isCommercial, subdivisionMedian }) {
  const rejected = [];
  const stated = callerStatedSqft(extraction);
  const county = positive(parcel?.livingAreaSqft);
  const lookup = positive(lookupSqft);

  // Commercial tenant: the caller's unit size is the ONLY number that
  // describes the treated space — county/lookup sqft describe the building.
  if (isCommercial && isTenant(extraction)) {
    if (stated) {
      if (county) rejected.push({ value: county, source: SQFT_SOURCES.COUNTY_ASSESSED, reason: 'commercial tenant — county sqft covers the whole building, not the caller\'s unit' });
      return { value: stated, source: SQFT_SOURCES.CALLER_STATED, confidence: 'medium', rejected };
    }
    // Tenant with NO stated unit size: the county building is the WRONG
    // number by construction (multi-tenant plaza under the red-lane cap
    // would auto-price the whole parcel — the exact overquote class this
    // rule exists for). Unresolved → the engine's missing-footprint guard
    // keeps commercial pest a manual quote.
    if (county) rejected.push({ value: county, source: SQFT_SOURCES.COUNTY_ASSESSED, reason: 'commercial tenant with no stated unit size — county sqft covers the whole building' });
    return { value: null, source: SQFT_SOURCES.NONE, confidence: 'none', rejected };
  }

  // Commercial non-tenant with a stated size that wildly disagrees with the
  // county building: trust the caller (they described the treated space) but
  // keep the county number visible for review.
  if (isCommercial && stated && county && county > stated * 3) {
    rejected.push({ value: county, source: SQFT_SOURCES.COUNTY_ASSESSED, reason: 'county building is >3× the caller-described space — likely a multi-unit parcel' });
    return { value: stated, source: SQFT_SOURCES.CALLER_STATED, confidence: 'medium', rejected };
  }

  // County-assessed living area is the default authority when present.
  if (county) {
    if (stated && Math.abs(stated - county) / county > 0.35) {
      // Caller and county disagree hard — keep county, surface the dispute.
      rejected.push({ value: stated, source: SQFT_SOURCES.CALLER_STATED, reason: 'disagrees with the county-assessed living area by >35% — verify' });
      return { value: county, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'medium', rejected, disputed: true };
    }
    return { value: county, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected };
  }

  // No county building. Caller-stated is next when it exists.
  if (stated) {
    return { value: stated, source: SQFT_SOURCES.CALLER_STATED, confidence: 'medium', rejected };
  }
  // NOTE: customers.property_sqft is deliberately NOT a home-sqft source —
  // the schema defines it as TREATED LAWN AREA, not living area (it feeds
  // the engine as measuredTurfSf instead; see buildEngineInput).

  // New construction / unassessed parcel: median of already-assessed homes
  // in the same subdivision phase.
  if (countyLooksUnassessed(parcel) && positive(subdivisionMedian?.medianSqft)
      && (subdivisionMedian.sampleCount || 0) >= 8) {
    return {
      value: Math.round(subdivisionMedian.medianSqft),
      source: SQFT_SOURCES.SUBDIVISION_MEDIAN,
      confidence: 'low',
      sampleCount: subdivisionMedian.sampleCount,
      rejected,
    };
  }

  // Property lookup's own estimate (AI search / listing data) as last real source.
  if (lookup) {
    return { value: lookup, source: SQFT_SOURCES.LOOKUP_ESTIMATE, confidence: 'low', rejected };
  }

  return { value: null, source: SQFT_SOURCES.NONE, confidence: 'none', rejected };
}

/**
 * Resolve lot sqft. Lot is county-authoritative (assessed even on unbuilt
 * parcels); caller-stated acres are a sanity check, not an override.
 */
function resolveLotSqft({ extraction, parcel, lookupLotSqft, profileLotSqft }) {
  const rejected = [];
  const county = positive(parcel?.lotSqft) || positive(parcel?.polygonAreaSqft);
  const lookup = positive(lookupLotSqft);
  const profile = positive(profileLotSqft);
  const statedAcres = callerStatedLotAcres(extraction);
  const stated = statedAcres ? Math.round(statedAcres * 43560) : null;

  if (county) {
    if (stated && Math.abs(stated - county) / county > 0.5) {
      rejected.push({ value: stated, source: SQFT_SOURCES.CALLER_STATED, reason: 'caller-stated lot disagrees with the county parcel by >50% — verify' });
      return { value: county, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'medium', rejected, disputed: true };
    }
    return { value: county, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'high', rejected };
  }
  if (lookup) return { value: lookup, source: SQFT_SOURCES.LOOKUP_ESTIMATE, confidence: 'medium', rejected };
  if (profile) return { value: profile, source: SQFT_SOURCES.PROFILE, confidence: 'medium', rejected };
  if (stated) return { value: stated, source: SQFT_SOURCES.CALLER_STATED, confidence: 'low', rejected };
  return { value: null, source: SQFT_SOURCES.NONE, confidence: 'none', rejected };
}

// Display/extraction property labels → the keys the pricing engine's pest
// normalizer accepts. Anything unrecognized passes through unchanged (the
// engine flags-and-defaults it rather than crashing).
function pricingSafePropertyType(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return null;
  if (/interior/.test(s) && /town/.test(s)) return 'townhome_interior';
  if (/town/.test(s)) return 'townhome_end';
  if (/condo/.test(s) && /upper/.test(s)) return 'condo_upper';
  if (/condo/.test(s)) return 'condo_ground';
  if (/duplex/.test(s)) return 'duplex';
  if (/single|family|house|home\b/.test(s) && !/mobile|town/.test(s)) return 'single_family';
  return String(value);
}

// Sources that mean "we measured nothing real" — downstream lane logic
// treats any of these as an automatic yellow (or red when unresolved).
const FALLBACK_SQFT_SOURCES = new Set([
  SQFT_SOURCES.SUBDIVISION_MEDIAN,
  SQFT_SOURCES.LOOKUP_ESTIMATE,
  SQFT_SOURCES.NONE,
]);

/**
 * Normalize the property-lookup record into the parcel view arbitration
 * consumes. The raw `_parcel` meta deliberately carries only merge-surviving
 * fields — subdivision lives on `_raw`, building sqft on the merged record —
 * and the vacant/new-construction read has its own merge quirks that
 * detectUnassessedVacantParcel (the #2749 lane) already handles. Reuse it
 * rather than re-deriving.
 */
// squareFootage provenance off the lookup's field-evidence trail. County and
// tech-VERIFIED overrides both count as authoritative (a saved field-verify
// correction supersedes the stale county roll); missing evidence (legacy
// cached rows) counts as county when the parcel matched — the pre-evidence
// behavior. Explicit AI/listing evidence downgrades.
function sqftEvidenceIsCounty(propertyRecord) {
  const evidence = propertyRecord?._fieldEvidence?.squareFootage;
  if (!evidence) return true;
  return evidence.sourceType === 'county' || evidence.sourceType === 'verified';
}

function normalizeParcelView(propertyRecord) {
  if (!propertyRecord) return null;
  const parcel = propertyRecord._parcel || {};
  let vacantEvidence = null;
  let countyBacked = !!(parcel.parcelId || parcel.paoParcelId);
  try {
    const { detectUnassessedVacantParcel, hasCountyEvidence } = require('../property-lookup/ai-property-lookup');
    vacantEvidence = detectUnassessedVacantParcel(propertyRecord);
    countyBacked = hasCountyEvidence(propertyRecord);
  } catch (err) {
    logger.warn(`[estimator-engine] vacant-parcel detection unavailable: ${err.message}`);
  }
  return {
    county: parcel.county || null,
    parcelId: parcel.paoParcelId || parcel.parcelId || null,
    lotSqft: positive(parcel.lotSqft) || positive(parcel.polygonAreaSqft),
    // County-backed building sqft: the stacked-parcel aggregate carries its
    // own living area on _parcel; otherwise the merged record's squareFootage
    // counts only when the field-evidence trail says it actually CAME from a
    // county source — a hybrid lookup can match the parcel while the building
    // sqft is AI/listing evidence, which must stay a lookup-estimate. Legacy
    // cached rows without field evidence keep the parcel-matched behavior.
    livingAreaSqft: (!vacantEvidence && countyBacked)
      // A tech-VERIFIED override supersedes everything — including the
      // aggregate parcel figure, which stays the stale county value after a
      // field-verify correction.
      ? ((propertyRecord._fieldEvidence?.squareFootage?.sourceType === 'verified'
        ? positive(propertyRecord.squareFootage) : null)
        || positive(parcel.livingAreaSqft)
        || (sqftEvidenceIsCounty(propertyRecord) ? positive(propertyRecord.squareFootage) : null))
      : null,
    landUseDescription: vacantEvidence?.landUseDescription
      || parcel.landUseDescription
      || propertyRecord._raw?.landUseDescription
      || propertyRecord._raw?.landUse
      || null,
    subdivision: vacantEvidence?.subdivision || parcel.subdivision || propertyRecord._raw?.subdivision || null,
    yearBuilt: positive(propertyRecord.yearBuilt),
    unassessedVacant: !!vacantEvidence,
    countyBacked,
  };
}

/**
 * Full arbitration pass: resolve home + lot facts and the new-construction /
 * dispute markers the lane classifier consumes. Accepts an optional
 * pre-normalized `parcelView` (index.js builds one so the subdivision-median
 * dig and arbitration read the same view).
 */
function resolvePropertyFacts({ extraction, propertyRecord, customer, isCommercial, subdivisionMedian, parcelView }) {
  const parcel = parcelView || normalizeParcelView(propertyRecord);
  const home = resolveHomeSqft({
    extraction,
    parcel,
    // The merged record's own sqft only counts as a soft lookup estimate when
    // it is NOT county-backed (county-backed sqft is already livingAreaSqft).
    lookupSqft: parcel?.livingAreaSqft ? null : propertyRecord?.squareFootage,
    isCommercial,
    subdivisionMedian,
  });
  const lot = resolveLotSqft({
    extraction,
    parcel,
    // The normalized lookup record carries listing/AI lot size as `lotSize`;
    // the other spellings cover older cached shapes.
    lookupLotSqft: propertyRecord?.lotSize || propertyRecord?.lotSizeSqFt || propertyRecord?.lotSqft,
    profileLotSqft: customer?.lot_sqft,
  });

  const newConstruction = countyLooksUnassessed(parcel)
    && (home.source !== SQFT_SOURCES.COUNTY_ASSESSED);

  // Residential property type for the pricing engine: the lookup's merged
  // record first (county land-use aware), then the call extraction. A condo
  // or townhome priced as a detached home gets the wrong pest adjustment and
  // hardscape/turf math. Emitted as the PRICING-SAFE keys the pest
  // normalizer's alias table actually recognizes (normalizePestPropertyType
  // has no bare condo/townhome entries — display labels silently default to
  // single_family). Unknown floor/position falls to the conservative
  // condo_ground / townhome_end defaults the general normalizer also uses.
  const propertyType = pricingSafePropertyType(
    propertyRecord?.propertyType || extraction?.property?.property_type,
  );

  if (home.source === SQFT_SOURCES.SUBDIVISION_MEDIAN) {
    logger.info('[estimator-engine] home sqft resolved from subdivision median', {
      sampleCount: home.sampleCount || 0,
    });
  }

  return {
    home,
    lot,
    newConstruction,
    propertyType,
    // Lookup-resolved story count — calculatePropertyProfile derives
    // footprint/perimeter/turf from homeSqFt ÷ stories, so flattening a
    // two-story house to 1 story doubles its assumed ground footprint.
    stories: positive(propertyRecord?.stories) || null,
    tenant: isTenant(extraction),
    countyParcel: parcel ? {
      county: parcel.county || null,
      parcelId: parcel.parcelId || parcel.paoParcelId || null,
      landUseDescription: parcel.landUseDescription || null,
      subdivision: parcel.subdivision || null,
      yearBuilt: parcel.yearBuilt || null,
      livingAreaSqft: positive(parcel.livingAreaSqft),
      lotSqft: positive(parcel.lotSqft),
    } : null,
  };
}

module.exports = {
  SQFT_SOURCES,
  FALLBACK_SQFT_SOURCES,
  resolvePropertyFacts,
  normalizeParcelView,
  _private: {
    resolveHomeSqft,
    resolveLotSqft,
    countyLooksUnassessed,
    callerStatedSqft,
    isTenant,
    pricingSafePropertyType,
  },
};
