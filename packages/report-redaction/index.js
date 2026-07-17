/**
 * @waves/report-redaction — single source of truth for project-report
 * internal-fee redaction.
 *
 * The server (server/services/project-types.js — public /data egress, write
 * guards, narrative prompt, report assistant, completion copy) AND the client
 * (client/src/lib/wdoReportFields.js — public report page + the admin
 * "Customer report preview") both import this module, so the preview staff
 * approve, the payload the customer receives, and the text the model sees
 * cannot drift (same pattern as @waves/lawn-cost-floor).
 *
 * Pure CommonJS, zero dependencies — consumable by the CJS server via
 * require() and by the ESM/Vite client via import.
 */

// Internal/office-only finding keys — captured on the WDO create form but
// NEVER customer-facing (audit 2026-07-16). inspection_fee is an invoicing
// fee-tier helper; the invoice carries the actual price.
const INTERNAL_FINDING_KEYS = ['inspection_fee'];

// Words that END the inspection-fee cue's reach inside a clause. Two families:
// - the fee was waived/paid/comped — it has no (relevant) amount, so whatever
//   amount follows belongs to something else ("Inspection fee paid separately,
//   total due $400" must keep the $400);
// - a NEW money subject — its amount is legitimate customer-facing text
//   ("Inspection fee noted, treatment estimate $900").
// NOT breakers: "due"/"service" (they bridge the cue to its own amount —
// "inspection fee is due at time of service: $250" IS the fee).
const FEE_REACH_BREAKERS = [
  'waiv\\w*', 'paid', 'collected', 'settled', 'comped', 'complimentary',
  'free', 'included', 'covered', 'no charge',
  'repairs?', 're-?treatments?', 'treatments?', 'permits?', 'damages?',
  'estimates?', 'quotes?', 'deductibles?', 'discounts?', 'credits?',
  'balance', 'totals?', 'subtotal', 'amount\\s+due',
].join('|');

// Amount forms the cue can disclose. A literal $ amount, a USD/US$-prefixed
// amount, a "250 dollars" currency-word amount, or a bare number. The bare
// form is the corruption-prone one ("Inspection fee for 123 Main Street is
// $250" must not select the street number), so it only matches when a value
// introducer — is/was/of/at or a colon/equals — DIRECTLY precedes the digits
// ("inspection fee is 250", "inspection fee: 250"); an arbitrary mid-clause
// number can never be selected, and the $ amount later in the clause is still
// caught by the other forms. It is further fenced: 2+ digits (so "tier 2"
// survives), not part of a date/time/range ("due 07/24", "at 10:30"), not a
// duration or unit ("due in 30 days", "10am"), and not a 19xx/20xx year.
const AMOUNT_PATTERN = [
  '\\$\\s?\\d[\\d,]*(?:\\.\\d{1,2})?',
  '(?:USD|US\\$)\\s?\\d[\\d,]*(?:\\.\\d{1,2})?',
  '\\d[\\d,]*(?:\\.\\d{1,2})?\\s?dollars?\\b',
  '(?:\\b(?:is|was|of|at)\\s{1,3}|[:=]\\s{0,3})(?!(?:19|20)\\d{2}\\b)\\d{2,}[\\d,]*(?:\\.\\d{1,2})?(?!\\s?(?:days?|weeks?|months?|years?|hours?|minutes?|business|am|pm|%|dollars?)\\b)(?![:/\\-]?\\d)',
].join('|');

// Remove ONLY the literal "inspection fee" phrase + an amount from free text.
// Deliberately does NOT match a bare "fee" or a generic price/cost/charge, so
// a legitimate customer-facing estimate — "Repair cost $1,250", "permit fee
// $125" — is never touched. The cue's reach is one clause, not a fixed
// character window: sentence/clause punctuation ([.;!?]) ends it, and a
// breaker word aborts it (see FEE_REACH_BREAKERS). Colon and comma stay legal
// inside the reach — "due at time of service: $250" is still the fee.
// Targets the fee PHRASE, not a specific value, so a stale draft fee no
// structured snapshot still names is caught too. The 160 cap only bounds
// backtracking; the clause punctuation is the real limit.
const FEE_CUE_RE = new RegExp(
  '\\b(inspection\\s+fee)\\b'
  + `((?:(?!\\b(?:${FEE_REACH_BREAKERS})\\b)[^.;!?\\n]){0,160}?)`
  + `(?:${AMOUNT_PATTERN})`,
  'gi',
);

function redactInspectionFeeCues(text) {
  const str = String(text || '');
  if (!str) return str;
  return str
    // mid can be empty when the amount form consumed its own introducer
    // ("inspection fee: 250") — keep a space so the marker doesn't fuse.
    .replace(FEE_CUE_RE, (m, cue, mid) => `${cue}${mid || ' '}[fee removed]`)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

module.exports = {
  INTERNAL_FINDING_KEYS,
  redactInspectionFeeCues,
};
