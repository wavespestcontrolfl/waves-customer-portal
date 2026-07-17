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
// - the fee was waived/comped/free — it has NO amount of its own, so whatever
//   amount follows belongs to something else ("Inspection fee waived; repair
//   $1,250" must keep the $1,250);
// - a NEW money subject — its amount is legitimate customer-facing text
//   ("Inspection fee noted, treatment estimate $900"; "Inspection fee paid
//   separately, total due $400" keeps the $400 because "total" breaks).
// NOT breakers: "due"/"service" (they bridge the cue to its own amount —
// "inspection fee is due at time of service: $250" IS the fee), and the
// billing-state words paid/collected/settled/included/covered — a fee that
// was paid or "included on invoice: $250" still has its own amount and must
// redact; when the money after such a word belongs to something else, the
// money-subject breakers are what identify it.
const FEE_REACH_BREAKERS = [
  'waiv\\w*', 'comped', 'complimentary', 'free', 'no charge',
  'repairs?', 're-?treatments?', 'treatments?', 'permits?', 'damages?',
  'estimates?', 'quotes?', 'deductibles?', 'discounts?', 'credits?',
  'balance', 'totals?', 'subtotal', 'amount\\s+due',
  // money-subject nouns: "purchase price $400,000", "closing costs $12,000",
  // "service charge $75", "home value $400,000" are legitimate customer
  // financials and must never be consumed by a fee cue earlier in the clause.
  // The verb reading of cost/charge/price/run ("inspection fee costs $250")
  // is handled by DIRECT_BRIDGE below — adjacent to the cue it is the fee's
  // own amount, not a new subject.
  'prices?', 'costs?', 'charges?', 'values?', 'purchase',
].join('|');

// Immediately after the cue, cost/charge/price/run read as the VERB stating
// the fee's own amount ("Inspection fee costs $250", "fee runs $175") — the
// one position where those words are a bridge, not a new money subject.
const DIRECT_BRIDGE = '(?:\\s(?:costs?|charges?|prices?|runs?)\\b)?';

// Known abbreviations whose trailing period must not read as end-of-sentence
// — "Inspection fee approx. $250" / "est. at $250" keep the cue's reach.
// Each is consumed as one gap token WITH its period; a word merely ENDING in
// these letters ("largest.") fails the leading \b and still terminates.
const GAP_ABBREVIATIONS = '(?:approx|appx|est|min|max|incl|excl)';

// A money-subject noun preceded by a container preposition is WHERE the fee
// lives, not a new subject — "included in closing costs: $250" is still the
// fee. Consumed atomically so the money-noun breaker doesn't fire on it;
// "purchase price $400,000" (no container prep) still breaks.
const CONTAINER_PHRASE = '\\b(?:in|into|within|under)\\s+(?:\\w+\\s+){0,2}?(?:costs?|prices?|charges?|values?)\\b';

// Amount forms the cue can disclose. A literal $ amount, a USD/US$-prefixed
// amount, a "250 dollars" currency-word amount, or a bare number. The bare
// form is the corruption-prone one ("Inspection fee for 123 Main Street is
// $250" must not select the street number), so it only matches when a value
// introducer — is/was/of/from/between or a colon/equals — DIRECTLY precedes
// the digits
// ("inspection fee is 250", "inspection fee: 250"); an arbitrary mid-clause
// number can never be selected, and the $ amount later in the clause is still
// caught by the other forms. "at" is NOT an introducer — it is a location/
// time preposition ("the property at 123 Main Street", "at 10:30"), so a
// number after it is far more likely an address than an amount. Further
// fences: 2+ digits (so "tier 2" survives), not part of a date/time/range
// ("due 07/24"), not a duration or unit ("due in 30 days", "10am"), and not
// a 19xx/20xx year.
const AMOUNT_PATTERN = [
  '\\$\\s?\\d[\\d,]*(?:\\.\\d{1,2})?',
  '(?:USD|US\\$)\\s?\\d[\\d,]*(?:\\.\\d{1,2})?',
  '\\d[\\d,]*(?:\\.\\d{1,2})?\\s?dollars?\\b',
  '(?:\\b(?:is|was|of|from|between)\\s{1,3}|[:=]\\s{0,3})(?!(?:19|20)\\d{2}\\b)\\d{2,}[\\d,]*(?:\\.\\d{1,2})?(?!\\s?(?:days?|weeks?|months?|years?|hours?|minutes?|business|am|pm|%|dollars?|square|sq|sqft|feet|foot|ft|acres?|stor(?:y|ies))\\b)(?![:/\\-]?\\d)',
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
// A range or alternative continues the SAME fee disclosure — "ranges from
// $175 to $250", "$175–$250", "either $175 or $250" — so every amount joined
// to the first by a range connector is consumed into the one redaction
// (codex #2817: redacting only the first amount left the second visible).
// The connector must be DIRECTLY followed by an amount, so "and treatment
// $900" (a new subject between) is never swallowed.
const RANGE_CONTINUATION =
  '(?:\\s?(?:to|through|thru|or|and|[-–—])\\s?'
  + '(?:'
  + '\\$\\s?\\d[\\d,]*(?:\\.\\d{1,2})?'
  + '|(?:USD|US\\$)\\s?\\d[\\d,]*(?:\\.\\d{1,2})?'
  + '|\\d[\\d,]*(?:\\.\\d{1,2})?\\s?dollars?\\b'
  + '|\\d{2,}[\\d,]*(?:\\.\\d{1,2})?(?!\\s?(?:days?|weeks?|months?|years?|hours?|minutes?|business|am|pm|%|square|sq|sqft|feet|foot|ft|acres?|stor(?:y|ies))\\b)(?![:/\\-]?\\d)'
  + '))*';

const FEE_CUE_RE = new RegExp(
  '\\b(inspection\\s+fee)\\b'
  + `(${DIRECT_BRIDGE}(?:(?!\\b(?:${FEE_REACH_BREAKERS})\\b)(?:${CONTAINER_PHRASE}|\\b${GAP_ABBREVIATIONS}\\.|[^.;!?\\n])){0,160}?)`
  + `(?:${AMOUNT_PATTERN})`
  + RANGE_CONTINUATION,
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
