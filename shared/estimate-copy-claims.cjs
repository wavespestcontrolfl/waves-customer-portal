'use strict';

// Shared customer-copy classification for neutral estimate surfaces.
// Purchased service-specific warranty terms are retained explicitly by callers.
const GUARANTEE_COPY = /guarantee|warrant(?:y|ies)|callbacks?|re[- ]?(?:treat(?:ment|s|ed|ing)?|spray(?:s|ed|ing)?)|money[- ]?back|risk[- ]?free|satisfaction|(?:free[^.!?]*(?:re[- ]?service|service calls?)|(?:re[- ]?service|service calls?)[^.!?]*(?:free|no charge))/i;
const RECURRING_TERMS_COPY = /callbacks?|re[- ]?treat(?:ment|s|ed|ing)?|money[- ]?back|no[- ](?:long[- ]term[- ]|commitment[- ])?(?:contracts?|commitment)|(?:pause|cancel) any\s*time|no lock[- ]?in|(?:no|without(?: a)?) cancellation fees?|stop after any visit|contract[- ]free|(?:free|included)[^.!?;]*(?:re[- ]?service|service calls?)|(?:re[- ]?service|service calls?)[^.!?;]*(?:free|no charge|included)/i;
const PLAN_TERMS_COPY = new RegExp(`${GUARANTEE_COPY.source}|${RECURRING_TERMS_COPY.source}`, 'i');

// Text with its claim parts removed and its scope kept. Engine details join
// their parts with " | " (v1-legacy-mapper), prose uses sentences, and both
// split. `keep` retains a part the caller has verified, such as a pre-slab
// job's selected extended warranty.
function withoutClaimParts(text, pattern, keep = () => false) {
  return String(text || '').split(/\s+\|\s+/)
    .map((part) => part.split(/(?<=[.!?;])\s+/)
      .filter((clause) => !pattern.test(clause) || keep(clause)).join(' ').trim())
    .filter(Boolean)
    .join(' | ') || null;
}

function withoutPlanTermsClaims(text, keep) {
  return withoutClaimParts(text, PLAN_TERMS_COPY, keep);
}

module.exports = { GUARANTEE_COPY, RECURRING_TERMS_COPY, PLAN_TERMS_COPY, withoutClaimParts, withoutPlanTermsClaims };
