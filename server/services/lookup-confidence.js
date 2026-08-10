/**
 * Trust predicates for property-lookup-derived pricing inputs.
 *
 * The lookup returns measurements and feature reads off satellite imagery
 * plus county records, and it grades its own work: `aiConfidence` (the same
 * score property-lookup-v2's reviewer copy renders as "AI confidence NN%")
 * and `fieldVerifyFlags` naming the specific reads that need human
 * verification.
 *
 * Pricers do NOT carry that grade. priceTreeShrub, for instance, upgrades
 * any `estimatedBedAreaSf` to pricingConfidence 'medium' with no review
 * reason, and the pest feature modifiers price a pool cage the moment one is
 * reported. So a read the lookup itself doubted becomes an exact,
 * unreviewed price unless the consumer checks the grade first — which is
 * what these predicates are for.
 *
 * Shared so the rule has ONE definition: the agent draft path and the
 * customer-facing pricing assistant must not drift apart on what "confident
 * enough to price" means.
 */

// Below this the lookup's own copy calls the read low-confidence.
const LOOKUP_AI_CONFIDENCE_FLOOR = 60;

function confidenceScore(enriched) {
  const n = Number(enriched?.aiConfidence ?? enriched?.confidenceScore);
  return Number.isFinite(n) ? n : null;
}

// For inputs ALREADY in use, an absent score is not evidence of doubt —
// legacy payloads carried none, and treating them as untrustworthy would
// silently stop pricing inputs that have always been used.
//
// For a NEWLY consumed input the burden flips: nothing depended on it
// before, so requiring a real score costs nothing and refuses to invent
// trust the lookup never expressed. Callers introducing a consumption pass
// requireExplicitScore.
function lookupConfidenceIsAdequate(enriched, { requireExplicitScore = false } = {}) {
  const score = confidenceScore(enriched);
  if (score === null) return !requireExplicitScore;
  return score >= LOOKUP_AI_CONFIDENCE_FLOOR;
}

// Flags whose scope is the WHOLE lookup, not one field: 'address' (the
// geocoder snapped to a different premise — every read may describe the
// wrong parcel) and 'all' (no property record; every dimension is
// estimated). These disqualify every derived pricing input, so a
// field-name match is not enough on its own.
const GLOBAL_VERIFY_FIELDS = new Set(['address', 'all']);

function hasGlobalVerifyFlag(enriched) {
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  return flags.some((flag) => GLOBAL_VERIFY_FIELDS.has(String(flag?.field || '').trim().toLowerCase()));
}

function hasVerifyFlagMatching(enriched, matcher) {
  if (hasGlobalVerifyFlag(enriched)) return true;
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  return flags.some((flag) => matcher(String(flag?.field || '').toLowerCase()));
}

// A bed area is trustworthy when the lookup neither graded itself low nor
// flagged the bed-area read — or the turf/imagery read it came from, since
// that is the same picture.
// Bed area is a NEW consumption (nothing priced off it before this lane), so
// it fails closed on a missing score: an unscored area would otherwise
// become a medium-confidence T&S price with no review reason. A quote
// without it simply falls back to the lot inference, which carries its own
// review markers.
function lookupBedAreaIsTrustworthy(enriched) {
  const area = Number(enriched?.estimatedBedAreaSf);
  if (!Number.isFinite(area) || area <= 0) return false;
  // FIELD-level confidence, not the blended average: the merge gap-fills
  // estimatedBedAreaSf from a lone low-confidence provider while other
  // providers' high scores hold the average above the floor, and bed area
  // is not divergence-tracked so no flag fires. mergeAiAnalyses stamps the
  // max confidence among the providers that reported the WINNING value
  // (surfaced as bedAreaConfidence). A missing stamp — legacy cached
  // payloads merged before the stamp existed — fails closed like a missing
  // score: bed area is a NEW consumption, and the quote falls back to the
  // lot inference, which carries its own review markers.
  const fieldConfidence = Number(enriched?.bedAreaConfidence ?? enriched?._bedAreaConfidence);
  if (!Number.isFinite(fieldConfidence) || fieldConfidence < LOOKUP_AI_CONFIDENCE_FLOOR) return false;
  if (!lookupConfidenceIsAdequate(enriched, { requireExplicitScore: true })) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('bedarea') || field.includes('bed_area') || field.includes('estimatedturf')
  ));
}

// Trust of the turf READ itself, value-agnostic: adequate confidence and no
// turf/lawn verify flag. (Existing consumption, so an absent score stays
// adequate — legacy payloads carried none.)
function lookupTurfReadIsTrustworthy(enriched) {
  if (!enriched) return false;
  if (!lookupConfidenceIsAdequate(enriched)) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('turf') || field.includes('lawn')
  ));
}

// The satellite turf estimate is a vision read like the bed area — same
// imagery, same self-grading. A low-confidence or turf-flagged read may not
// satisfy the lawn measurement and become an exact self-service price; the
// caller adopts nothing and the request fails closed to
// PROPERTY_DETAILS_NEEDED when no other turf source exists.
function lookupTurfEstimateIsTrustworthy(enriched) {
  const turf = Number(enriched?.estimatedTurfSf);
  if (!Number.isFinite(turf) || turf <= 0) return false;
  return lookupTurfReadIsTrustworthy(enriched);
}

// A trusted vision ZERO is a measurement too — an observed no-lawn
// property. The lookup distinguishes it explicitly: turfSource 'vision'
// covers a measured 0, while its synthetic no-basis zero ships as
// turfSource 'none' (and the stale-imagery guard deletes bogus zeros
// before they get here). Without this, a no-lawn property with a lot on
// file would fall through to the lot-based turf inference and receive a
// lawn quote for a lawn the imagery shows does not exist.
function lookupTurfZeroIsObserved(enriched) {
  if (Number(enriched?.estimatedTurfSf) !== 0) return false;
  if (String(enriched?.turfSource || '').trim().toLowerCase() !== 'vision') return false;
  return lookupTurfReadIsTrustworthy(enriched);
}

// Vision-derived FEATURE modifiers (pool, cage, shrub/tree density,
// landscape complexity, tree count, water adjacency) all come off the same
// imagery read. When the lookup grades that read low, none of them should
// move a price — the caller keeps its own defaults instead.
function lookupFeaturesAreTrustworthy(enriched) {
  if (!enriched) return false;
  if (!lookupConfidenceIsAdequate(enriched)) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('estimatedturf') || field.includes('pool') || field.includes('shrub')
    || field.includes('tree') || field.includes('landscape')
  ));
}

// Weak or conflicting core dimensions ship with their own fieldVerifyFlags
// entries — the flag builder marks squareFootage / lotSize / stories as
// HIGH-priority "verify before pricing". The customer-facing pricing path
// has no review lane, so a flagged dimension may not price a quote: the
// caller leaves it unset and a missing required measurement fails closed to
// PROPERTY_DETAILS_NEEDED rather than pricing on a number the lookup itself
// said to verify first.
const DIMENSION_FLAG_MATCHERS = {
  homeSqFt: ['squarefootage', 'square_footage', 'homesqft', 'home_sqft'],
  lotSqFt: ['lotsize', 'lot_size', 'lotsqft', 'lot_sqft'],
  stories: ['stories'],
};

function lookupDimensionIsTrustworthy(enriched, dimension) {
  const names = DIMENSION_FLAG_MATCHERS[dimension] || [String(dimension || '').toLowerCase()];
  return !hasVerifyFlagMatching(enriched, (field) => names.some((name) => field.includes(name)));
}

// applyVisionPropertyTypeEvidence MUTATES the property record itself
// (rc.propertyType = <satellite type>, rc._propertyTypeSource = 'satellite',
// fieldVerify kept on rc._fieldEvidence.propertyType) — it only ever fires
// on a weak-typed record. So when the enriched type is rejected for its
// verify flag, a bare record fallback would hand the SAME rejected
// classification straight back.
//
// But a fieldVerify bit alone does NOT make the winner weak:
// mergePropertyRecords sets it on mere source DISAGREEMENT even when
// authoritative county/cadastral/listing/verified data won the field (the
// route's own recordPropertyTypeIsWeak contract). Rejecting every flagged
// record type dropped the authoritative townhome/condo winner and repriced
// it as single_family. Distrust only a satellite-sourced type or a weak
// WINNING source; a no-evidence record (legacy cache) keeps its plain
// record semantics — the caller's 'UNKNOWN' guard still applies.
function recordPropertyTypeIsTrustworthy(record) {
  if (!record || !record.propertyType) return false;
  if (String(record._propertyTypeSource || '').trim().toLowerCase() === 'satellite') return false;
  const ev = record._fieldEvidence?.propertyType;
  if (!ev) return true;
  const sourceType = String(ev.sourceType || '').trim().toLowerCase();
  if (sourceType === 'satellite') return false;
  return !(sourceType === '' || sourceType === 'unknown' || sourceType === 'generic');
}

// Same field-level rule as the bed area below: estimatedTreeCount is
// gap-filled outside divergence tracking, so the blended average can
// launder a lone low-confidence count straight into per-tree labor minutes
// AND the per-tree material term. mergeAiAnalyses stamps the winning
// count's provider confidence (zeroed on material divergence), surfaced as
// treeCountConfidence. Missing stamp = legacy payload = fail closed — the
// pricer's density fallback runs and carries its own review warning.
function lookupTreeCountIsTrustworthy(enriched) {
  const count = Number(enriched?.estimatedTreeCount);
  if (!Number.isFinite(count) || count <= 0) return false;
  const fieldConfidence = Number(enriched?.treeCountConfidence ?? enriched?._treeCountConfidence);
  if (!Number.isFinite(fieldConfidence) || fieldConfidence < LOOKUP_AI_CONFIDENCE_FLOOR) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('treecount') || field.includes('tree_count')
  ));
}

// Structural facts (constructionMaterial / foundationType / roofType /
// yearBuilt) are merged into the RECORD from listings and AI when county
// data is absent — `_fieldEvidence.<field>.fieldVerify` marks those
// weak/conflicting merges, and that evidence bit is the ONLY reliable
// distrust signal for them. The fieldVerifyFlags STREAM must not be used
// here: the flag builder also emits same-named OPERATIONAL RISK notices for
// authoritative values (wood frame = "higher termite risk", crawlspace =
// "treatment approach differs") — treating those as distrust would drop
// county-confirmed facts and underquote exactly the risky homes their
// pricing modifiers exist for. A record without evidence metadata (legacy
// cache) keeps its pre-existing trusted-record semantics.
function structuralFactIsTrustworthy({ record, field }) {
  return !record?._fieldEvidence?.[field]?.fieldVerify;
}

// 'address' alone marks a WRONG-PREMISE lookup: the geocoder snapped to a
// different parcel, so the record's dimensions describe the neighbor. 'all'
// is deliberately excluded here — its MEDIUM form marks an AI-web-search
// record for the RIGHT address (the county roll gave nothing), whose
// dimensions source-arbitration grades as low-confidence LOOKUP_ESTIMATE
// facts that route to a reviewable draft; its HIGH form fires only when
// there is no record to strip at all. Callers with NO review lane (the
// customer-facing path) keep the stricter hasGlobalVerifyFlag instead.
function hasWrongPremiseFlag(enriched) {
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  return flags.some((flag) => String(flag?.field || '').trim().toLowerCase() === 'address');
}

// A satellite attachment reclassification deliberately ships with a
// fieldVerifyFlags entry for propertyType whose own copy says to confirm
// townhome vs single-family BEFORE pricing
// (property-lookup-v2#applyVisionPropertyTypeEvidence keeps fieldVerify on
// the evidence, and the flag builder emits field='propertyType'). Property
// type carries its own pricing adjustment, so a flagged type must not move
// a price — the caller keeps its stored classification instead.
function lookupPropertyTypeIsTrustworthy(enriched) {
  if (!enriched?.propertyType) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('propertytype') || field.includes('property_type')
  ));
}

// County/assessor-backed pool + cage survive a low AI grade: the enriched
// payload stamps poolSource ('verified' | 'county' | 'vision'), and cage
// presence comes from the assessed extra-features roll (poolCageSqft) — that
// is record data, not an imagery guess, so an obstructed photo is no reason
// to quote a pool-less property. Vision-sourced pool/cage stay gated.
function poolFeaturesAreRecordBacked(enriched) {
  const src = String(enriched?.poolSource || '').trim().toLowerCase();
  return src === 'county' || src === 'verified';
}

function poolCageIsRecordBacked(enriched) {
  const sqft = Number(enriched?.poolCageSqft);
  return Number.isFinite(sqft) && sqft > 0;
}

module.exports = {
  poolFeaturesAreRecordBacked,
  poolCageIsRecordBacked,
  LOOKUP_AI_CONFIDENCE_FLOOR,
  hasGlobalVerifyFlag,
  lookupConfidenceIsAdequate,
  lookupBedAreaIsTrustworthy,
  lookupFeaturesAreTrustworthy,
  lookupPropertyTypeIsTrustworthy,
  lookupDimensionIsTrustworthy,
  recordPropertyTypeIsTrustworthy,
  lookupTurfEstimateIsTrustworthy,
  lookupTurfZeroIsObserved,
  lookupTreeCountIsTrustworthy,
  structuralFactIsTrustworthy,
  hasWrongPremiseFlag,
};
