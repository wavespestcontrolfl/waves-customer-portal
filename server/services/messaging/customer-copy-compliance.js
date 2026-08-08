/**
 * Deterministic compliance-language check for short, free-form
 * customer-facing text (dispatcher notes, one-off operator copy).
 *
 * These are the three HARD rules from the compliance program — the same
 * ones the social-compliance-judge prompt enforces on long-form content
 * (social-compliance-judge.js rules 1-3) — extracted as regexes so a
 * 200-char note can be validated synchronously before a move commits,
 * without an LLM call:
 *
 *   1. PRODUCT SAFETY — never call a product/treatment/service "safe".
 *      Allowed idioms: the drying phrasing ("safe once/when/after …
 *      dry"), protective framing ("safe from termites"), "stay safe",
 *      "safety data sheet". ("safety" as a bare word is not "safe" and
 *      passes.)
 *   2. EPA — "EPA-registered" / "EPA-exempt" only; any other EPA mention
 *      (especially "EPA-approved") is a violation.
 *   3. FIXED RE-ENTRY TIMING — never a specific minutes/hours figure tied
 *      to re-entry/drying/pets-kids-back-inside. Day-based cadences and
 *      plain durations with no re-entry context pass.
 *
 * Deliberately conservative: a false positive costs the operator a
 * reword; a false negative puts a banned claim in a customer SMS.
 */

const SAFE_ALLOWED_STRIP_RE = /\bsafe\s+(?:once|when|after)\b[^.!?]*|\bsafe\s+from\b|\bstay\s+safe\b|\bsafety\s+data\s+sheet\b/gi;
const SAFE_CLAIM_RE = /\bsafe(?:ly)?\b/i;

const EPA_VIOLATION_RE = /\bepa\b(?![-\s](?:registered|exempt))/i;

const REENTRY_CONTEXT = '(?:re-?ent(?:er|ry)|back\\s+(?:inside|in)|(?:pets?|dogs?|cats?|kids?|children)\\s+(?:out|outside|inside|back)|dr(?:y|ies|ying))';
const TIME_AMOUNT = '(?:\\d+\\s*(?:min(?:ute)?|hour|hr)s?|an?\\s+hour|half\\s+an?\\s+hour)';
const FIXED_TIMING_RE = new RegExp(
  `${REENTRY_CONTEXT}[^.!?]{0,40}${TIME_AMOUNT}|${TIME_AMOUNT}[^.!?]{0,40}${REENTRY_CONTEXT}`,
  'i',
);

/**
 * @param {string} text
 * @returns {{ rule: 'safety'|'epa'|'reentry_timing' } | null}
 */
function findComplianceViolation(text) {
  const body = String(text || '');
  if (SAFE_CLAIM_RE.test(body.replace(SAFE_ALLOWED_STRIP_RE, ''))) return { rule: 'safety' };
  if (EPA_VIOLATION_RE.test(body)) return { rule: 'epa' };
  if (FIXED_TIMING_RE.test(body)) return { rule: 'reentry_timing' };
  return null;
}

module.exports = {
  findComplianceViolation,
  // Exposed for tests
  _internals: { SAFE_ALLOWED_STRIP_RE, SAFE_CLAIM_RE, EPA_VIOLATION_RE, FIXED_TIMING_RE },
};
