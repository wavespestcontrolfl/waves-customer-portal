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
  if (!lookupConfidenceIsAdequate(enriched, { requireExplicitScore: true })) return false;
  return !hasVerifyFlagMatching(enriched, (field) => (
    field.includes('bedarea') || field.includes('bed_area') || field.includes('estimatedturf')
  ));
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

module.exports = {
  LOOKUP_AI_CONFIDENCE_FLOOR,
  hasGlobalVerifyFlag,
  lookupConfidenceIsAdequate,
  lookupBedAreaIsTrustworthy,
  lookupFeaturesAreTrustworthy,
};
