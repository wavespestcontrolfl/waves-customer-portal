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
  { key: 'pest', label: 'Pest Control Service', re: /\bpests?\b|(?<!\bbed\s)\bbugs?\b|\binsects?\b|\broach(?:es)?\b|\bcockroach(?:es)?\b|\bants?\b|\bspiders?\b|\bwasps?\b|\bhornets?\b|\byellow\s?jackets?\b|\bbees?\b|\bfleas?\b|\bticks?\b|\bsilverfish\b|\bearwigs?\b|\bmillipedes?\b|\bcentipedes?\b|\bpalmetto\s+bugs?\b|\bscorpions?\b|\bflies\b|\bfly\b|\bgnats?\b|\bmidges?\b|\bcrickets?\b|\bexterminat/i },
  { key: 'bed_bug', label: 'Bed Bug Treatment', re: /\bbed\s*bugs?\b|\bbedbugs?\b/i },
  { key: 'lawn', label: 'Lawn Care Service', re: /\blawns?\b|\bturf\b|\bgrass\b|\bfertili[sz](?:e|er|ation|ing)?\b|\bweeds?\b|\bchinch\b|\bsod\b|\bfungus\b(?!\s*gnats?)|\bfungal\b/i },
  { key: 'tree_shrub', label: 'Tree & Shrub Care Service', re: /\btrees?\b|\bshrubs?\b|\bornamentals?\b|\bpalms?\b/i },
  { key: 'mosquito', label: 'Mosquito Control Service', re: /\bmosquito(?:es|s)?\b/i },
  { key: 'termite', label: 'Termite Service', re: /\btermites?\b|\btermidor\b|\btermiticide\b|\bpre[-\s]?slab\b|\bpreslab\b/i },
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
const TERMITE_TREATMENT_RE = /\btermites?\s+(?:pre[-\s]?)?treat\w*\b|\b(?:liquid|spot)\s+termite\b|\btermite\s+(?:bait(?:ing|s)?|trench\w*|foam\w*|fumigat\w*|tent\w*|barrier|perimeter)\b|\b(?:treat(?:ing)?|kill(?:ing)?|get\s+rid\s+of)\s+(?:the\s+)?termites?\b|\btent\w*\s+(?:for\s+)?termites?\b|\btermidor\b|\btermiticide\b|\bpre[-\s]?slab\b|\bpreslab\b/i;

// Location phrases are pest CONTEXT, not service requests: "fire ants in the
// lawn" is an ant call, not a lawn-care request. Strip preposition + article/
// possessive + place before scanning (the article is REQUIRED so "interested
// in lawn care" — no article — survives untouched).
const LOCATION_PHRASE_RE = /\b(?:in|on|around|near|under|inside|behind|throughout)\s+(?:the|my|our|his|her|their)\s+(?:front\s+|back\s+)?(?:lawns?|yards?|grass|gardens?|kitchens?|houses?|homes?|garages?|attics?|bathrooms?|bedrooms?|lanais?|porch(?:es)?|patios?|walls?|ceilings?|crawl\s?spaces?|trees?|shrubs?|bush(?:es)?)\b/gi;
const stripLocationPhrases = (s) => s.replace(LOCATION_PHRASE_RE, ' ');

// Declined services are not requests: "pest control only, not lawn care"
// must not grow a lawn tail. Scope: from a negator to the end of its
// SEGMENT, where segments break on sentence enders and contrast markers
// (but/however/except, dashes) — so a coordinated negated list ("don't need
// lawn, mosquito, or termite") drops whole, while a positive after a
// contrast ("not lawn but mosquito control", "…—pest only") survives. A
// bare comma does NOT end the negation (that's how lists were leaking), but
// a comma followed by a non-list continuation like "just …" reads as a new
// segment via the contrast split below.
const NEGATOR_RE = /\b(?:no|not|without|never|don['’]?t\s+(?:want|need)|doesn['’]?t\s+(?:want|need)|no\s+longer\s+(?:wants?|needs?)|not\s+interested\s+in|skip(?:ping)?|declined?)\b/i;
const SEGMENT_SPLIT_RE = /[.;!?]|—|–|\s--\s|\b(?:but|however|except|although|though)\b|,\s*(?=(?:just|only|plus|also|and\s+(?:also|then))\b)/gi;
function stripNegatedClauses(s) {
  return s
    .split(SEGMENT_SPLIT_RE)
    .map((seg) => {
      const at = seg.search(NEGATOR_RE);
      return at === -1 ? seg : seg.slice(0, at);
    })
    .join(' ');
}

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
    for (const fam of familiesIn(source)) covered.add(fam.key);
  }

  const requested = cleanText(extracted.requested_service);
  const scanText = requested
    ? normalizeLawnPests(stripLocationPhrases(stripNegatedClauses(requested)))
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
