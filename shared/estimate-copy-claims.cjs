'use strict';

// Shared customer-copy classification for neutral estimate surfaces.
// Purchased service-specific warranty terms are retained explicitly by callers.
const GUARANTEE_COPY = /guarantee|warrant(?:y|ies)|callbacks?|re[- ]?(?:treat(?:ment|s|ed|ing)?|spray(?:s|ed|ing)?)|money[- ]?back|risk[- ]?free|satisfaction|(?:free[^.!?]*(?:re[- ]?service|service calls?)|(?:re[- ]?service|service calls?)[^.!?]*(?:free|no charge))/i;
const RECURRING_TERMS_COPY = /callbacks?|re[- ]?treat(?:ment|s|ed|ing)?|money[- ]?back|no[- ](?:long[- ]term[- ]|commitment[- ])?(?:contracts?|commitment)|(?:pause|cancel) any\s*time|no lock[- ]?in|(?:no|without(?: a)?) cancellation fees?|stop after any visit|contract[- ]free|(?:free|included)[^.!?;]*(?:re[- ]?service|service calls?)|(?:re[- ]?service|service calls?)[^.!?;]*(?:free|no charge|included)/i;
const PLAN_TERMS_COPY = new RegExp(`${GUARANTEE_COPY.source}|${RECURRING_TERMS_COPY.source}`, 'i');

// The guarantee scope of an estimate or document, from the server's two
// decisions (docs/public-route-contracts.md, the guarantee rule):
//   'none'         termite or unclassifiable work: no guarantee claim at all;
//   'satisfaction' a service that does not carry the plan terms (rodent,
//                  commercial): only "satisfaction guaranteed", those lanes'
//                  own term;
//   'all'          every service carries the plan terms.
function guaranteeScope({ noGuaranteeClaims = false, noEstimateWideGuarantee = false } = {}) {
  if (noGuaranteeClaims === true) return 'none';
  if (noEstimateWideGuarantee === true) return 'satisfaction';
  return 'all';
}

// One service's scope (owner ruling 2026-09-27: each service carries its own
// terms; a line covering the whole estimate needs every service to carry
// it). The estimate's 'none' governs every service. Otherwise a row the
// server stamped with its own termsScope ('all' for residential pest, lawn,
// mosquito, tree & shrub or palm work; 'satisfaction' for rodent or
// commercial work) states those terms, and an unstamped row follows the
// estimate.
function serviceGuaranteeScope(estimateScope, termsScope) {
  if (estimateScope === 'none' || termsScope === 'none') return 'none';
  if (termsScope === 'all' || termsScope === 'satisfaction') return termsScope;
  return estimateScope;
}

// The annual rate review disclosure printed beside a recurring residential
// document's terms line (owner ruling 2026-09-30, verbatim owner copy). It
// is a disclosure, not a plan-terms CLAIM (no guarantee/contract wording,
// so PLAN_TERMS_COPY never matches it) — callers gate it explicitly on the
// plan-terms scope: every line residential pest, lawn, mosquito or tree &
// shrub, at least one recurring line, no authored/structured/program terms.
// Shared by the browser document (EstimateProposalDocument.jsx) and the
// pdfkit fallback (server/services/pdf/estimate-pdf.js) so the two
// renderers cannot drift.
const RATE_REVIEW_TERMS_LINE = 'Rate reviewed yearly after 12 months, 30 days’ notice';

const SATISFACTION_CLAIM = /\bsatisfaction guaranteed\b/i;
const SATISFACTION_CLAIMS = /\bsatisfaction guaranteed\b/gi;

// Whether a piece of copy may be stated in a scope: anything with no
// plan-terms claim, and in 'satisfaction' a clause whose only claim is
// "satisfaction guaranteed".
function copyAllowedInScope(text, scope = 'all') {
  const value = String(text || '');
  if (scope === 'all' || !PLAN_TERMS_COPY.test(value)) return true;
  return scope === 'satisfaction' && SATISFACTION_CLAIM.test(value)
    && !PLAN_TERMS_COPY.test(value.replace(SATISFACTION_CLAIMS, ''));
}

// Text with the parts a scope does not allow removed and its scope kept.
// Engine details join their parts with " | " (v1-legacy-mapper), prose uses
// sentences, and both split. `keep` retains a part the caller has verified,
// such as a pre-slab job's selected extended warranty.
function withoutClaimsOutsideScope(text, scope = 'none', keep = () => false) {
  if (scope === 'all') return text;
  return String(text || '').split(/\s+\|\s+/)
    .map((part) => part.split(/(?<=[.!?;])\s+/)
      .filter((clause) => copyAllowedInScope(clause, scope) || keep(clause)).join(' ').trim())
    .filter(Boolean)
    .join(' | ') || null;
}

// The same filter against an arbitrary claim class (Ask Waves passes its own).
function withoutClaimParts(text, pattern, keep = () => false) {
  return String(text || '').split(/\s+\|\s+/)
    .map((part) => part.split(/(?<=[.!?;])\s+/)
      .filter((clause) => !pattern.test(clause) || keep(clause)).join(' ').trim())
    .filter(Boolean)
    .join(' | ') || null;
}

function withoutPlanTermsClaims(text, keep) {
  return withoutClaimsOutsideScope(text, 'none', keep);
}

module.exports = {
  GUARANTEE_COPY,
  RECURRING_TERMS_COPY,
  PLAN_TERMS_COPY,
  RATE_REVIEW_TERMS_LINE,
  copyAllowedInScope,
  guaranteeScope,
  serviceGuaranteeScope,
  withoutClaimParts,
  withoutClaimsOutsideScope,
  withoutPlanTermsClaims,
};
