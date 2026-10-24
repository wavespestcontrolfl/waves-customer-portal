'use strict';

// Satellite palm count review (owner 2026-10-23: the vision model over-counts
// palms, so a count read from the aerial image must not price a draft
// unattended). The T&S line KEEPS the lookup count for pricing, so the draft
// shows a sensible number, but it carries the existing palm_count_unverified
// review reason: the lane goes yellow and the send gate holds the draft until
// an admin counts the palms on the aerial photo and confirms (AI Draft Review
// -> confirm the send), or rebuilds the quote in the estimate tool, whose
// resubmitted line is caller-stated and carries no palmCountFromLookup. With
// GATE_SATELLITE_PALM_COUNT_TYPED on, the confirm also needs the admin's typed
// count (satellitePalmCountToConfirm below, read by the send gate).
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

// The satellite palm count a STORED draft still prices (follow-up B to the
// flag above, owner 2026-10-24: the count is a suggestion until an admin types
// the real one before the first send). Keyed on the line's own provenance and
// count, the same line predicate as the flag, not on the review reason: a
// later recompute from engineInputs drops the reason but keeps the line's
// palmCountFromLookup. Returns the priced count, or null when no line has one.
function satellitePalmCountToConfirm(estimateData) {
  const lines = Array.isArray(estimateData?.engineResult?.lineItems) ? estimateData.engineResult.lineItems : [];
  const line = lines.find((l) => l?.service === 'tree_shrub' && l.palmCountFromLookup === true && Number(l.palmCount) > 0);
  return line ? Number(line.palmCount) : null;
}

module.exports = { LOOKUP_PALM_REVIEW_REASON, LOOKUP_PALM_REVIEW_WARNING, flagLookupPalmCountForReview, satellitePalmCountToConfirm };
