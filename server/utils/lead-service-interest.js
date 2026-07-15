/**
 * composeServiceInterest — multi-service lead label for AI-captured calls.
 *
 * The extraction schema carries ONE catalog-matched service (matched_service),
 * so a caller who asks for "the full package — house, lawn" used to land on
 * the lead card as just "Quarterly Pest Control Service": every service after
 * the first catalog match was silently dropped from service_interest, and the
 * office priced half the job (live multi-service call, 2026-07-15).
 * requested_service is
 * the extractor's verbatim distillation of what the CALLER asked for, so the
 * lost services are still in the row — this helper appends the service
 * families mentioned there that the catalog match doesn't already cover:
 *
 *   matched  "Quarterly Pest Control Service"
 *   requested "Quarterly pest control and lawn care"
 *   → "Quarterly Pest Control Service + Lawn Care Service"
 *
 * Deliberately deterministic and narrow:
 * - Only requested_service is scanned — never the transcript, so an agent's
 *   ignored upsell ("want mosquito with that?") can't inflate the label
 *   (same caller's-own-words scope as applyRecurringIntentDefault).
 * - matched_service stays FIRST and untouched — downstream consumers that
 *   read the primary service off the front of the label keep working, and
 *   catalog booking never reads this label (it books from matched_service /
 *   specific_service_name directly).
 * - Appended labels are coarse family names, not catalog rows — cadence for
 *   the second service (monthly vs quarterly lawn) is a pricing decision the
 *   office makes, not something to guess here.
 * - Returns null when there is no matched_service so call sites keep their
 *   legacy `matched || requested` fallback order unchanged.
 */

const cleanText = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
};

// One entry per bookable service family. `label` is what gets appended when
// the family is requested but not covered by the catalog match. Order here is
// only a tiebreak — extras append in the order the caller mentioned them.
// Vocabulary mirrors canonicalWavesService (call-recording-processor.js) —
// same word-bounded terms per family, kept multi-hit here instead of that
// function's first-match-wins single slot. Bed bug is its own family (own
// catalog service + prep flow), so "lawn care and bed bugs" surfaces the
// specific service, not generic pest. `fungus` guards against "fungus gnats"
// (a pest, not a lawn disease). No blanket cross-family aliases: the one
// wdo→termite suppression is conditional in composeServiceInterest — lenders
// phrase the WDO as "termite inspection" constantly (no phantom tail), but
// explicit termite TREATMENT wording next to a WDO match stays visible, and
// an explicit WDO report next to termite work stays visible too — both are
// distinct billable deliverables (project-types.js routes real-estate
// transactions to WDO).
const SERVICE_FAMILIES = [
  { key: 'pest', label: 'Pest Control Service', re: /\bpests?\b|(?<!\bbed[\s-])\bbugs?\b|\binsects?\b|\broach(?:es)?\b|\bcockroach(?:es)?\b|\bants?\b|\bspiders?\b|\bwasps?\b|\bhornets?\b|\byellow\s?jackets?\b|\bbees?\b|\bfleas?\b|\bticks?\b|\bsilverfish\b|\bearwigs?\b|\bmillipedes?\b|\bcentipedes?\b|\bpalmetto\s+bugs?\b|\bscorpions?\b|\bflies\b|\bfly\b|\bgnats?\b|\bcrickets?\b|\bexterminat/i },
  { key: 'bed_bug', label: 'Bed Bug Treatment', re: /\bbed[\s-]*bugs?\b|\bbedbugs?\b/i },
  { key: 'lawn', label: 'Lawn Care Service', re: /\blawns?\b|\bturf\b|\bgrass\b|\bfertili[sz](?:e|er|ation|ing)?\b|\bweeds?\b|\bchinch\b|\bsod\b|\bfungus\b(?!\s*gnats?)|\bfungal\b/i },
  // palm(?!\s+rat): "palm rats" are roof rats — rodent, not tree & shrub
  { key: 'tree_shrub', label: 'Tree & Shrub Care Service', re: /\btrees?\b|\bshrubs?\b|\bornamentals?\b|\bpalms?\b(?!\s+rats?)/i },
  // midges / no-see-ums are treated by the mosquito program in this repo
  { key: 'mosquito', label: 'Mosquito Control Service', re: /\bmosquito(?:es|s)?\b|\bmidges?\b|\bno[-\s]?see[-\s]?ums?\b/i },
  { key: 'termite', label: 'Termite Service', re: /\btermites?\b|\btermidor\b|\btermiticide\b|\bpre[-\s]?slab\b|\bpreslab\b|\bbora[-\s]?care\b|\bborate\b|\bwood\s+treatment\b/i },
  { key: 'rodent', label: 'Rodent Control Service', re: /\brodents?\b|\brats?\b|\bmouse\b|\bmice\b|\bbait\s+stations?\b/i },
  { key: 'wildlife', label: 'Wildlife Control Service', re: /\bwildlife\b|\braccoons?\b|\bsquirrels?\b|\bo?possums?\b|\barmadillos?\b/i },
  { key: 'wdo', label: 'WDO Inspection Service', re: /\bwdo\b|\bwood[\s-]?destroying\b/i },
];

// Termite wording that means WORK, not the lender's inspection — this is what
// keeps "+ Termite Service" alive next to a WDO match. Patterns bind the
// treatment cue DIRECTLY to the termite mention ("termite treatment",
// "liquid termite …", "treat the termites", product/method names) — loose
// proximity windows made "pest treatment plus a termite inspection" read as
// termite work (codex P1).
const TERMITE_TREATMENT_RE = /\btermites?\s+(?:pre[-\s]?)?treat\w*\b|\b(?:liquid|spot)\s+termite\b|\btermite\s+(?:bait(?:ing|s)?|trench\w*|foam\w*|fumigat\w*|tent\w*|barrier|perimeter)\b|\b(?:treat(?:ing|ment)?s?|kill(?:ing)?|get\s+rid\s+of)\s+(?:for\s+)?(?:the\s+)?(?:(?:drywood|subterranean|formosan|dampwood|flying|swarming)\s+)?termites?\b|\btent\w*\s+(?:for\s+)?termites?\b|\btermidor\b|\btermiticide\b|\bpre[-\s]?slab\b|\bpreslab\b|\btermite\s+service\b|\bbora[-\s]?care\b|\bborate\b|\bwood\s+treatment\b/i;
// ("termite service" — incl. the canonical "+ Termite Service" tail the V2
// backfill carries forward — counts as work: it only ever got composed
// because treatment wording passed this gate on the original scan, and a
// caller asking for "termite service" means work, not the lender's report.)

// Location phrases are pest CONTEXT, not service requests: "fire ants in the
// lawn" is an ant call, not a lawn-care request. Strip preposition + article/
// possessive + place before scanning (the article is REQUIRED so "interested
// in lawn care" — no article — survives untouched).
// Article optional (codex P2: "around palm trees", "in lawn"), but a place
// noun followed by care/service/etc is a REQUEST, not a location — the
// lookahead keeps "interested in lawn care" intact.
// Location noun phrase, shared by the base match and the coordinated tail:
// "around the bushes AND SHRUBS" is one location phrase — without the tail,
// the leftover "shrubs" reads as a Tree & Shrub request (codex P2). Whether
// a candidate is location or REQUEST is decided by what follows it (a
// replacer callback, not a lookahead — backtracking let "in lawn and shrub
// care" shrink to a bare "in lawn" location and eat the lawn request, codex
// r4): a service word right after the phrase, or a coordinated "…and X
// service/care" continuation, marks the whole thing a request and keeps it.
const LOC_ARTICLE = '(?:(?:the|my|our|his|her|their|a|an|some)\\s+)?';
const LOC_NOUN = '(?:front\\s+|back\\s+)?(?:palm\\s+)?(?:lawns?|yards?|grass|gardens?|kitchens?|houses?|homes?|garages?|attics?|bathrooms?|bedrooms?|lanais?|porch(?:es)?|patios?|walls?|ceilings?|crawl\\s?spaces?|trees?|shrubs?|bush(?:es)?|palms?)';
const LOCATION_PHRASE_RE = new RegExp(
  `\\b(?:in|on|around|near|under|inside|behind|throughout)\\s+${LOC_ARTICLE}${LOC_NOUN}`
  + `(?:\\s+(?:and|or|&)\\s+${LOC_ARTICLE}${LOC_NOUN})*\\b`,
  'gi',
);
const SERVICE_WORD_AFTER_RE = /^\s+(?:care|service|program|treatment|maintenance)s?\b|^\s+(?:and|or|&)\b[^.;,]{0,40}?\b(?:care|service|program|treatment|maintenance)s?\b/i;
function stripLocationPhrases(s) {
  return s.replace(LOCATION_PHRASE_RE, (match, offset, whole) => (
    SERVICE_WORD_AFTER_RE.test(whole.slice(offset + match.length)) ? match : ' '
  ));
}

// Declined services are not requests: "pest control only, not lawn care"
// must not grow a lawn tail. Scope: from a negator to the end of its
// SEGMENT, where segments break on sentence enders and contrast markers
// (but/however/except, dashes) — so a coordinated negated list ("don't need
// lawn, mosquito, or termite") drops whole, while a positive after a
// contrast ("not lawn but mosquito control", "…—pest only") survives. A
// bare comma does NOT end the negation (that's how lists were leaking), but
// a comma followed by a non-list continuation like "just …" reads as a new
// segment via the contrast split below.
const NEGATOR_RE = /\b(?:no(?![-\s]?see)|not(?!\s+(?:only|just)\b)|without|never|don['’]?t\s+(?:want|need)|doesn['’]?t\s+(?:want|need)|no\s+longer\s+(?:wants?|needs?)|not\s+interested\s+in|skip(?:ping)?|declined?)\b/i; // no(?!-see): "no-see-ums" is a pest; not(?! only|just): "not only/just X but also Y" requests BOTH
const SEGMENT_SPLIT_RE = /[.;!?]|—|–|\s--\s|\b(?:but|however|except|although|though)\b|,\s*(?=(?:just|only|plus|also|and\s+(?:also|then)|(?:i|we)\s+(?:need|want|do)|need|want)\b)/gi;
function stripNegatedClauses(s) {
  return s
    .split(SEGMENT_SPLIT_RE)
    .map((seg) => {
      const at = seg.search(NEGATOR_RE);
      return at === -1 ? seg : seg.slice(0, at);
    })
    .join(' ');
}

// "termite extermination" is ONE service — rewrite the exterminat token to
// "treatment" when it is bound to a specific family word so it can't add a
// generic pest tail (codex P2) while STAYING treatment evidence for the
// WDO⇄termite lane check ("WDO report and termite extermination" must keep
// the termite work — codex PR P2). A standalone "exterminator" still counts
// as pest.
const SPECIFIC_EXTERMINATE_RE = /\b(termites?|rodents?|rats?|mice|mouse|bed\s*bugs?|bedbugs?|mosquito(?:es|s)?|fleas?|roach(?:es)?|ants?|wdo)\s+exterminat\w*/gi;
const EXTERMINATE_FOR_RE = /\bexterminat\w*\s+(?:for\s+)?(?:the\s+)?(?=termites?\b|rodents?\b|rats?\b|mice\b|bed\s*bugs?\b|bedbugs?\b|mosquito)/gi;
const normalizeExterminator = (s) => s.replace(SPECIFIC_EXTERMINATE_RE, '$1 treatment').replace(EXTERMINATE_FOR_RE, 'treat ');

// Turf pests are a LAWN problem, not a second pest-control service: "chinch
// bugs" / "mole crickets" with a lawn match must not invent a pest tail.
// Normalize the compounds to the word "lawn" before the family scan.
const LAWN_PEST_RE = /\bchinch\s+bugs?\b|\bmole\s+crickets?\b|\bsod\s?web\s?worms?\b|\barmy\s?worms?\b|\bgrub\s?worms?\b|\bgrubs?\b|\blawn\s+(?:pests?|insects?|bugs?)\b|\bturf\s+(?:pests?|insects?|bugs?)\b/gi;
const normalizeLawnPests = (s) => s.replace(LAWN_PEST_RE, ' lawn ');

// Families mentioned in `text`, ordered by where the caller said them.
function familiesIn(text) {
  const s = cleanText(text);
  if (!s) return [];
  return SERVICE_FAMILIES
    .map((fam) => ({ fam, at: s.search(fam.re) }))
    .filter((hit) => hit.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.fam);
}

function composeServiceInterest(extracted = {}) {
  const matched = cleanText(extracted.matched_service);
  if (!matched) return null;

  // Everything the catalog match (and the booking-grade specific service,
  // which outranks it) already represents is covered — never re-append it.
  const covered = new Set();
  for (const source of [matched, cleanText(extracted.specific_service_name)]) {
    // Normalize turf-pest catalog names first: a "Chinch Bug Treatment" /
    // "Lawn Pest Control" match covers LAWN, not the generic pest family —
    // else "lawn pests and roaches inside" never gets its pest tail (codex P2).
    for (const fam of familiesIn(normalizeLawnPests(source || ''))) covered.add(fam.key);
  }

  const requested = cleanText(extracted.requested_service);
  const scanText = requested
    ? normalizeExterminator(normalizeLawnPests(stripLocationPhrases(stripNegatedClauses(requested))))
    : null;
  // Order-independent wdo↔termite: whether the WDO shows up in the match OR
  // anywhere in the request, non-treatment termite wording is the same lane
  // (the lender's "termite inspection" IS the WDO) — suppress it regardless
  // of which one the caller said first. Explicit termite TREATMENT wording
  // stays visible (distinct billable work).
  const wdoPresent = covered.has('wdo')
    || (scanText ? SERVICE_FAMILIES.find((f) => f.key === 'wdo').re.test(scanText) : false);
  let label = matched;
  for (const fam of familiesIn(scanText)) {
    if (covered.has(fam.key)) continue;
    if (fam.key === 'termite' && wdoPresent && !TERMITE_TREATMENT_RE.test(scanText)) continue;
    covered.add(fam.key);
    const next = `${label} + ${fam.label}`;
    if (next.length > 255) break; // leads.service_interest is varchar(255)
    label = next;
  }
  return label;
}

module.exports = { composeServiceInterest };
