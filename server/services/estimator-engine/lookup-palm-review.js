'use strict';

// Satellite palm count review (owner 2026-10-23: the vision model over-counts
// palms, so a count read from the aerial image must not price a draft
// unattended). The T&S line KEEPS the lookup count for pricing, so the draft
// shows a sensible number, but it carries the existing palm_count_unverified
// review reason: the lane goes yellow and the send gate holds the draft until
// an admin counts the palms on the aerial photo and confirms (AI Draft Review
// -> confirm the send), or rebuilds the quote in the estimate tool, whose
// resubmitted line is caller-stated and carries no palmCountFromLookup.
//
// This runs on the FRESH draft pricing only, NOT inside the pricer: the
// stored engineInputs of every sent quote still carry palmCountFromLookup and
// replay through generateEstimate, so a pricer-level reason would add a new
// review flag to quotes that already went out. A caller-stated count never
// sets palmCountFromLookup, so it never gets the flag. Mutates and returns
// engineResult.
const LOOKUP_PALM_REVIEW_REASON = 'palm_count_unverified';
const LOOKUP_PALM_REVIEW_WARNING = 'Palm count came from the satellite image, which can over-count; count the palms on the aerial photo and confirm before sending.';
function flagLookupPalmCountForReview(engineInput, engineResult) {
  if (engineInput?.services?.treeShrub?.palmCountFromLookup !== true) return engineResult;
  const lines = Array.isArray(engineResult?.lineItems) ? engineResult.lineItems : [];
  let flagged = false;
  for (const line of lines) {
    if (line?.service !== 'tree_shrub' || line.palmCountFromLookup !== true || !(Number(line.palmCount) > 0)) continue;
    line.manualReviewReasons = [...new Set([...(line.manualReviewReasons || []), LOOKUP_PALM_REVIEW_REASON])];
    line.warnings = [...new Set([...(line.warnings || []), LOOKUP_PALM_REVIEW_WARNING])];
    flagged = true;
  }
  const meta = engineResult?.pricingMetadata;
  if (flagged && meta && typeof meta === 'object') {
    meta.manualReviewReasons = [...new Set([...(meta.manualReviewReasons || []), LOOKUP_PALM_REVIEW_REASON])];
    meta.warnings = [...new Set([...(meta.warnings || []), LOOKUP_PALM_REVIEW_WARNING])];
  }
  return engineResult;
}


module.exports = { LOOKUP_PALM_REVIEW_REASON, LOOKUP_PALM_REVIEW_WARNING, flagLookupPalmCountForReview };
