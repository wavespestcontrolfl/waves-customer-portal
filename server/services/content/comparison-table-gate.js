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
 * SCOPE: the gate only scrutinizes drafts that actually embed a
 * <ComparisonTable>. A draft with no comparison table passes untouched. For a
 * comparison draft, the competitor / disparagement / ranking checks scan the
 * whole body PLUS the title/meta (the public legal surface), and the
 * option-column classification FAILS CLOSED on anything that is not a
 * recognized provider CATEGORY, Waves, or a curated allowlist competitor.
 *
 *   P0 COMPARISON_DISPARAGEMENT          — derogatory language about a provider
 *   P0 COMPARISON_UNKNOWN_COMPETITOR     — recognized competitor brand named that
 *                                          is NOT on the curated allowlist
 *   P1 COMPARISON_UNCLASSIFIED_OPTION    — comparison option / business-looking
 *                                          name that is not a category/Waves/allowlisted
 *   P1 COMPARISON_RIGGED_RANKING         — self-declared "winner" / superlative
 *   P1 COMPARISON_NEGATIVE_RELIABILITY   — negative service claim about an option
 *   P1 COMPARISON_NAMED_COMPETITOR_DISABLED   — names a competitor while gated off
 *   P1 COMPARISON_COMPETITOR_UNSOURCED        — named competitor with no own
 *                                          attributed ("as of"+source) table caption
 *   P1 COMPARISON_UNSUPPORTED_COMPETITOR_FACT — a named competitor's cell states a
 *                                          fact that is not a curated attribute
 *
 * A clean named-competitor draft (enabled + allowlisted + sourced-per-table +
 * only curated facts + no other finding) PASSES; it then flows through the
 * pipeline's trust-build human-approval ramp (which has a real approve action).
 * Pure (no I/O). Returns { pass, findings:[{severity,code,message}] }.
 */

const competitorFacts = require('./competitor-facts');

// Derogatory language about a provider — block outright, scanned over the whole
// comparison-draft body + title/meta. Limited to terms that are almost
// exclusively business-disparagement; words with legitimate pest/efficacy uses
// ("garbage", "worst infestation") are EXCLUDED here. "worst"/evaluative terms
// are caught TABLE-SCOPED below (where they are provider-directed, not prose).
const DISPARAGEMENT_RE = /\b(scams?|rip[\s-]?offs?|ripoffs?|overpriced|goug\w*|incompetent|shady|sketchy|dishonest|untrustworthy|crooks?|frauds?|fraudulent|hidden fees?|bait[\s-]and[\s-]switch|lousy|sloppy|clueless|second[\s-]?rate)\b/i;

// Evaluative negatives that are fine in prose ("worst infestation") but are
// provider-disparagement INSIDE a comparison table cell ("Worst follow-up").
// Scanned only within extracted table blocks.
const TABLE_DISPARAGEMENT_RE = /\b(worst|terrible|awful|horrible|useless|inferior|sub[\s-]?par|pathetic|mediocre)\b/i;

// Negative service-reliability claims about an option — table-scoped, route to
// review (P1). Kept separate from prose efficacy talk.
const PROVIDER_NEGATIVE_RE = /\b(unreliable|unresponsive|no[\s-]?shows?|never (?:answers?|calls?|shows?)\b|hard to reach|leaves? you waiting|ghosts? you|won'?t call (?:you )?back|don'?t show up)\b/i;

// Self-declared ranking / superlative framing. Scanned over the whole
// comparison-draft body + title/meta, so it must be prose-safe: "best"/"top"
// only fire with a REQUIRED provider/ranking context ("best pest control in
// Venice", "top pest control company"), NOT "the best time to treat" or "best
// pest control method".
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
  // "(the) best/top [adj] pest control/exterminator/lawn care" + a ranking tail
  '\\b(?:the\\s+)?(?:best|top)\\s+(?:\\w+\\s+){0,2}(?:pest control|exterminators?|lawn (?:care|service))\\s+(?:company|companies|provider|service|choice|in|around|near)\\b',
  // "(the) best/top (pest control) company/provider/choice in/around/near"
  '\\b(?:the\\s+)?(?:best|top)\\s+(?:pest[\\s-]control\\s+)?(?:company|provider|choice)\\s+(?:in|around|near)\\b',
].join('|'), 'i');

// Generic descriptors / methodologies that may precede a pest-industry suffix in
// PROSE but are not a business name — skip them so "Professional Pest Control" /
// "Integrated Pest Management" are not misread as a competitor.
const GENERIC_LEAD_EXCLUSIONS = 'Professional|Local|Quality|Affordable|Best|Reliable|Trusted|Expert|Licensed|Insured|Residential|Commercial|Pest|Lawn|Green|Safe|Eco|Modern|Premier|Quarterly|Monthly|Annual|Seasonal|National|Regional|Nationwide|Same|Top|Your|Our|The|This|That|These|Those|A|An|Florida|Southwest|Sarasota|Manatee|Charlotte|Bradenton|Venice|Integrated|Sustainable|Comprehensive|Targeted|Routine|Ongoing|Effective|Proper|Smart|Organic|Natural|General|Basic|Standard|Custom|Year';
const PROVIDER_NAME_SRC = `\\b((?!(?:${GENERIC_LEAD_EXCLUSIONS})\\b)[A-Z][A-Za-z0-9&'.\\-]*(?:\\s+(?:[A-Z][A-Za-z0-9&'.\\-]*|of|and|&)){0,3}\\s+(?:Pest Control|Pest Management|Pest Solutions?|Pest Services?|Exterminators?|Exterminating|Termite (?:&|and) Pest|Environmental(?: Pest)?|Lawn (?:&|and) Pest))\\b`;
function providerNameRe(flags) { return new RegExp(PROVIDER_NAME_SRC, flags); }

// A pest-industry suffix anywhere in a comparison OPTION header marks it as a
// business name (not a category).
const INDUSTRY_SUFFIX_RE = /\b(pest (?:control|management|solutions?|services?)|exterminat(?:or|ors|ing)|termite (?:&|and) pest|environmental(?: pest)?|lawn (?:&|and) pest)\b/i;

// Legal-entity / possessive markers (case-sensitive: lowercase "company" in
// "Local SWFL company" is a category descriptor, not a marker).
const BUSINESS_MARKER_RE = /\b[A-Z][a-z]+'s\b|\b(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Co\.|Bros\.?|Brothers|& Sons?)\b/;

// Recognized generic provider CATEGORY / option labels (NOT a named business).
const CATEGORY_OPTION_RE = /\b(national|nationwide|chains?|franchises?|big[\s-]?box|corporate|regional|local(?:ly)?|independent|small(?:er)?|diy|do[\s-]it[\s-]yourself|self[\s-]?treat\w*|home(?:owner)?|store[\s-]bought|over[\s-]the[\s-]counter|professionals?|pros?|quarterly|monthly|annual|seasonal|one[\s-]?time|one[\s-]?off|recurring|reactive|preventive|preventative|on[\s-]demand|subscription|plans?|programs?|packages?|services?|options?|untreated|no treatment|ignoring it|what (?:to|you))\b/i;

const OWN_BRAND_RE = /\bwaves\b/i;

// Comparison "marks" that are not factual CLAIMS about a competitor — exempt
// from the curated-attribute check (they only say whether an option does a thing).
const TRIVIAL_CELL_RE = /^(yes|no|n\/?a|none|n\.a\.|—|–|-|\*|✓|✔|✗|✘|x|varies|varies?\.?|quote[\s-]?based|included|optional|both|either|tbd|maybe|sometimes|limited|\$+|free)$/i;

function finding(severity, code, message) {
  return { severity, code, message };
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** extractComparisonBlocks(body) → [rawComponentString]. */
function extractComparisonBlocks(body) {
  const text = String(body || '');
  const blocks = [];
  const re = /<ComparisonTable\b[\s\S]*?(?:\/>|<\/ComparisonTable>)/gi;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[0]);
  return blocks;
}

/** extractCaption(block) → caption string (handles caption="..." / caption={'...'}). */
function extractCaption(block) {
  const m = String(block || '').match(/caption\s*=\s*\{?\s*(["'])([\s\S]*?)\1/i);
  return m ? m[2] : '';
}

/** extractColumns(block) → column header strings (first is the row-label header). */
function extractColumns(block) {
  const m = String(block || '').match(/columns\s*=\s*\{?\s*\[([\s\S]*?)\]/i);
  if (!m) return [];
  const out = [];
  const re = /(["'])([\s\S]*?)\1/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) out.push(mm[2]);
  return out;
}

/** extractRows(block) → [{ label, values:[...] }]. Per-object regex avoids the nested-bracket problem. */
function extractRows(block) {
  const rows = [];
  const rowRe = /\{\s*label\s*:\s*(["'])([\s\S]*?)\1\s*,\s*values\s*:\s*\[([\s\S]*?)\]\s*\}/g;
  let m;
  while ((m = rowRe.exec(String(block || ''))) !== null) {
    const values = [];
    const vre = /(["'])([\s\S]*?)\1/g;
    let vm;
    while ((vm = vre.exec(m[3])) !== null) values.push(vm[2]);
    rows.push({ label: m[2], values });
  }
  return rows;
}

/** hasAttribution(caption) → "as of <date>" + source pointer present. */
function hasAttribution(caption) {
  const c = String(caption || '');
  if (!c) return false;
  const hasAsOf = /\bas of\b|\b(?:current|accurate|verified|updated)\s+as of\b|\bas published\b/i.test(c);
  const hasDate = /\b20\d{2}\b/.test(c)
    || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(c);
  const hasSource = /\b(source|per |according to|website|public(?:ly)?|state license|sunbiz|bbb|\.com\b|\.org\b|\.gov\b)\b/i.test(c);
  return hasAsOf && hasDate && hasSource;
}

/**
 * classifyOption(header) → 'own' | 'category' | 'known_competitor'
 *                          | 'unknown_competitor' | 'unclassified'
 * Waves is recognized FIRST (so an option literally named "Waves Pest Control"
 * is not parked as a business). Business-looking names are checked BEFORE the
 * category regex so generic words inside a business name cannot pass.
 */
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

/** valueSupported(value, attrValues) → true iff a cell is a trivial mark or backed by a curated attribute value. */
function valueSupported(value, attrValues) {
  const v = String(value || '').trim();
  if (!v || TRIVIAL_CELL_RE.test(v)) return true;
  const nv = normalize(v);
  if (!nv) return true;
  const words = nv.split(' ').filter((w) => w.length > 3);
  for (const av of attrValues) {
    const na = normalize(av);
    if (!na) continue;
    if (na.includes(nv) || nv.includes(na)) return true;
    if (words.length) {
      const overlap = words.filter((w) => na.includes(w)).length;
      if (overlap / words.length >= 0.5) return true;
    }
  }
  return false;
}

/**
 * evaluate(draft, { namedCompetitorEnabled }) → { pass, findings }
 */
function evaluate(draft, { namedCompetitorEnabled = false } = {}) {
  const body = String(draft?.body || draft?.content || '');
  const findings = [];
  const blocks = extractComparisonBlocks(body);
  // Only comparison/listicle drafts are scrutinized — no table, no scan.
  if (!body || blocks.length === 0) return { pass: true, findings };

  // Title/meta carry the same public/legal surface, so include them in the
  // competitor/disparagement/ranking scans (table blocks still come from body).
  const fm = draft?.frontmatter || {};
  const metaText = ['title', 'meta_description', 'metaTitle', 'metaDescription']
    .map((k) => fm[k]).filter(Boolean).map(String).join('\n');
  const scanText = metaText ? `${body}\n${metaText}` : body;

  const known = new Set();   // allowlisted competitor display names
  const unknown = new Set(); // recognized brand, not allowlisted (P0)
  const unclassified = new Set(); // business-looking, not categorizable (P1)
  const sourcedKnown = new Set(); // known competitors named in an attributed table
  const unsupportedFacts = new Set(); // "Name: \"cell\"" for non-curated facts

  // ── Whole-text scans (body + title/meta) ──
  const disp = scanText.match(DISPARAGEMENT_RE);
  if (disp) {
    findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
      `Comparison draft contains disparaging language about a provider ("${disp[0]}"). State attributes, never insults.`));
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

  // ── Per-table: classify options, table-scoped negatives, per-block attribution,
  // and named-competitor row-fact validation. ──
  for (const block of blocks) {
    const attributed = hasAttribution(extractCaption(block));
    const columns = extractColumns(block);
    const options = columns.slice(1); // option columns map 1:1 to row.values[]
    const rows = extractRows(block);
    const blockKnown = new Set();

    options.forEach((opt, j) => {
      const cls = classifyOption(opt);
      if (cls === 'known_competitor') {
        const mm = competitorFacts.findBusinessMentions(opt).find((x) => x.inAllowlist);
        const name = mm ? mm.name : opt.trim();
        known.add(name);
        blockKnown.add(name);
        // Validate this competitor's column cells against its curated attributes.
        const attrVals = competitorFacts.attributeValues(name);
        for (const row of rows) {
          const cell = row.values[j];
          if (cell !== undefined && !valueSupported(cell, attrVals)) {
            unsupportedFacts.add(`${name} — "${String(cell).trim()}"`);
          }
        }
      } else if (cls === 'unknown_competitor') {
        unknown.add(opt.trim());
      } else if (cls === 'unclassified') {
        unclassified.add(opt.trim());
      }
    });

    // A known competitor named in this block is "sourced" only if THIS block's
    // caption carries attribution (multi-table guides can't borrow another
    // table's caption).
    if (attributed) blockKnown.forEach((n) => sourcedKnown.add(n));

    if (TABLE_DISPARAGEMENT_RE.test(block)) {
      const m = block.match(TABLE_DISPARAGEMENT_RE);
      findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
        `Comparison table contains disparaging language about an option ("${m[0]}"). State attributes, never insults.`));
    }
    const neg = block.match(PROVIDER_NEGATIVE_RE);
    if (neg) {
      findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
        `Comparison table makes a negative service-reliability claim about an option ("${neg[0].trim()}"). Routed to human review — phrase it as a neutral, verifiable attribute or remove it.`));
    }
  }

  // Reconcile overlaps (allowlisted > recognized-unlisted > business-looking).
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
      `References "${nm}", which looks like a business but is neither a recognized provider category, Waves, nor an allowlisted competitor — routed to human review (fail-closed). Use a category label, or add it to competitor-facts.js if it is a real competitor.`));
  }
  for (const f of unsupportedFacts) {
    findings.push(finding('P1', 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT',
      `Comparison states a fact about ${f} that is not a curated attribute in competitor-facts.js — only sourced, curated attributes may be claimed about a named competitor. Remove it or add the sourced attribute.`));
  }
  if (known.size) {
    const names = [...known].join(', ');
    if (!namedCompetitorEnabled) {
      findings.push(finding('P1', 'COMPARISON_NAMED_COMPETITOR_DISABLED',
        `Names a competitor (${names}) but named-competitor comparisons are disabled (GATE_NAMED_COMPETITOR_COMPARISON). Use a category comparison to publish autonomously, or enable the flag.`));
    } else {
      const unsourced = [...known].filter((n) => !sourcedKnown.has(n));
      if (unsourced.length) {
        findings.push(finding('P1', 'COMPARISON_COMPETITOR_UNSOURCED',
          `Names a competitor (${unsourced.join(', ')}) without an "as of <date>" + source caption on the table that names it. Add e.g. caption="Attributes as of June 2026, per each company's public website."`));
      }
    }
    // enabled + every named competitor sourced-in-its-own-table + only curated
    // facts + no other finding → PASS → trust-build human-approval ramp.
  }

  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  return { pass, findings };
}

module.exports = {
  evaluate,
  extractComparisonBlocks,
  extractCaption,
  extractColumns,
  extractRows,
  classifyOption,
  hasAttribution,
  valueSupported,
  DISPARAGEMENT_RE,
  TABLE_DISPARAGEMENT_RE,
  RANKING_RE,
  PROVIDER_NEGATIVE_RE,
};
