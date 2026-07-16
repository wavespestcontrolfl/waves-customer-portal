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
  { key: 'pest', label: 'Pest Control Service', re: /\bpests?\b|(?<!\bbed[\s-])\bbugs?\b|(?<!\bstinging\s)\binsects?\b|\broach(?:es)?\b|\bcockroach(?:es)?\b|\bants?\b|\bspiders?\b|\bsilverfish\b|\bearwigs?\b|\bmillipedes?\b|\bcentipedes?\b|\bpalmetto\s+bugs?\b|\bscorpions?\b|\bflies\b|\bfly\b|\bgnats?\b|\bcrickets?\b|\bexterminat/i },
  // Flea/tick work is its own catalog job (flea elimination packages) —
  // "pest program plus a flea treatment" must surface it (codex r16).
  { key: 'flea', label: 'Flea Control Service', re: /\bfleas?\b|\bticks?\b/i },
  // Stinging work is its own catalog/pricing lane (Bee / Wasp Nest Removal)
  // — "quarterly pest plus a wasp nest" must surface it, not vanish into
  // the already-covered generic pest family (codex r12).
  { key: 'stinging', label: 'Bee / Wasp Nest Removal Service', re: /\bwasps?\b|\bhornets?\b|\byellow\s?jackets?\b|\bbees?\b|\bstinging\s+insects?\b/i },
  // Exclusion work is selected and priced separately from rodent control.
  { key: 'exclusion', label: 'Rodent Exclusion', re: /\bexclusions?\b|\bseal(?:ing)?\s+(?:up\s+)?entry\s+points?\b/i },
  { key: 'bed_bug', label: 'Bed Bug Treatment', re: /\bbed[\s-]*bugs?\b|\bbedbugs?\b/i },
  { key: 'lawn', label: 'Lawn Care Service', re: /\blawns?\b|\bturf\b|\bgrass\b|\bfertili[sz](?:e|er|ation|ing)?\b|\bweeds?\b|\bchinch\b|\bsod\b|\bfungus\b(?!\s*gnats?)|\bfungal\b/i },
  // palm(?! rat| injection): "palm rats" are roof rats (rodent) and palm
  // injection is its own project type — neither is tree & shrub care.
  { key: 'palm_injection', label: 'Palm Injection', re: /\bpalm\s+injections?\b|\btrunk\s+injections?\b/i },
  { key: 'tree_shrub', label: 'Tree & Shrub Care Service', re: /\btrees?\b|\bshrubs?\b|\bornamentals?\b|\bpalms?\b(?!\s+(?:rats?|injections?))/i },
  // midges / no-see-ums are treated by the mosquito program in this repo
  { key: 'mosquito', label: 'Mosquito Control Service', re: /\bmosquito(?:es|s)?\b|\bmidges?\b|\bno[-\s]?see[-\s]?ums?\b/i },
  { key: 'termite', label: 'Termite Service', re: /\btermites?\b|\btermidor\b|\btermiticide\b|\bpre[-\s]?slab\b|\bpreslab\b|\bbora[-\s]?care\b|\bborate\b|\bwood\s+treatment\b/i },
  // bait station is rodent wording ONLY when not termite-qualified —
  // "termite bait stations" is a termite deliverable in this repo.
  { key: 'rodent', label: 'Rodent Control Service', re: /\brodents?\b|\brats?\b|\bmouse\b|\bmice\b|(?<!\btermites?\s(?:\w+\s){0,2})\bbait\s+stations?\b(?!\s+for\s+(?:the\s+)?(?:\w+\s+){0,2}termites?\b)/i },
  { key: 'wildlife', label: 'Wildlife Control Service', re: /\bwildlife\b|\braccoons?\b|\bsquirrels?\b|\bo?possums?\b|\barmadillos?\b/i },
  { key: 'wdo', label: 'WDO Inspection Service', re: /\bwdo\b|\bwood[\s-]?destroying\b/i },
];

// Termite wording that means WORK, not the lender's inspection — this is what
// keeps "+ Termite Service" alive next to a WDO match. Patterns bind the
// treatment cue DIRECTLY to the termite mention ("termite treatment",
// "liquid termite …", "treat the termites", product/method names) — loose
// proximity windows made "pest treatment plus a termite inspection" read as
// termite work (codex P1).
const TERMITE_TREATMENT_RE = /\btermites?\s+(?:pre[-\s]?)?treat\w*\b|\b(?:liquid|spot)\s+termite\b|\btermite\s+(?:bait(?:ing|s)?|trench\w*|foam\w*|fumigat\w*|tent\w*|barrier|perimeter)\b|\bbait\s+stations?\s+for\s+(?:the\s+)?(?:\w+\s+){0,2}termites?\b|\btermites?\s+\w+\s+bait\s+stations?\b|\b(?:treat(?:ing|ment)?s?|kill(?:ing)?|get\s+rid\s+of)\s+(?:for\s+)?(?:the\s+)?(?:(?:drywood|subterranean|formosan|dampwood|flying|swarming)\s+)?termites?\b|\btent\w*\s+(?:for\s+)?termites?\b|\btermidor\b|\btermiticide\b|\bpre[-\s]?slab\b|\bpreslab\b|\btermite\s+service\b|\bbora[-\s]?care\b|\bborate\b|\bwood\s+treatment\b|\btermites?\s+(?:control|protection|monitor\w*|prevention|program|plan|coverage|bonds?|warrant(?:y|ies))\b/i;
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
// An IMMEDIATE service word after the phrase always marks a request
// ("interested in lawn care", "in the lawn program"). A coordinated
// "…and X service" continuation only rescues an ARTICLE-LESS phrase:
// bare "in lawn and mosquito service" is service shorthand, while "ants in
// THE lawn and mosquito service" is a located pest plus a separate request —
// the article is the deterministic location marker (codex r5).
const IMMEDIATE_SERVICE_WORD_RE = /^\s+(?:care|service|program|treatment|maintenance)s?\b/i;
const COORDINATED_SERVICE_TAIL_RE = /^\s+(?:and|or|&)\b[^.;,]{0,40}?\b(?:care|service|program|treatment|maintenance)s?\b/i;
const LOCATION_HAS_ARTICLE_RE = /^\s*\w+\s+(?:the|my|our|his|her|their|a|an|some)\b/i;
// "interested in lawn" / "asking about the yard" — an interest verb right
// before the preposition marks a REQUEST, never a pest location (codex r7).
const INTEREST_BEFORE_RE = /\b(?:interested|interest|looking|inquir\w*|asking|quote[ds]?)\s*$/i;
function stripLocationPhrases(s) {
  return s.replace(LOCATION_PHRASE_RE, (match, offset, whole) => {
    if (INTEREST_BEFORE_RE.test(whole.slice(0, offset))) return match;
    const after = whole.slice(offset + match.length);
    if (IMMEDIATE_SERVICE_WORD_RE.test(after)) {
      // Article-marked AND coordinated: only the FINAL noun is bound to the
      // service word — "ants in THE lawn and shrub care" requests shrub
      // care, the lawn is where the ants are (codex r6). Article-less
      // phrases stay whole ("interested in lawn and shrub care").
      const parts = match.split(/\s+(?:and|or|&)\s+/i);
      if (parts.length > 1 && LOCATION_HAS_ARTICLE_RE.test(match)) {
        return ` ${parts[parts.length - 1]}`;
      }
      return match;
    }
    if (!LOCATION_HAS_ARTICLE_RE.test(match) && COORDINATED_SERVICE_TAIL_RE.test(after)) return match;
    return ' ';
  });
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

// Comparison declines ("instead of lawn care", "rather than mosquito
// service") scope only to their own clause — a comma ends them, so
// "pest control instead of lawn care, mosquito service too" keeps the
// mosquito request (codex r6). Stripped BEFORE segment-based negation.
const COMPARED_AWAY_RE = /\b(?:instead\s+of|rather\s+than|in\s+lieu\s+of|except(?:\s+for)?)\b[^,.;!?]*/gi;
// "except" flips meaning with a preceding negation: "pest control except
// lawn care" DECLINES lawn, but "nothing except lawn care" / "no pest,
// except lawn care" REQUESTS it (codex r9). With a negator earlier in the
// sentence, rewrite except→but so the contrast split rescues the positive.
const NEGATION_BEFORE_EXCEPT_RE = /\b(?:no|not|nothing|none|never|without|no\s+longer|don['’]?t|doesn['’]?t)\b[^.;!?]*$/i;
function stripComparedAway(s) {
  return s.replace(COMPARED_AWAY_RE, (match, offset, whole) => {
    if (/^except/i.test(match) && NEGATION_BEFORE_EXCEPT_RE.test(whole.slice(0, offset))) {
      return match.replace(/^except(?:\s+for)?/i, ' but ');
    }
    return ' ';
  });
}
// `except` is NOT here: it EXCLUDES what follows (handled by
// COMPARED_AWAY_RE), unlike but/however which rescue a positive (codex r8).
const SEGMENT_SPLIT_RE = /[.;!?]|—|–|\s--\s|\b(?:but|however|although|though)\b|,\s*(?=(?:just|only|plus|also|and\s+(?:also|then)|(?:i|we)\s+(?:need|want|do)|need|want)\b)|,\s*(?=[^,.;!?]{0,60}\b(?:too|as\s+well)\b)/gi;
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
const SPECIFIC_EXTERMINATE_RE = /\b(termites?|rodents?|rats?|mice|mouse|bed[\s-]*bugs?|bedbugs?|mosquito(?:es|s)?|fleas?|ticks?|roach(?:es)?|ants?|(?:wasps?|bees?|hornets?|yellow\s?jackets?)(?:\s+nests?)?|stinging\s+insects?|wdo)\s+exterminat\w*/gi;
const EXTERMINATE_FOR_RE = /\bexterminat\w*\s+(?:for\s+)?(?:the\s+)?(?=termites?\b|rodents?\b|rats?\b|mice\b|bed[\s-]*bugs?\b|bedbugs?\b|mosquito|wasps?\b|bees?\b|hornets?\b|yellow\s?jackets?\b|stinging\s+insects?\b)/gi;
const normalizeExterminator = (s) => s.replace(SPECIFIC_EXTERMINATE_RE, '$1 treatment').replace(EXTERMINATE_FOR_RE, 'treat ');

// "palm injection for my palms" / "trunk injection into the palms" — the
// trailing target noun is part of the SAME injection request, not a second
// tree & shrub service (codex r7). Collapse the target phrase before scanning.
const PALM_INJECTION_TARGET_RE = /\b((?:palm|trunk)\s+injections?)\s+(?:for|on|in|into)\s+(?:the\s+|my\s+|our\s+)?palms?\b/gi;
const normalizePalmInjection = (s) => s.replace(PALM_INJECTION_TARGET_RE, '$1');

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

// V2 service categories → words this composer can scan. Deliberately NOT
// mapServiceCategoryToLegacy: that legacy-routing map collapses
// palm_injection into "Tree & Shrub Care" and hard-labels termite as
// "Termite Inspection", losing the family/work distinctions this label
// carries (codex r11). Bare "termite" keeps the work-vs-inspection choice
// with the caller-text cue (opts.cueText below).
const V2_CATEGORY_COMPOSE_WORDS = {
  pest_general: 'pest control',
  termite: 'termite',
  rodent: 'rodent control',
  mosquito: 'mosquito control',
  stinging_insect: 'wasp nest',
  lawn_care: 'lawn care',
  palm_injection: 'palm injection',
  bed_bug: 'bed bugs',
  wdo: 'WDO inspection',
  exclusion: 'exclusion',
  bundled_waveguard: 'pest control',
};
function composeWordsForV2Category(category) {
  return V2_CATEGORY_COMPOSE_WORDS[category] || null;
}

// Primary LABEL for V2 categories whose legacy flatView mapping is wrong or
// null (stinging_insect → null, exclusion → coarse "Rodent Control"): when
// V2 approved one of these as the PRIMARY with no specific catalog pick,
// the family's own label leads — otherwise a wasp-only call renders as
// "General Pest Control + Bee / Wasp Nest Removal Service" (codex r15).
const V2_CATEGORY_PRIMARY_LABELS = {
  stinging_insect: 'Bee / Wasp Nest Removal Service',
  exclusion: 'Rodent Exclusion',
};
function v2PrimaryLabelForCategory(category) {
  return V2_CATEGORY_PRIMARY_LABELS[category] || null;
}

// opts.cueText: original caller wording consulted ONLY for the termite
// work-vs-inspection cue — families still come exclusively from
// requested_service, so a V2-approved category list stays authoritative
// while "termite monitoring/protection" wording keeps labeling as work.
function composeServiceInterest(extracted = {}, opts = {}) {
  const matched = cleanText(extracted.matched_service);
  if (!matched) return null;

  // Everything the catalog match (and the booking-grade specific service,
  // which outranks it) already represents is covered — never re-append it.
  const covered = new Set();
  for (const source of [matched, cleanText(extracted.specific_service_name)]) {
    // Normalize turf-pest catalog names first: a "Chinch Bug Treatment" /
    // "Lawn Pest Control" match covers LAWN, not the generic pest family —
    // else "lawn pests and roaches inside" never gets its pest tail (codex P2).
    // And a "Rodent Exclusion" label covers EXCLUSION only — the word
    // "rodent" inside it must not mark rodent-control covered, or explicit
    // "rat treatment and exclusion" text gets swallowed (codex r17).
    const coverageSource = String(source || '').replace(/\brodent\s+exclusion\b/gi, 'exclusion');
    for (const fam of familiesIn(normalizeLawnPests(coverageSource))) covered.add(fam.key);
  }

  const requested = cleanText(extracted.requested_service);
  const scanText = requested
    ? normalizeExterminator(normalizePalmInjection(normalizeLawnPests(stripLocationPhrases(stripNegatedClauses(stripComparedAway(requested))))))
    : null;
  // Order-independent wdo↔termite: whether the WDO shows up in the match OR
  // anywhere in the request, non-treatment termite wording is the same lane
  // (the lender's "termite inspection" IS the WDO) — suppress it regardless
  // of which one the caller said first. Explicit termite TREATMENT wording
  // stays visible (distinct billable work).
  const wdoPresent = covered.has('wdo')
    || (scanText ? SERVICE_FAMILIES.find((f) => f.key === 'wdo').re.test(scanText) : false);
  const cueText = cleanText(opts.cueText);
  const termiteWorkCue = (scanText && TERMITE_TREATMENT_RE.test(scanText))
    || (cueText && TERMITE_TREATMENT_RE.test(cueText));
  // An inspection-only legacy match ("Termite Inspection") covers the
  // termite FAMILY but not requested termite WORK — a caller asking for
  // monitoring/protection on top of it gets the work appended, not
  // silently swallowed by the covered-family skip (codex r12).
  const matchedTermiteWorkCue = TERMITE_TREATMENT_RE.test(
    [matched, cleanText(extracted.specific_service_name)].filter(Boolean).join(' '),
  );
  // Exclusion-only wording ("rodent exclusion", "seal entry points for
  // rats") is ONE deliverable — the rodent nouns inside it must not add a
  // second trapping/control service unless the text carries rodent-work
  // evidence of its own (codex r14; catalog models exclusion-only apart
  // from trapping+exclusion).
  const scanFamilies = familiesIn(scanText);
  const exclusionPresent = scanFamilies.some((f) => f.key === 'exclusion');
  // Work evidence must be BOUND to the rodent nouns, not request-wide — a
  // lawn "treatment" elsewhere in the sentence is not rodent work (codex
  // r17): rodent noun adjacent (±1 word) to a work verb, or the reverse.
  const rodentWorkEvidence = scanText
    ? /\b(?:rodents?|rats?|mice|mouse)\s+(?:\w+\s+)?(?:trap\w*|bait\w*|remov\w*|treat\w*|exterminat\w*|control|infestation\w*)\b|\b(?:trap\w*|bait\w*|remov\w*|treat\w*|exterminat\w*)\s+(?:for\s+)?(?:the\s+)?(?:rodents?|rats?|mice|mouse)\b|\brodent\s+control\b|\bdroppings?\b/i.test(scanText)
    : false;
  let label = matched;
  for (const fam of scanFamilies) {
    if (fam.key === 'rodent' && exclusionPresent && !rodentWorkEvidence) continue;
    if (covered.has(fam.key)) {
      if (!(fam.key === 'termite' && termiteWorkCue && !matchedTermiteWorkCue)) continue;
    }
    if (fam.key === 'termite' && wdoPresent && !termiteWorkCue) continue;
    // Same lane, reverse direction: an inspection-only termite PRIMARY
    // ("Termite Inspection") already IS the WDO deliverable — a requested
    // WDO report must not render as a second inspection (codex r17).
    // A work-cued termite primary keeps the WDO tail (distinct deliverable).
    if (fam.key === 'wdo' && covered.has('termite') && !matchedTermiteWorkCue) continue;
    covered.add(fam.key);
    // Inspection-only termite wording ("pest control and termite inspection
    // for VA loan") is the inspection deliverable, not treatment work —
    // label it as such so the office doesn't price a treatment (codex r7).
    const famLabel = fam.key === 'termite' && !termiteWorkCue
      ? 'Termite Inspection'
      : fam.label;
    const next = `${label} + ${famLabel}`;
    if (next.length > 255) break; // leads.service_interest is varchar(255)
    label = next;
  }
  return label;
}

// Every label composeServiceInterest can APPEND (family labels plus the
// dynamic termite pair). primaryServiceInterest strips these known tails
// from the END of a stored label — never splitting on a bare " + ", which
// would truncate plus-named catalog primaries like "Lawn + Tree & Shrub"
// (codex r14). Attribution and other single-service consumers use this.
const COMPOSED_TAIL_LABELS = new Set([
  ...SERVICE_FAMILIES.map((f) => f.label),
  'Termite Inspection',
  'Termite Service',
]);
function primaryServiceInterest(value) {
  let label = String(value == null ? '' : value).trim();
  for (;;) {
    const at = label.lastIndexOf(' + ');
    if (at === -1) break;
    const tail = label.slice(at + 3).trim();
    if (!COMPOSED_TAIL_LABELS.has(tail)) break;
    label = label.slice(0, at).trim();
  }
  return label || String(value == null ? '' : value);
}

// Families the V2 category enum CANNOT express (no tree/shrub or wildlife
// category in call-extraction.model-output.schema.json). Under V2 approval
// the category list is authoritative for everything it CAN express, but
// these families may only exist in the V1 caller text — scan it for just
// them so "pest control and shrub care" survives V2 routing (codex r14,
// reconciling r12's no-V1-fallback rule with the enum gap).
const V2_INEXPRESSIBLE_FAMILY_KEYS = new Set(['tree_shrub', 'wildlife', 'flea']);
function v2InexpressibleFamilyWords(callerText) {
  const requested = cleanText(callerText);
  if (!requested) return null;
  const scan = normalizeExterminator(normalizePalmInjection(normalizeLawnPests(
    stripLocationPhrases(stripNegatedClauses(stripComparedAway(requested))),
  )));
  const words = familiesIn(scan)
    .filter((fam) => V2_INEXPRESSIBLE_FAMILY_KEYS.has(fam.key))
    .map((fam) => fam.label);
  return words.length ? words.join(' and ') : null;
}

module.exports = {
  composeServiceInterest,
  composeWordsForV2Category,
  v2PrimaryLabelForCategory,
  primaryServiceInterest,
  v2InexpressibleFamilyWords,
};
