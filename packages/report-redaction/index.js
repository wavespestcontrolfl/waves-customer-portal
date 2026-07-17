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
  // a bare transaction party starts a NEW payment clause ("…, buyer paid
  // $400 at closing") — its amount is never the fee. As the AGENT of the
  // fee's own payment ("paid by seller: $250") the party is consumed by
  // PARTY_AGENT_PHRASE below, so the breaker never sees it.
  'buyers?', 'sellers?', 'owners?', 'tenants?', 'landlords?', 'realtors?', 'lenders?',
].join('|');

// Immediately after the cue, cost/charge/price/run read as the VERB stating
// the fee's own amount ("Inspection fee costs $250", "fee will cost $250",
// "fee generally runs $175", "fee has a cost of $250") — the one position
// where those words are a bridge, not a new money subject. A short run of
// modals/adverbs (and has/a/of for the nominal form) may precede the verb.
const DIRECT_BRIDGE =
  '(?:'
  + '(?:\\s+(?:will|would|may|might|can|could|shall|typically|generally|usually|normally|currently|often|still|only|has|have|had|an?))*'
  + '\\s+(?:costs?|charges?|prices?|runs?)\\b'
  + '(?:\\s+of\\b)?'
  + ')?';

// Known abbreviations whose trailing period must not read as end-of-sentence
// — "Inspection fee approx. $250" / "est. at $250" keep the cue's reach.
// Each is consumed as one gap token WITH its period; a word merely ENDING in
// these letters ("largest.") fails the leading \b and still terminates.
const GAP_ABBREVIATIONS = '(?:approx|appx|est|min|max|incl|excl)';

// A money-subject noun inside an INCLUSION phrase is WHERE the fee lives,
// not a new subject — "included in closing costs: $250" is still the fee.
// Requires the inclusion VERB: a bare preposition over-reached ("properties
// under a value of $400,000" is a threshold, and its amount must survive —
// the money-noun breaker fires there instead).
const CONTAINER_PHRASE = '\\b(?:included|rolled|folded|bundled|reflected|absorbed)\\s+(?:in|into|within)\\s+(?:\\w+\\s+){0,2}?(?:costs?|prices?|charges?|values?)\\b';

// "for the (WDO) treatment/repair/permit/service" directly describes WHICH
// inspection the fee covers — the treatment word is scope, not a new money
// subject, so it is consumed atomically ("Inspection fee for the WDO
// treatment is $250" redacts). The lookahead rejects the token when the
// scope word actually starts a money phrase ("for the treatment estimate
// $900" still breaks).
const FEE_SCOPE_PHRASE =
  '\\bfor\\s+(?:\\w+\\s+){0,3}?(?:re-?treatments?|treatments?|repairs?|permits?|services?)\\b'
  + '(?!\\s+(?:estimates?|quotes?|costs?|prices?|charges?|fees?|bills?|invoices?|totals?)\\b)'
  + '(?!\\s*\\$)(?!\\s*\\d)';

// Textareas wrap: "Inspection fee:\n$250" is one disclosure, so a SINGLE
// line break is consumable — but only when the next line starts with an
// amount, so an unrelated next paragraph ("Inspection fee waived\nRepair
// notes…") keeps the newline boundary. A blank line (two breaks) always
// terminates.
const AMOUNT_LINE_BREAK = '\\r?\\n(?=[ \\t]*(?:\\$|USD\\b|US\\$|\\d))';

// "by/from + party" names the AGENT of the fee's own payment — "paid by
// seller: $250" is still the fee — so the phrase is consumed atomically and
// the party-noun breaker never fires on it. A bare party noun (new clause,
// new payer) still breaks.
const PARTY_AGENT_PHRASE =
  '\\b(?:by|from)\\s+(?:the\\s+)?(?:buyers?|sellers?|owners?|tenants?|landlords?|realtors?|lenders?|title\\s+compan(?:y|ies))\\b';

// Amount-FIRST constructions name their subject right after the number —
// "$400,000 purchase price", "$400 balance remains". An amount directly
// followed by a money-subject noun is that subject's amount, never the fee,
// so the match is rejected (the gap then walks into the noun and the breaker
// aborts the cue entirely). Direct adjacency only — "fee $250 for the
// treatment area" is still the fee.
const AMOUNT_FIRST_SUBJECTS = [
  'prices?', 'costs?', 'charges?', 'values?', 'purchase', 'balance',
  'totals?', 'subtotal', 'deductibles?', 'discounts?', 'credits?',
  'estimates?', 'quotes?', 'repairs?', 're-?treatments?', 'treatments?',
  'permits?', 'damages?', 'homes?', 'houses?', 'property', 'properties',
  'escrow', 'deposits?',
].join('|');

// "the $400,000 home" / "a $500 escrow deposit" — a determiner directly
// before an amount marks it as a known amount of something ELSE being
// referenced, never the fee being stated. The gap refuses to walk onto such
// a determiner, so the cue aborts and the amount survives.
const DETERMINED_AMOUNT = '\\b(?:the|this|that|an?)\\s+(?:\\$|USD\\b|US\\$|\\d)';

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
// $175 to $250", "$175–$250", "$175/$250", "either $175 or $250", and the
// qualified form "$175 for block homes and $250 for wood-frame homes" — so
// every amount joined to the first is consumed into the one redaction
// (codex #2817: redacting only the first amount left the second visible).
// The optional qualifier between amounts is a short breaker-tempered
// "for <words>" phrase, so "and treatment $900" / "for repairs and $500"
// (a new money subject between) is never swallowed.
const CONTINUATION_QUALIFIER =
  `(?:\\s+for\\s+(?:(?!\\b(?:${FEE_REACH_BREAKERS})\\b)[\\w\\-]+\\s+){0,4}?)?`;
const RANGE_CONTINUATION =
  `(?:${CONTINUATION_QUALIFIER}\\s?(?:to|through|thru|or|and|[-–—/])\\s?`
  + '(?:'
  + '\\$\\s?\\d[\\d,]*(?:\\.\\d{1,2})?'
  + '|(?:USD|US\\$)\\s?\\d[\\d,]*(?:\\.\\d{1,2})?'
  + '|\\d[\\d,]*(?:\\.\\d{1,2})?\\s?dollars?\\b'
  + '|\\d{2,}[\\d,]*(?:\\.\\d{1,2})?(?!\\s?(?:days?|weeks?|months?|years?|hours?|minutes?|business|am|pm|%|square|sq|sqft|feet|foot|ft|acres?|stor(?:y|ies))\\b)(?![:/\\-]?\\d)'
  + '))*';

const FEE_CUE_RE = new RegExp(
  '\\b(inspection\\s+fee)\\b'
  + `(${DIRECT_BRIDGE}(?:(?!\\b(?:${FEE_REACH_BREAKERS})\\b)(?!${DETERMINED_AMOUNT})(?:${CONTAINER_PHRASE}|${FEE_SCOPE_PHRASE}|${PARTY_AGENT_PHRASE}|\\b${GAP_ABBREVIATIONS}\\.|${AMOUNT_LINE_BREAK}|[^.;!?\\n])){0,160}?)`
  + `(?:${AMOUNT_PATTERN})`
  + RANGE_CONTINUATION
  // (?![,.]?\d) forbids backtracking into a partial number ("$400" out of
  // "$400,000") to dodge the subject guard that follows. Horizontal
  // whitespace ONLY: a subject word opening the NEXT LINE is a new
  // paragraph, not this amount's subject ("Inspection fee $250\nRepair
  // notes follow" must still redact).
  + `(?![,.]?\\d)(?![ \\t]{1,3}(?:${AMOUNT_FIRST_SUBJECTS})\\b)`,
  'gi',
);

// Amount BEFORE the cue — "The $250 inspection fee was collected", "a $175
// WDO inspection fee applies", and ranges: "The $175-$250 inspection fee
// depends on construction" consumes the WHOLE range so no bound survives.
// The amount must sit within two words of the cue, so "$1,250 repair
// completed near the inspection fee area" (three words away, different
// subject) is never touched. Currency-marked amounts only: a bare number
// before the cue ("250 inspection fee"?) has no natural reading worth the
// corruption risk.
const PRE_CUE_AMOUNT =
  '(?:\\$\\s?\\d[\\d,]*(?:\\.\\d{1,2})?|(?:USD|US\\$)\\s?\\d[\\d,]*(?:\\.\\d{1,2})?|\\d[\\d,]*(?:\\.\\d{1,2})?\\s?dollars?)';
const PRE_CUE_RE = new RegExp(
  `(${PRE_CUE_AMOUNT}(?:\\s?(?:to|through|thru|or|and|[-–—/])\\s?${PRE_CUE_AMOUNT})*)`
  + '(\\s+(?:[\\w\\-]+\\s+){0,2}?inspection\\s+fee)\\b',
  'gi',
);

// When the cue is directly preceded by an amount (or by the marker the
// pre-cue pass just wrote), that amount IS the fee — the forward scan must
// not fire and consume a later unrelated amount ("The $250 inspection fee
// was collected at closing with $400 held in escrow" keeps the $400).
const PRE_OWNED_CUE_RE = /(?:\$\s?\d[\d,]*(?:\.\d{1,2})?|\d\s?dollars?|\[fee removed\])\s+(?:[\w\-]+\s+){0,2}$/i;

function redactInspectionFeeCues(text) {
  const str = String(text || '');
  if (!str) return str;
  // Fee-free text passes through BYTE-IDENTICAL — the whitespace cleanup
  // below must never run on text with nothing to redact, or it would alter
  // prose (and shift wdoContentHash, falsely staling signatures) for
  // strings that merely contain doubled spaces.
  if (!containsInspectionFeeCue(str)) return str;
  return str
    // pre-cue first, so a forward match can recognize a cue whose amount
    // was already consumed (see PRE_OWNED_CUE_RE)
    .replace(PRE_CUE_RE, (m, amount, rest) => `[fee removed]${rest}`)
    // mid can be empty when the amount form consumed its own introducer
    // ("inspection fee: 250") — keep a space so the marker doesn't fuse.
    .replace(FEE_CUE_RE, (m, cue, mid, offset, whole) => {
      const before = whole.slice(Math.max(0, offset - 60), offset);
      if (PRE_OWNED_CUE_RE.test(before)) return m;
      return `${cue}${mid || ' '}[fee removed]`;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Detection-only variant for gating decisions (e.g. whether a legacy
// archived FDACS filing's snapshot carries a fee disclosure) — true when the
// redactor WOULD remove something. Fresh non-global regexes so .test()
// carries no lastIndex state.
const FEE_CUE_TEST_RE = new RegExp(FEE_CUE_RE.source, 'i');
const PRE_CUE_TEST_RE = new RegExp(PRE_CUE_RE.source, 'i');
function containsInspectionFeeCue(text) {
  const str = String(text || '');
  if (!str) return false;
  return FEE_CUE_TEST_RE.test(str) || PRE_CUE_TEST_RE.test(str);
}

module.exports = {
  INTERNAL_FINDING_KEYS,
  redactInspectionFeeCues,
  containsInspectionFeeCue,
};
