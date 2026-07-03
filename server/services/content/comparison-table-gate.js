/**
 * comparison-table-gate.js — keeps the autonomous writer's <ComparisonTable>
 * "buyer's-guide listicle" honest.
 *
 * The writer may anchor a comparison / "how to choose" / "best [service] in
 * [city]" post on a <ComparisonTable> (see agents/writer-agent-config.js). This
 * is the constrained, honest version of the AI-citation "listicle play": it
 * earns that demand by HELPING the reader choose, never by faking a ranking or
 * trashing competitors.
 *
 * SCOPE: drafts that embed a <ComparisonTable> get the FULL regime — the
 * competitor / disparagement / ranking checks scan the whole body PLUS the
 * title/meta (the public legal surface), and the option-column classification
 * FAILS CLOSED on anything that is not a recognized provider CATEGORY, Waves,
 * or a curated allowlist competitor.
 *
 * Drafts WITHOUT a table are no longer waved through: they get the NAMED-
 * TARGET legal scan (evaluateProse below). Defamation needs a target, and a
 * table-less draft was previously never scanned at all — "Acme Pest Solutions
 * is dishonest" in ordinary prose passed every gate. Category negativity with
 * no named business ("store-bought sprays are useless", consumer-protection
 * prose like "avoid pest control scams") deliberately does NOT trip it.
 *
 * NAMED competitors are doubly guarded: the gate enforces allowlist + per-table
 * sourced attribution + only-curated-facts + no-disparagement/ranking, AND a
 * draft that names any competitor sets requiresHumanReview so the runner routes
 * it to the (approvable) human-review queue instead of auto-publishing.
 *
 *   P0 COMPARISON_DISPARAGEMENT          — derogatory language about a provider
 *   P0 COMPARISON_UNKNOWN_COMPETITOR     — recognized competitor not on allowlist
 *   P1 COMPARISON_UNCLASSIFIED_OPTION    — business-looking name, not category/Waves/allowlisted
 *   P1 COMPARISON_RIGGED_RANKING         — self-declared "winner" / superlative
 *   P1 COMPARISON_NEGATIVE_RELIABILITY   — negative service claim about a provider
 *   P1 COMPARISON_NAMED_COMPETITOR_DISABLED   — names a competitor while gated off
 *   P1 COMPARISON_COMPETITOR_UNSOURCED        — named competitor without its own
 *                                          attributed ("as of"+source) table caption
 *   P1 COMPARISON_UNSUPPORTED_COMPETITOR_FACT — a named competitor's row states a
 *                                          fact that is not a curated attribute
 *
 * Returns { pass, findings, requiresHumanReview }. P0/P1 block (route to review).
 */

const competitorFacts = require('./competitor-facts');

// Derogatory language about a provider — block outright. Limited to terms that
// are almost exclusively business-disparagement; pest/efficacy words ("garbage",
// "worst infestation") are excluded here. Evaluative negatives ("worst") are
// caught TABLE-SCOPED below where they are provider-directed.
const DISPARAGEMENT_RE = /\b(scams?|rip[\s-]?offs?|ripoffs?|overpriced|goug\w*|incompetent|shady|sketchy|dishonest|untrustworthy|crooks?|frauds?|fraudulent|hidden fees?|bait[\s-]and[\s-]switch|lousy|sloppy|clueless|second[\s-]?rate)\b/i;

// Evaluative negatives that are fine in prose ("worst infestation") but are
// provider-disparagement inside a comparison table cell ("Worst follow-up").
const TABLE_DISPARAGEMENT_RE = /\b(worst|terrible|awful|horrible|useless|inferior|sub[\s-]?par|pathetic|mediocre)\b/i;

// Provider-DIRECTED disparagement anywhere in the draft (incl. title/meta/prose),
// where an evaluative negative is tied to a provider noun — "worst pest control
// companies", "national chains are unreliable". Targeted (adj adjacent to a
// provider noun, either order) so "worst infestation" / "the best time" don't trip.
const NEG_ADJ = 'worst|terrible|awful|horrible|unreliable|useless|inferior|sub[\\s-]?par|pathetic|mediocre|lousy|sloppy|incompetent|shady|dishonest|untrustworthy';
const PROVIDER_NOUN = 'pest control|exterminators?|lawn (?:care|service)|compan(?:y|ies)|providers?|chains?|services?|businesses?|operators?|outfits?';
const PROVIDER_DISPARAGEMENT_RE = new RegExp([
  `\\b(?:${NEG_ADJ})\\b(?:\\s+\\w+){0,2}\\s+\\b(?:${PROVIDER_NOUN})\\b`,
  `\\b(?:${PROVIDER_NOUN})\\b(?:\\s+\\w+){0,3}\\s+(?:are|is|were|was|seem|seems|tend to be|can be|get|got)\\b(?:\\s+\\w+){0,2}\\s+\\b(?:${NEG_ADJ})\\b`,
].join('|'), 'i');

// Negative service-reliability claims about a provider. Flagged inside table
// blocks OR in prose/title/meta when within PROXIMITY of a named competitor.
const PROVIDER_NEGATIVE_RE = /\b(unreliable|unresponsive|no[\s-]?shows?|never (?:answers?|calls?|shows?)\b|hard to reach|leaves? you waiting|ghosts? you|won'?t call (?:you )?back|don'?t show up)\b/i;

// ACTIVE disparaging predicates — verb-plus-victim shapes ("scams customers",
// "charges hidden fees") for the generic-name directed scan. The victim object
// (or the fee/bait idiom) is REQUIRED so title-case noun uses stay clean:
// "How to Avoid Pest Control Scams in Sarasota" captures the business-shaped
// "Avoid Pest Control" but "Scams in" has no victim, so it does not trip.
const DISPARAGEMENT_VICTIM = "(?:its\\s+|their\\s+)?(?:customers?|clients?|homeowners?|residents?|seniors?|people|folks|you\\b)";
const ACTIVE_DISPARAGEMENT_SRC = [
  `scams?\\s+${DISPARAGEMENT_VICTIM}`,
  `rips?\\s+${DISPARAGEMENT_VICTIM}\\s+off`,
  `rips?\\s+off\\s+${DISPARAGEMENT_VICTIM}`,
  `gouges?\\s+(?:${DISPARAGEMENT_VICTIM}|prices)`,
  `overcharges?(?:\\s+(?:${DISPARAGEMENT_VICTIM}|for\\b))?`,
  'charges?\\s+hidden\\s+fees?',
  `cheats?\\s+${DISPARAGEMENT_VICTIM}`,
  `deceives?\\s+${DISPARAGEMENT_VICTIM}`,
  `lies\\s+to\\s+${DISPARAGEMENT_VICTIM}`,
  `defrauds?\\s+${DISPARAGEMENT_VICTIM}`,
  'pulls?\\s+(?:a\\s+)?bait[\\s-]and[\\s-]switch',
  'uses?\\s+bait[\\s-]and[\\s-]switch',
].join('|');
const PROVIDER_NEGATIVE_PROXIMITY = 90; // chars between a reliability term and a competitor name

// Self-declared ranking / superlative framing. Scanned over body + title/meta,
// so prose-safe: "best/top" only fire with a ranking context, never "the best
// time to treat" or "best pest control method".
const RANKING_RE = new RegExp([
  '#\\s?1\\b',
  '\\bno\\.?\\s?1\\b',
  '\\bnumber one\\b',
  '\\btop[\\s-]?rated\\b',
  '\\bunbeatable\\b',
  '\\bbest[\\s-]in[\\s-]class\\b',
  '\\bhands[\\s-]down\\b',
  '\\bclear winner\\b',
  '\\bthe winner\\b',
  '\\bsuperior to\\b',
  '\\bbetter than (?:everyone|the rest|all others|the competition|any other)\\b',
  '\\bcrush\\w* the competition\\b',
  '\\bbest in (?:town|the area|swfl|southwest florida|florida|venice|sarasota|bradenton|manatee|charlotte|parrish|palmetto|north port)\\b',
  // "(the) best/top [adj] pest control/exterminator/lawn care" + ranking tail
  '\\b(?:the\\s+)?(?:best|top)\\s+(?:\\w+\\s+){0,2}(?:pest control|exterminators?|lawn (?:care|service))\\s+(?:company|companies|provider|service|choice|in|around|near)\\b',
  // "(the) best/top (pest control) company/provider/choice in/around/near"
  '\\b(?:the\\s+)?(?:best|top)\\s+(?:pest[\\s-]control\\s+)?(?:company|provider|choice)\\s+(?:in|around|near)\\b',
  // standalone self-ranking: "the best." / "the top choice" / "the best option"
  '\\bthe best\\b(?=\\s*(?:[.!?,;:)\\]"\\u2019\']|$))',
  '\\bthe (?:best|top) (?:choice|option|pick)\\b',
].join('|'), 'i');

// Generic descriptors / methodologies that may precede a pest-industry suffix in
// PROSE but are not a business name.
// Generic descriptors / methodologies only. Geographic terms (Florida,
// Sarasota, Manatee, Venice, …) are deliberately NOT excluded: "Sarasota Pest
// Control" is a business-name pattern, not a generic phrase, so a location lead
// + industry suffix in prose/title must still be flagged for review.
const GENERIC_LEAD_EXCLUSIONS = 'Professional|Local|Quality|Affordable|Best|Reliable|Trusted|Expert|Licensed|Insured|Residential|Commercial|Pest|Lawn|Green|Safe|Eco|Modern|Premier|Quarterly|Monthly|Annual|Seasonal|Same|Top|Your|Our|The|This|That|These|Those|A|An|Integrated|Sustainable|Comprehensive|Targeted|Routine|Ongoing|Effective|Proper|Smart|Organic|Natural|General|Basic|Standard|Custom|Year';
// Broad pest-industry suffix set so business names with less-common suffixes
// (e.g. "HomeTeam Pest Defense", "Gulf Coast Termite Specialists") are still
// recognized — a proper-noun lead + any of these.
const INDUSTRY_SUFFIX_SRC = '(?:Pest|Termite|Bug|Lawn|Mosquito|Wildlife)\\s+(?:Control|Management|Solutions?|Services?|Defen[sc]e|Prevention|Elimination|Experts?|Pros?|Patrol|Squad|Busters?|Brigade|Specialists?|Defenders?)|Exterminators?|Exterminating|Termite (?:&|and) Pest|Environmental(?: Pest)?|Lawn (?:&|and) Pest';
const PROVIDER_NAME_SRC = `\\b((?!(?:${GENERIC_LEAD_EXCLUSIONS})\\b)[A-Z][A-Za-z0-9&'.\\-]*(?:\\s+(?:[A-Z][A-Za-z0-9&'.\\-]*|of|and|&)){0,3}\\s+(?:${INDUSTRY_SUFFIX_SRC}))\\b`;
function providerNameRe(flags) { return new RegExp(PROVIDER_NAME_SRC, flags); }

// A legal-entity-marked business name ("Bob's Bugs LLC", "Acme Exterminators Inc")
// anywhere in the draft — used to fail closed on business-looking names that
// carry no pest-industry suffix but a company marker. Possessive-only names are
// NOT scanned in prose (too noisy: "Florida's climate"); they are caught in
// option headers by classifyOption().
const LEGAL_ENTITY_NAME_SRC = `\\b([A-Z][A-Za-z0-9&'.\\-]*(?:\\s+[A-Za-z0-9&'.\\-]+){0,3}\\s+(?:LLC|L\\.L\\.C\\.|Inc\\.?|Incorporated|Corp\\.?|Co\\.|Bros\\.?|Brothers|& Sons?))\\b`;
function legalEntityRe(flags) { return new RegExp(LEGAL_ENTITY_NAME_SRC, flags); }

const INDUSTRY_SUFFIX_RE = new RegExp(`\\b(${INDUSTRY_SUFFIX_SRC})\\b`, 'i');
const BUSINESS_MARKER_RE = /\b[A-Z][a-z]+'s\b|\b(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Co\.|Bros\.?|Brothers|& Sons?)\b/;
const CATEGORY_OPTION_RE = /\b(national|nationwide|chains?|franchises?|big[\s-]?box|corporate|regional|local(?:ly)?|independent|small(?:er)?|diy|do[\s-]it[\s-]yourself|self[\s-]?treat\w*|home(?:owner)?|store[\s-]bought|over[\s-]the[\s-]counter|professionals?|pros?|quarterly|monthly|annual|seasonal|one[\s-]?time|one[\s-]?off|recurring|reactive|preventive|preventative|on[\s-]demand|subscription|plans?|programs?|packages?|services?|options?|untreated|no treatment|ignoring it|what (?:to|you))\b/i;
const OWN_BRAND_RE = /\bwaves\b/i;

// Cell value affirms the row criterion → the CLAIM is the row label (so an
// uncurated row label like "Free termite inspections | Free" is validated, not
// waved through as a neutral mark).
const AFFIRMATIVE_CELL_RE = /^(yes|y|✓|✔|included|standard|available|offered|both|always|free|✅)$/i;
// Cell value is a truly NEUTRAL / non-asserting mark → no factual claim.
const NEUTRAL_CELL_RE = /^(n\/?a|none|n\.a\.|—|–|-|\*|varies|varies?\.?|quote[\s-]?based|optional|sometimes|limited|tbd|maybe|\$+)$/i;
// Cell value is a NEGATIVE mark — asserts the option LACKS the row's criterion.
// Harmless on a neutral feature row, but on a service-reliability/quality row
// it becomes a negative-reliability claim about a NAMED competitor (e.g.
// "Orkin — Answers the phone: Never"), which must route to human review rather
// than be silently waved through.
const NEGATIVE_CELL_RE = /^(no|n|never|✗|✘|x|❌)$/i;
// Row labels whose NEGATION reads as a provider service-reliability / quality
// claim. A negative cell under a named competitor on one of these is flagged.
const RELIABILITY_LABEL_RE = /\b(answers?|responds?|responsive|response|reachable|shows?\s?up|on[\s-]?time|punctual|reliab\w*|guarantee\w*|warrant\w*|call[\s-]?backs?|callbacks?|honors?|keeps?\s+appointments?|same[\s-]?day|emergency|24\/?7|availab\w*)\b/i;

function finding(severity, code, message) {
  return { severity, code, message };
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractComparisonBlocks(body) {
  const text = String(body || '');
  const blocks = [];
  const re = /<ComparisonTable\b[\s\S]*?(?:\/>|<\/ComparisonTable>)/gi;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[0]);
  return blocks;
}

// A quoted string LITERAL that tolerates escaped quotes: the (?:\\.|…)
// alternation consumes an escaped char so `'Keller\'s Pest Control'` is read in
// full rather than truncated at the \'. Group 1 = quote char, group 2 = body.
const QUOTED_STR = "(['\"])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1";
function unescapeStr(s) { return String(s).replace(/\\(.)/g, '$1'); }
// Pull all quoted-string literals (unescaped) out of an array/fragment.
function quotedStrings(fragment) {
  const out = [];
  const re = new RegExp(QUOTED_STR, 'g');
  let m;
  while ((m = re.exec(String(fragment || ''))) !== null) out.push(unescapeStr(m[2]));
  return out;
}

function extractCaption(block) {
  const m = String(block || '').match(new RegExp(`caption\\s*=\\s*\\{?\\s*${QUOTED_STR}`, 'i'));
  return m ? unescapeStr(m[2]) : '';
}

function extractColumns(block) {
  const m = String(block || '').match(/columns\s*=\s*\{?\s*\[([\s\S]*?)\]/i);
  return m ? quotedStrings(m[1]) : [];
}

// Parse row objects ORDER-INSENSITIVELY and regardless of QUOTED keys: match
// each { … } that contains a values:[…] array (row objects carry no nested
// braces), then pull label + values independently of their order, any extra
// props, or whether the keys are bare (values:) or quoted ("values":).
function extractRows(block) {
  const rows = [];
  const objRe = /\{[^{}]*["']?values["']?\s*:\s*\[[^\]]*\][^{}]*\}/g;
  let m;
  while ((m = objRe.exec(String(block || ''))) !== null) {
    const obj = m[0];
    const labelM = obj.match(new RegExp(`["']?label["']?\\s*:\\s*${QUOTED_STR}`));
    const valsM = obj.match(/["']?values["']?\s*:\s*\[([\s\S]*?)\]/);
    rows.push({ label: labelM ? unescapeStr(labelM[2]) : '', values: valsM ? quotedStrings(valsM[1]) : [] });
  }
  return rows;
}

function hasAttribution(caption) {
  const c = String(caption || '');
  if (!c) return false;
  const hasAsOf = /\bas of\b|\b(?:current|accurate|verified|updated)\s+as of\b|\bas published\b/i.test(c);
  const hasDate = /\b20\d{2}\b/.test(c)
    || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(c);
  const hasSource = /\b(source|per |according to|website|public(?:ly)?|state license|sunbiz|bbb|\.com\b|\.org\b|\.gov\b)\b/i.test(c);
  return hasAsOf && hasDate && hasSource;
}

function classifyOption(header) {
  const h = String(header || '').trim();
  if (!h) return 'category';
  // Competitor detection runs BEFORE the own-brand check: a column header that
  // names a competitor must be validated as a competitor column even when it
  // ALSO mentions Waves (e.g. "Waves vs Orkin"). Returning 'own' early there
  // would skip the competitor cells' curated-fact validation entirely. (Waves
  // is deliberately absent from the competitor detector, so a pure "Waves" /
  // "Waves Pest Control" header still falls through to 'own' below.)
  const mentions = competitorFacts.findBusinessMentions(h);
  if (mentions.some((m) => !m.inAllowlist)) return 'unknown_competitor';
  if (mentions.some((m) => m.inAllowlist)) return 'known_competitor';
  if (OWN_BRAND_RE.test(h)) return 'own';
  if (INDUSTRY_SUFFIX_RE.test(h) || BUSINESS_MARKER_RE.test(h) || providerNameRe().test(h)) return 'unclassified';
  if (CATEGORY_OPTION_RE.test(h)) return 'category';
  return 'unclassified';
}

// Negation markers — a NEGATED claim ("Not national", "No recurring plans")
// must NOT be treated as supported just because its non-negated words appear in
// a curated attribute; it asserts the OPPOSITE of the curated source.
const NEGATOR_RE = /\b(no|not|never|without|lacks?|cannot|can'?t|does\s?n'?t|do\s?n'?t|is\s?n'?t|are\s?n'?t|wo\s?n'?t|non)\b|n['’]t\b/i;

/**
 * claimSupported(text, attrValues) → true iff EVERY significant word of `text`
 * appears in a single curated attribute value (subset match). Stricter than a
 * loose substring/overlap so a curated phrase with appended uncurated text
 * ("National (US); free termite inspections") is NOT treated as supported. A
 * negated claim is supported ONLY by an explicit (near-exact) curated value.
 */
function claimSupported(text, attrValues) {
  const nt = normalize(text);
  if (!nt) return true;
  if (NEGATOR_RE.test(String(text))) {
    // Only an explicitly-curated value that itself matches the (negated) claim
    // supports it — otherwise a negation of a curated fact would slip through.
    return attrValues.some((av) => normalize(av) === nt);
  }
  const words = nt.split(' ').filter((w) => w.length > 3);
  if (!words.length) {
    // A value made only of short / numeric tokens ("24/7", "A+ rating" → "a
    // rating") is still a factual CLAIM (trivial yes/no marks are filtered by
    // the caller). Require EVERY claim token to appear as a whole token of a
    // curated value — NOT a substring, so "A+" → "a" is not "supported" by an
    // unrelated curated value like "National (US)" → "national us" via the
    // stray "a" inside "national".
    const claimTokens = nt.split(' ').filter(Boolean);
    if (!claimTokens.length) return true;
    return attrValues.some((av) => {
      const naTokens = normalize(av).split(' ').filter(Boolean);
      return claimTokens.every((t) => naTokens.includes(t));
    });
  }
  for (const av of attrValues) {
    const na = normalize(av);
    if (!na) continue;
    if (words.every((w) => na.includes(w))) return true;
  }
  return false;
}

function draftScanTexts(draft, body) {
  const fm = draft?.frontmatter || {};
  const metaText = ['title', 'meta_description', 'metaTitle', 'metaDescription']
    .map((k) => fm[k]).filter(Boolean).map(String).join('\n');
  return metaText ? `${body}\n${metaText}` : body;
}

/**
 * evaluateProse(draft, body, { operatorBriefText }) — the table-less legal
 * scan. Flags:
 *   P0 COMPARISON_DISPARAGEMENT   — a disparaging/negative term within
 *      proximity of ANY business-looking name (curated competitor, provider-
 *      suffix name, or legal-entity name)
 *   P1 COMPARISON_NEGATIVE_RELIABILITY — a service-reliability negative near
 *      a business-looking name
 *   P0 COMPARISON_UNKNOWN_COMPETITOR   — a recognized competitor NOT on the
 *      curated allowlist named anywhere (its claims can't be verified)
 *   P1 COMPARISON_COMPETITOR_IN_PROSE  — an allowlisted competitor named
 *      outside a comparison table (existing policy: table cells only, where
 *      every claim is validated)
 * A business-shaped name with NO nearby negativity is fine here (unlike the
 * table path's fail-closed UNCLASSIFIED_OPTION) — "Sarasota Pest Control
 * Guide" as a title must not block a normal post.
 *
 * operatorBriefText — the OPERATOR-authored intercept-brief text (title/
 * keywords/thesis/outline). A recognized competitor the operator personally
 * named there (e.g. the Aptive cancellation brief) is authorized content:
 * instead of the hard UNKNOWN_COMPETITOR / COMPETITOR_IN_PROSE block, the
 * draft sets requiresHumanReview so the runner parks it on the APPROVABLE
 * named-competitor review path — a human still signs off every one, and
 * the disparagement/reliability scans above still apply at full curated
 * strictness. Names the operator did NOT write stay hard-blocked; mined
 * briefs pass no text, so nothing changes for them.
 */
function evaluateProse(draft, body, { operatorBriefText = '' } = {}) {
  const findings = [];
  const scanText = draftScanTexts(draft, body);
  const stripQuotesForNames = (s) => String(s).replace(/[\\"“”]/g, ' ');
  const nameScanText = stripQuotesForNames(scanText);
  // Authorized names come from running the SAME mention detector over the
  // operator's brief text — both sides canonicalize identically, so a brief
  // that says "Massey" authorizes a draft that writes the canonical "Massey
  // Services" (a raw substring compare missed every alias↔canonical pair).
  // Matching is word-boundary CONTAINMENT in either direction, not exact
  // string: detection-only tokens canonicalize by surface form, so a brief
  // that says "Aptive" and a draft that writes "Aptive Environmental"
  // produce different unknown names for the same business — the operator's
  // shorter token must still authorize the fuller one (and vice versa).
  // Names on both sides come from findBusinessMentions' recognition corpus,
  // so containment can't be gamed with arbitrary prose.
  const authorizedNames = new Set();
  if (operatorBriefText) {
    for (const m of competitorFacts.findBusinessMentions(stripQuotesForNames(String(operatorBriefText)))) {
      authorizedNames.add(String(m.name).toLowerCase());
    }
  }
  const wordBoundaryContains = (haystack, needle) =>
    new RegExp(`(?:^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?:\\s|$)`, 'i').test(haystack);
  const operatorAuthorized = (name) => {
    const nm = String(name).toLowerCase();
    if (authorizedNames.has(nm)) return true;
    for (const auth of authorizedNames) {
      if (wordBoundaryContains(nm, auth) || wordBoundaryContains(auth, nm)) return true;
    }
    return false;
  };

  const known = new Set();
  const unknown = new Set();
  const genericNames = new Set();
  for (const m of competitorFacts.findBusinessMentions(nameScanText)) {
    (m.inAllowlist ? known : unknown).add(m.name);
  }
  // Case-INSENSITIVE provider/legal-entity passes: a disparaged target
  // written lowercase or all-caps ("acme pest solutions is dishonest")
  // otherwise never enters genericNames and the negativity scan passes.
  // The GENERIC_LEAD_EXCLUSIONS inside the patterns match case-insensitively
  // too, so ordinary lowercase category prose ("local pest control company")
  // stays excluded exactly as its Title Case form is. With /i, lowercase
  // words become valid NAME tokens, so a capture can swallow its own
  // preceding negativity ("Avoid the dishonest Acme Pest Solutions") — the
  // capture is therefore SPLIT at its last interior negativity token: the
  // name becomes what follows it, and the negativity sits back OUTSIDE the
  // name where the neg-before-name directed check sees it.
  const NEG_INSIDE_RE_SRC = `(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)\\s+`;
  const splitAtNegativity = (name) => {
    const inner = new RegExp(NEG_INSIDE_RE_SRC, 'gi');
    const nm = String(name).trim();
    let cut = -1;
    let mm;
    while ((mm = inner.exec(nm)) !== null) cut = mm.index + mm[0].length;
    return cut >= 0 ? nm.slice(cut).trim() : nm;
  };
  for (const m of nameScanText.matchAll(providerNameRe('gi'))) {
    const nm = splitAtNegativity(m[1]);
    if (nm && !OWN_BRAND_RE.test(nm)) genericNames.add(nm);
  }
  for (const m of nameScanText.matchAll(legalEntityRe('gi'))) {
    const nm = splitAtNegativity(m[1]);
    if (nm && !OWN_BRAND_RE.test(nm)) genericNames.add(nm);
  }
  const curatedNames = [...known, ...unknown];
  for (const nm of curatedNames) genericNames.delete(nm);

  // Curated competitor names: bare PROXIMITY is enough (a real brand plus
  // negativity nearby is legal surface even without tidy grammar — mirrors
  // the comparison path's prose scan). Generic business-SHAPED phrases need
  // the negativity DIRECTED at the name — name-as-subject before a negative
  // predicate, or the negative term immediately modifying the name. Bare
  // proximity false-positives on titles like "Sarasota Pest Control Guide:
  // Worst Roach Problems", where the negative describes the pest problem.
  if (curatedNames.length) {
    const nearCurated = (idx, len) => {
      const window = nameScanText
        .slice(Math.max(0, idx - PROVIDER_NEGATIVE_PROXIMITY), idx + len + PROVIDER_NEGATIVE_PROXIMITY)
        .toLowerCase()
        .replace(/\s+/g, ' ');
      return curatedNames.some((n) => window.includes(n.toLowerCase().replace(/\s+/g, ' ')));
    };
    const p0Re = new RegExp(`${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b`, 'gi');
    let am;
    while ((am = p0Re.exec(scanText)) !== null) {
      if (nearCurated(am.index, am[0].length)) {
        findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
          `Draft disparages a named competitor ("${am[0].trim()}" near a competitor name). State neutral attributes only — in prose, the title, and the meta.`));
        break;
      }
    }
    const negRe = new RegExp(PROVIDER_NEGATIVE_RE.source, 'gi');
    let nm;
    while ((nm = negRe.exec(scanText)) !== null) {
      if (nearCurated(nm.index, nm[0].length)) {
        findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
          `Draft makes a negative service-reliability claim near a named competitor ("${nm[0].trim()}"). Routed to human review — state neutral, verifiable attributes only.`));
        break;
      }
    }
  }

  for (const name of genericNames) {
    const escaped = escapeForNameRe(name);
    // Name-as-subject: "<Name> [word word] is/never/keeps … <negative>" —
    // within the same sentence, a linking/behavioral verb between the name
    // and the negative term ties the negativity to the business.
    const SUBJECT_VERBS = 'is|are|was|were|isn\'?t|aren\'?t|seems?|looks?|sounds?|remains?|stays?|has(?:\\s+been)?|have(?:\\s+been)?|will|would|can(?:not)?|can\'?t|won\'?t|never|always|keeps?|kept|tends?|tend';
    const directedP0 = new RegExp(
      `${escaped}(?:'s)?\\b(?:\\s+\\w+){0,2}\\s+(?:${SUBJECT_VERBS})\\b[^.!?\\n]{0,60}(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)`, 'i',
    );
    // Negative adjective immediately modifying the name ("the dishonest
    // Acme Pest Solutions").
    const negBeforeName = new RegExp(`(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)\\s+(?:\\w+\\s+)?${escaped}\\b`, 'i');
    // ACTIVE disparaging predicate right after the name ("<Name> scams
    // customers", "<Name> charges hidden fees") — the linking-verb shape
    // above misses transitive verbs, and these victim-anchored idioms only
    // read with the name as subject. Up to two adverbs may intervene.
    const activeP0 = new RegExp(
      `${escaped}(?:'s)?\\s+(?:(?:also|often|always|never|routinely|repeatedly|regularly|frequently|just|really|constantly)\\s+){0,2}(?:${ACTIVE_DISPARAGEMENT_SRC})`, 'i',
    );
    if (directedP0.test(nameScanText) || negBeforeName.test(nameScanText) || activeP0.test(nameScanText)) {
      findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
        `Draft directs disparaging language at "${name}". State neutral attributes only — in prose, the title, and the meta.`));
      break;
    }
    // Service-reliability negative predicated on the name — either as the
    // DIRECT predicate ("<Name> never answers the phone", "<Name> no-shows")
    // or linked through a subject verb ("<Name> is unreliable"). A bare
    // reliability term merely NEAR the name is not enough: "Sarasota Pest
    // Control Guide: Why DIY Sprays Are Unreliable" aims the negative at DIY
    // sprays, not the business-shaped phrase, and must pass.
    const directedReliability = new RegExp(
      `${escaped}(?:'s)?\\b(?:\\s+\\w+){0,2}\\s+(?:(?:${SUBJECT_VERBS})\\b[^.!?\\n]{0,60})?(?:${PROVIDER_NEGATIVE_RE.source})`, 'i',
    );
    if (directedReliability.test(nameScanText)) {
      findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
        `Draft makes a negative service-reliability claim about "${name}". Routed to human review — state neutral, verifiable attributes only.`));
      break;
    }
  }

  let requiresHumanReview = false;
  for (const nm of unknown) {
    if (operatorAuthorized(nm)) {
      // The operator named this competitor in the intercept brief — route
      // to the approvable named-competitor review instead of hard-blocking.
      requiresHumanReview = true;
      continue;
    }
    findings.push(finding('P0', 'COMPARISON_UNKNOWN_COMPETITOR',
      `Names "${nm}", a recognized competitor not on the curated competitor-facts allowlist — its claims cannot be verified. Remove the mention or add "${nm}" to competitor-facts.js with sourced, dated facts.`));
  }
  for (const nm of known) {
    if (operatorAuthorized(nm)) {
      requiresHumanReview = true;
      continue;
    }
    findings.push(finding('P1', 'COMPARISON_COMPETITOR_IN_PROSE',
      `Names competitor "${nm}" in prose/title/meta with no comparison table — claims there are not validated against competitor-facts.js. Name a competitor ONLY inside a <ComparisonTable> (every cell is checked).`));
  }

  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  return { pass, findings, requiresHumanReview };
}

// Escape a detected business name for use inside a regex, tolerating the
// collapsed whitespace stripQuotesForNames leaves behind.
function escapeForNameRe(name) {
  return String(name || '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
}

/**
 * evaluate(draft, { namedCompetitorEnabled, operatorBriefText })
 *   → { pass, findings, requiresHumanReview }
 * operatorBriefText applies to the TABLE-LESS path only (see evaluateProse):
 * table cells always validate against curated competitor-facts — operator
 * authorship can't make an unverifiable table claim verifiable.
 */
function evaluate(draft, { namedCompetitorEnabled = false, operatorBriefText = '' } = {}) {
  const body = String(draft?.body || draft?.content || '');
  const findings = [];
  const blocks = extractComparisonBlocks(body);
  if (!body) return { pass: true, findings, requiresHumanReview: false };
  if (blocks.length === 0) return evaluateProse(draft, body, { operatorBriefText });

  const fm = draft?.frontmatter || {};
  const metaText = ['title', 'meta_description', 'metaTitle', 'metaDescription']
    .map((k) => fm[k]).filter(Boolean).map(String).join('\n');
  const scanText = draftScanTexts(draft, body);
  // For NAME detection only, drop double quotes AND backslashes (so an embedded-
  // quote brand like All "U" Need Pest Control — or its escaped \"U\" form — is
  // read as one name, not a "Need Pest Control" fragment). Apostrophes are kept
  // (Keller's). Disparagement/ranking scans keep the original scanText. Each
  // stripped char becomes a space, so this is length-preserving (scanText and
  // nameScanText share character indices) but can leave multiple spaces between
  // words — name lookups must stay whitespace-tolerant.
  const stripQuotesForNames = (s) => String(s).replace(/[\\"“”]/g, ' ');
  const nameScanText = stripQuotesForNames(scanText);

  const known = new Set();
  const unknown = new Set();
  const unclassified = new Set();
  const unsourcedKnown = new Set();
  const blockNamedKnown = new Set();
  const unsupportedFacts = new Set();
  const negativeReliability = new Set();

  // ── Whole-text scans (body + title/meta) ──
  const disp = scanText.match(DISPARAGEMENT_RE) || scanText.match(PROVIDER_DISPARAGEMENT_RE);
  if (disp) {
    findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
      `Comparison draft contains disparaging language about a provider ("${disp[0].trim()}"). State attributes, never insults — in the table, the prose, or the title/meta.`));
  }
  const rank = scanText.match(RANKING_RE);
  if (rank) {
    findings.push(finding('P1', 'COMPARISON_RIGGED_RANKING',
      `Comparison draft uses ranking/superlative framing ("${rank[0].trim()}"). Present neutral trade-offs — do not declare a winner, in the table, the prose, or the title/meta.`));
  }
  for (const m of competitorFacts.findBusinessMentions(nameScanText)) {
    (m.inAllowlist ? known : unknown).add(m.name);
  }
  for (const m of nameScanText.matchAll(providerNameRe('g'))) {
    const nm = m[1].trim();
    if (OWN_BRAND_RE.test(nm)) continue;
    if (competitorFacts.isKnownCompetitor(nm)) known.add(competitorFacts.findCompetitor(nm).name);
    else unclassified.add(nm);
  }
  // Legal-entity-marked business names ("Bob's Bugs LLC") anywhere in the draft.
  for (const m of nameScanText.matchAll(legalEntityRe('g'))) {
    const nm = m[1].trim();
    if (OWN_BRAND_RE.test(nm)) continue;
    if (competitorFacts.isKnownCompetitor(nm)) known.add(competitorFacts.findCompetitor(nm).name);
    else unclassified.add(nm);
  }
  // Prose/title/meta negatives within proximity of a NAMED competitor — these
  // tie an insult/reliability claim to the brand even without a provider noun
  // ("Orkin is the worst", "Orkin never answers the phone"), which the
  // noun-based PROVIDER_DISPARAGEMENT_RE misses.
  const competitorNames = [...known, ...unknown];
  if (competitorNames.length) {
    const nearCompetitor = (idx, len) => {
      // Slice the quote/backslash-stripped text (indices align with scanText) and
      // collapse runs of whitespace so an escaped/embedded-quote brand — left as
      // "All   U   Need" by the strip — still matches its canonical single-spaced
      // name. NEG_ADJ/PROVIDER_NEGATIVE matches are quote-free, so their indices
      // are identical in scanText and nameScanText.
      const window = nameScanText
        .slice(Math.max(0, idx - PROVIDER_NEGATIVE_PROXIMITY), idx + len + PROVIDER_NEGATIVE_PROXIMITY)
        .toLowerCase()
        .replace(/\s+/g, ' ');
      return competitorNames.some((n) => window.includes(n.toLowerCase().replace(/\s+/g, ' ')));
    };
    // Disparaging adjective near a competitor name → P0.
    const adjRe = new RegExp(`\\b(?:${NEG_ADJ})\\b`, 'ig');
    let am;
    while ((am = adjRe.exec(scanText)) !== null) {
      if (nearCompetitor(am.index, am[0].length)) {
        findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
          `Comparison draft disparages a named competitor ("${am[0].trim()}" near a competitor name). State neutral attributes only.`));
        break;
      }
    }
    // Negative service-reliability claim near a competitor name → P1 review.
    const negRe = new RegExp(PROVIDER_NEGATIVE_RE.source, 'ig');
    let nm;
    while ((nm = negRe.exec(scanText)) !== null) {
      if (nearCompetitor(nm.index, nm[0].length)) {
        findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
          `Comparison draft makes a negative service-reliability claim about a named provider ("${nm[0].trim()}"). Routed to human review — state neutral, verifiable attributes only.`));
        break;
      }
    }
  }

  // ── Per-table checks ──
  for (const block of blocks) {
    const attributed = hasAttribution(extractCaption(block));
    const options = extractColumns(block).slice(1);
    const rows = extractRows(block);
    const blockKnown = new Set();

    options.forEach((opt, j) => {
      const cls = classifyOption(opt);
      if (cls === 'known_competitor') {
        const allowlisted = competitorFacts.findBusinessMentions(opt).filter((x) => x.inAllowlist);
        const distinctNames = [...new Set(allowlisted.map((x) => x.name))];
        // A single comparison column must represent ONE provider. If a header
        // names multiple allowlisted competitors ("Orkin / Massey Services"),
        // only one would ever be validated — fail closed and route to review.
        if (distinctNames.length > 1) {
          distinctNames.forEach((n) => { known.add(n); blockKnown.add(n); });
          unsupportedFacts.add(`${distinctNames.join(' / ')} — one comparison column names multiple competitors; give each its own column so every cell is validated against that competitor's curated facts`);
          return;
        }
        const name = distinctNames[0] || opt.trim();
        known.add(name);
        blockKnown.add(name);
        const attrVals = competitorFacts.attributeValues(name);
        // Fail closed: a comparison table that names a competitor must have
        // parseable rows to validate; if we got none, its cells could claim
        // anything, so route to review rather than pass unvalidated.
        if (rows.length === 0) {
          unsupportedFacts.add(`${name} — (table rows could not be parsed for validation)`);
        }
        for (const row of rows) {
          const cell = String(row.values[j] ?? '').trim();
          if (!cell || NEUTRAL_CELL_RE.test(cell)) continue;
          // A NEGATIVE mark ("No"/"Never"/"✗") asserts the competitor LACKS the
          // row's criterion. Harmless for a neutral feature, but on a service-
          // reliability/quality row it is a negative-reliability claim about a
          // named competitor → route to human review (never wave it through).
          if (NEGATIVE_CELL_RE.test(cell)) {
            if (RELIABILITY_LABEL_RE.test(String(row.label || ''))) {
              negativeReliability.add(`${name} — "${String(row.label).trim()}: ${cell}"`);
            }
            continue;
          }
          // Affirmative cell → the claim is the ROW LABEL; substantive cell → the value.
          const claim = AFFIRMATIVE_CELL_RE.test(cell) ? row.label : cell;
          if (!claimSupported(claim, attrVals)) {
            unsupportedFacts.add(`${name} — "${String(claim).trim()}"`);
          }
        }
      } else if (cls === 'unknown_competitor') {
        unknown.add(opt.trim());
      } else if (cls === 'unclassified') {
        unclassified.add(opt.trim());
      }
    });
    // An allowlisted competitor named inside a row LABEL or CELL (not as an
    // option header) carries an unvalidated claim ("Orkin offers same-day
    // service") the per-column validator never checks — flag it. Only the
    // column header may name a competitor.
    const cellText = rows.flatMap((r) => [r.label, ...(r.values || [])]).filter(Boolean).join(' \n ');
    for (const m of competitorFacts.findBusinessMentions(cellText)) {
      if (m.inAllowlist) unsupportedFacts.add(`${m.name} — named in a table cell/row (only the column header may name a competitor)`);
    }
    // Known competitors named in the block text (not just headers).
    for (const m of competitorFacts.findBusinessMentions(block)) {
      if (m.inAllowlist) blockKnown.add(m.name);
    }
    blockKnown.forEach((n) => {
      blockNamedKnown.add(n);
      if (!attributed) unsourcedKnown.add(n); // per-occurrence: any unsourced naming flags
    });

    if (TABLE_DISPARAGEMENT_RE.test(block)) {
      const m = block.match(TABLE_DISPARAGEMENT_RE);
      findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
        `Comparison table contains disparaging language about an option ("${m[0]}"). State attributes, never insults.`));
    }
    if (PROVIDER_NEGATIVE_RE.test(block)) {
      const m = block.match(PROVIDER_NEGATIVE_RE);
      findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
        `Comparison table makes a negative service-reliability claim about an option ("${m[0].trim()}"). Routed to human review — phrase it as a neutral, verifiable attribute or remove it.`));
    }
  }

  // Known competitors named only in prose (never in a table) have no caption → unsourced.
  for (const n of known) if (!blockNamedKnown.has(n)) unsourcedKnown.add(n);

  // A competitor may be named ONLY inside the comparison table, where every cell
  // is validated against curated facts. A mention in the surrounding prose /
  // title / meta carries unvalidatable claims ("Orkin offers free same-day
  // service in Sarasota"), so flag it — the writer must move the competitor into
  // the table. proseText = body with the <ComparisonTable> blocks removed.
  let proseText = body;
  for (const b of blocks) proseText = proseText.split(b).join(' ');
  if (metaText) proseText = `${proseText}\n${metaText}`;
  const competitorInProse = new Set();
  // Strip quotes/backslashes here too so an escaped/embedded-quote brand named in
  // prose ("All \"U\" Need Pest Control offers …") is detected, not just the
  // straight/smart-quote spellings findBusinessMentions normalizes on its own.
  for (const m of competitorFacts.findBusinessMentions(stripQuotesForNames(proseText))) {
    if (m.inAllowlist) competitorInProse.add(m.name);
  }

  // Reconcile overlaps.
  for (const nm of known) unknown.delete(nm);
  for (const nm of [...unclassified]) {
    if (known.has(nm) || unknown.has(nm)) unclassified.delete(nm);
  }

  // ── Resolve findings ──
  for (const nm of unknown) {
    findings.push(finding('P0', 'COMPARISON_UNKNOWN_COMPETITOR',
      `Names "${nm}", a recognized competitor not on the curated competitor-facts allowlist — its attributes cannot be verified. Use a provider CATEGORY instead, or add "${nm}" to competitor-facts.js with sourced, dated facts.`));
  }
  for (const nm of unclassified) {
    findings.push(finding('P1', 'COMPARISON_UNCLASSIFIED_OPTION',
      `References "${nm}", which looks like a business but is neither a recognized provider category, Waves, nor an allowlisted competitor — routed to human review (fail-closed).`));
  }
  for (const f of unsupportedFacts) {
    findings.push(finding('P1', 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT',
      `Comparison states a fact about ${f} that is not a curated attribute in competitor-facts.js — only sourced, curated attributes may be claimed about a named competitor.`));
  }
  for (const f of negativeReliability) {
    findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
      `Comparison marks a named competitor as lacking a service/reliability criterion (${f}) — a negative reliability claim about a named provider. Routed to human review; state neutral, verifiable attributes only.`));
  }
  for (const nm of competitorInProse) {
    findings.push(finding('P1', 'COMPARISON_COMPETITOR_IN_PROSE',
      `Names competitor "${nm}" in prose/title/meta, outside the comparison table — claims there are not validated against competitor-facts.js. Name a competitor ONLY inside the <ComparisonTable> (every cell is checked), not in the surrounding copy.`));
  }
  if (known.size && !namedCompetitorEnabled) {
    findings.push(finding('P1', 'COMPARISON_NAMED_COMPETITOR_DISABLED',
      `Names a competitor (${[...known].join(', ')}) but named-competitor comparisons are disabled (GATE_NAMED_COMPETITOR_COMPARISON). Use a category comparison, or enable the flag.`));
  } else if (known.size && unsourcedKnown.size) {
    findings.push(finding('P1', 'COMPARISON_COMPETITOR_UNSOURCED',
      `Names a competitor (${[...unsourcedKnown].join(', ')}) without an "as of <date>" + source caption on the table that names it. Add e.g. caption="Attributes as of June 2026, per each company's public website."`));
  }

  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  // A clean, enabled named-competitor draft still must NOT auto-publish: the
  // runner routes requiresHumanReview drafts to the approvable review queue.
  const requiresHumanReview = pass && namedCompetitorEnabled && known.size > 0;
  return { pass, findings, requiresHumanReview };
}

module.exports = {
  evaluate,
  evaluateProse,
  extractComparisonBlocks,
  extractCaption,
  extractColumns,
  extractRows,
  classifyOption,
  claimSupported,
  hasAttribution,
  DISPARAGEMENT_RE,
  TABLE_DISPARAGEMENT_RE,
  RANKING_RE,
  PROVIDER_NEGATIVE_RE,
};
