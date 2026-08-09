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

// Absent confidence data is NOT evidence of doubt — legacy payloads carried
// no score, and treating them as untrustworthy would silently stop pricing
// inputs that have always been used.
function lookupConfidenceIsAdequate(enriched) {
  const score = confidenceScore(enriched);
  return score === null || score >= LOOKUP_AI_CONFIDENCE_FLOOR;
}

function hasVerifyFlagMatching(enriched, matcher) {
  const flags = Array.isArray(enriched?.fieldVerifyFlags) ? enriched.fieldVerifyFlags : [];
  return flags.some((flag) => matcher(String(flag?.field || '').toLowerCase()));
}

// A bed area is trustworthy when the lookup neither graded itself low nor
// flagged the bed-area read — or the turf/imagery read it came from, since
// that is the same picture.
function lookupBedAreaIsTrustworthy(enriched) {
  const area = Number(enriched?.estimatedBedAreaSf);
  if (!Number.isFinite(area) || area <= 0) return false;
  if (!lookupConfidenceIsAdequate(enriched)) return false;
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
  lookupConfidenceIsAdequate,
  lookupBedAreaIsTrustworthy,
  lookupFeaturesAreTrustworthy,
};
