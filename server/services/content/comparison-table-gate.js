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
 * SCOPE: only drafts that embed a <ComparisonTable> are scrutinized; others pass
 * untouched. For a comparison draft, the competitor / disparagement / ranking
 * checks scan the whole body PLUS the title/meta (the public legal surface), and
 * the option-column classification FAILS CLOSED on anything that is not a
 * recognized provider CATEGORY, Waves, or a curated allowlist competitor.
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
const PROVIDER_NAME_SRC = `\\b((?!(?:${GENERIC_LEAD_EXCLUSIONS})\\b)[A-Z][A-Za-z0-9&'.\\-]*(?:\\s+(?:[A-Z][A-Za-z0-9&'.\\-]*|of|and|&)){0,3}\\s+(?:Pest Control|Pest Management|Pest Solutions?|Pest Services?|Exterminators?|Exterminating|Termite (?:&|and) Pest|Environmental(?: Pest)?|Lawn (?:&|and) Pest))\\b`;
function providerNameRe(flags) { return new RegExp(PROVIDER_NAME_SRC, flags); }

// A legal-entity-marked business name ("Bob's Bugs LLC", "Acme Exterminators Inc")
// anywhere in the draft — used to fail closed on business-looking names that
// carry no pest-industry suffix but a company marker. Possessive-only names are
// NOT scanned in prose (too noisy: "Florida's climate"); they are caught in
// option headers by classifyOption().
const LEGAL_ENTITY_NAME_SRC = `\\b([A-Z][A-Za-z0-9&'.\\-]*(?:\\s+[A-Za-z0-9&'.\\-]+){0,3}\\s+(?:LLC|L\\.L\\.C\\.|Inc\\.?|Incorporated|Corp\\.?|Co\\.|Bros\\.?|Brothers|& Sons?))\\b`;
function legalEntityRe(flags) { return new RegExp(LEGAL_ENTITY_NAME_SRC, flags); }

const INDUSTRY_SUFFIX_RE = /\b(pest (?:control|management|solutions?|services?)|exterminat(?:or|ors|ing)|termite (?:&|and) pest|environmental(?: pest)?|lawn (?:&|and) pest)\b/i;
const BUSINESS_MARKER_RE = /\b[A-Z][a-z]+'s\b|\b(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Co\.|Bros\.?|Brothers|& Sons?)\b/;
const CATEGORY_OPTION_RE = /\b(national|nationwide|chains?|franchises?|big[\s-]?box|corporate|regional|local(?:ly)?|independent|small(?:er)?|diy|do[\s-]it[\s-]yourself|self[\s-]?treat\w*|home(?:owner)?|store[\s-]bought|over[\s-]the[\s-]counter|professionals?|pros?|quarterly|monthly|annual|seasonal|one[\s-]?time|one[\s-]?off|recurring|reactive|preventive|preventative|on[\s-]demand|subscription|plans?|programs?|packages?|services?|options?|untreated|no treatment|ignoring it|what (?:to|you))\b/i;
const OWN_BRAND_RE = /\bwaves\b/i;

// Cell value affirms the row criterion → the CLAIM is the row label (so an
// uncurated row label like "Free termite inspections | Free" is validated, not
// waved through as a neutral mark).
const AFFIRMATIVE_CELL_RE = /^(yes|y|✓|✔|included|standard|available|offered|both|always|free|✅)$/i;
// Cell value is a neutral/negative mark → no factual claim about the competitor.
const NEUTRAL_CELL_RE = /^(no|n|n\/?a|none|n\.a\.|—|–|-|\*|✗|✘|x|varies|varies?\.?|quote[\s-]?based|optional|sometimes|limited|tbd|maybe|\$+|never|❌)$/i;

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

function extractCaption(block) {
  const m = String(block || '').match(/caption\s*=\s*\{?\s*(["'])([\s\S]*?)\1/i);
  return m ? m[2] : '';
}

function extractColumns(block) {
  const m = String(block || '').match(/columns\s*=\s*\{?\s*\[([\s\S]*?)\]/i);
  if (!m) return [];
  const out = [];
  const re = /(["'])([\s\S]*?)\1/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) out.push(mm[2]);
  return out;
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
    const labelM = obj.match(/["']?label["']?\s*:\s*(["'])([\s\S]*?)\1/);
    const valsM = obj.match(/["']?values["']?\s*:\s*\[([\s\S]*?)\]/);
    const values = [];
    if (valsM) {
      const vre = /(["'])([\s\S]*?)\1/g;
      let vm;
      while ((vm = vre.exec(valsM[1])) !== null) values.push(vm[2]);
    }
    rows.push({ label: labelM ? labelM[2] : '', values });
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
  if (OWN_BRAND_RE.test(h)) return 'own';
  const mentions = competitorFacts.findBusinessMentions(h);
  if (mentions.some((m) => m.inAllowlist)) return 'known_competitor';
  if (mentions.some((m) => !m.inAllowlist)) return 'unknown_competitor';
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
  if (!words.length) return true; // only short / stop words — not a factual claim
  for (const av of attrValues) {
    const na = normalize(av);
    if (!na) continue;
    if (words.every((w) => na.includes(w))) return true;
  }
  return false;
}

/**
 * evaluate(draft, { namedCompetitorEnabled }) → { pass, findings, requiresHumanReview }
 */
function evaluate(draft, { namedCompetitorEnabled = false } = {}) {
  const body = String(draft?.body || draft?.content || '');
  const findings = [];
  const blocks = extractComparisonBlocks(body);
  if (!body || blocks.length === 0) return { pass: true, findings, requiresHumanReview: false };

  const fm = draft?.frontmatter || {};
  const metaText = ['title', 'meta_description', 'metaTitle', 'metaDescription']
    .map((k) => fm[k]).filter(Boolean).map(String).join('\n');
  const scanText = metaText ? `${body}\n${metaText}` : body;

  const known = new Set();
  const unknown = new Set();
  const unclassified = new Set();
  const unsourcedKnown = new Set();
  const blockNamedKnown = new Set();
  const unsupportedFacts = new Set();

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
  for (const m of competitorFacts.findBusinessMentions(scanText)) {
    (m.inAllowlist ? known : unknown).add(m.name);
  }
  for (const m of scanText.matchAll(providerNameRe('g'))) {
    const nm = m[1].trim();
    if (OWN_BRAND_RE.test(nm)) continue;
    if (competitorFacts.isKnownCompetitor(nm)) known.add(competitorFacts.findCompetitor(nm).name);
    else unclassified.add(nm);
  }
  // Legal-entity-marked business names ("Bob's Bugs LLC") anywhere in the draft.
  for (const m of scanText.matchAll(legalEntityRe('g'))) {
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
      const window = scanText
        .slice(Math.max(0, idx - PROVIDER_NEGATIVE_PROXIMITY), idx + len + PROVIDER_NEGATIVE_PROXIMITY)
        .toLowerCase();
      return competitorNames.some((n) => window.includes(n.toLowerCase()));
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
        const mm = competitorFacts.findBusinessMentions(opt).find((x) => x.inAllowlist);
        const name = mm ? mm.name : opt.trim();
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
  for (const m of competitorFacts.findBusinessMentions(proseText)) {
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
