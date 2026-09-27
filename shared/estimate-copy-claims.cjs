'use strict';

// Shared customer-copy classification for neutral estimate surfaces.
// Purchased service-specific warranty terms are retained explicitly by callers.
const GUARANTEE_COPY = /guarantee|warrant(?:y|ies)|callbacks?|re[- ]?(?:treat(?:ment|s|ed|ing)?|spray(?:s|ed|ing)?)|money[- ]?back|risk[- ]?free|satisfaction|(?:free[^.!?]*(?:re[- ]?service|service calls?)|(?:re[- ]?service|service calls?)[^.!?]*(?:free|no charge))/i;
const RECURRING_TERMS_COPY = /callbacks?|re[- ]?treat(?:ment|s|ed|ing)?|money[- ]?back|no[- ](?:long[- ]term[- ]|commitment[- ])?(?:contracts?|commitment)|(?:pause|cancel) any\s*time|no lock[- ]?in|(?:no|without(?: a)?) cancellation fees?|stop after any visit|contract[- ]free|(?:free|included)[^.!?;]*(?:re[- ]?service|service calls?)|(?:re[- ]?service|service calls?)[^.!?;]*(?:free|no charge|included)/i;
const PLAN_TERMS_COPY = new RegExp(`${GUARANTEE_COPY.source}|${RECURRING_TERMS_COPY.source}`, 'i');

function withoutPlanTermsClaims(text) {
  return String(text || '').split(/(?<=[.!?;])\s+/)
    .filter((clause) => !PLAN_TERMS_COPY.test(clause)).join(' ').trim() || null;
}

module.exports = { GUARANTEE_COPY, RECURRING_TERMS_COPY, PLAN_TERMS_COPY, withoutPlanTermsClaims };
