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
 * <ComparisonTable>. A draft with no comparison table passes untouched —
 * ordinary educational posts must not be parked for mentioning "Integrated Pest
 * Management" or a competitor in passing. For a comparison draft, the
 * competitor / disparagement / ranking checks scan the WHOLE body (the writer
 * wraps the table in buyer-guide prose and can web-search names), and the
 * option-column classification FAILS CLOSED on anything that is not a
 * recognized provider CATEGORY, Waves, or a curated allowlist competitor.
 *
 *   P0 COMPARISON_DISPARAGEMENT       — derogatory language about any provider
 *   P0 COMPARISON_UNKNOWN_COMPETITOR  — a recognized competitor brand named that
 *                                       is NOT on the curated allowlist
 *   P1 COMPARISON_UNCLASSIFIED_OPTION — a comparison option / business-looking
 *                                       name that is neither a category nor
 *                                       Waves nor an allowlisted competitor
 *   P1 COMPARISON_RIGGED_RANKING      — self-declared "winner" / superlative
 *                                       (intro/table/conclusion)
 *   P1 COMPARISON_NEGATIVE_RELIABILITY— negative service-reliability claim about
 *                                       an option inside a table
 *   P1 COMPARISON_NAMED_COMPETITOR_DISABLED — names a competitor while gated off
 *   P1 COMPARISON_COMPETITOR_UNSOURCED      — names one but no caption "as of"+source
 *
 * A clean named-competitor draft (feature enabled + allowlisted + sourced + no
 * other finding) PASSES the gate; it then flows through the normal pipeline's
 * trust-build human-approval ramp (which has a real approve action) rather than
 * a bespoke dead-end review state. Category comparisons name no business, so
 * they only face the disparagement + ranking checks. Pure (no I/O). Returns
 * { pass, findings:[{severity,code,message}] }. P0/P1 block (route to review).
 */

const competitorFacts = require('./competitor-facts');

// Derogatory language about a provider — block outright, scanned over the whole
// body of a comparison draft. Deliberately limited to terms that are almost
// exclusively business-disparagement; words with legitimate pest/efficacy uses
// ("garbage", "worst infestation", "terrible/awful smell") are EXCLUDED to
// avoid false positives. Negative service-RELIABILITY claims are handled
// separately (table-scoped, route-to-review) below.
const DISPARAGEMENT_RE = /\b(scams?|rip[\s-]?offs?|ripoffs?|overpriced|goug\w*|incompetent|shady|sketchy|dishonest|untrustworthy|crooks?|frauds?|fraudulent|hidden fees?|bait[\s-]and[\s-]switch|lousy|sloppy|clueless|second[\s-]?rate)\b/i;

// Negative service-reliability claims about an option. Legitimate as honest
// service commentary OR unfair disparagement depending on context — so inside a
// comparison table they ROUTE TO REVIEW (P1) rather than auto-publish. Scoped to
// the table blocks so ordinary efficacy prose ("DIY sprays are unreliable on
// termites") elsewhere is untouched.
const PROVIDER_NEGATIVE_RE = /\b(unreliable|unresponsive|no[\s-]?shows?|never (?:answers?|calls?|shows?)\b|hard to reach|leaves? you waiting|ghosts? you|won'?t call (?:you )?back|don'?t show up)\b/i;

// Self-declared ranking / superlative framing — the astroturf tell. Scanned over
// the whole comparison-draft body (intro/table/conclusion), so it must be
// prose-safe: "the best" only fires in a ranking context ("the best pest control
// choice"), NOT "the best time to treat". Non-word starts like "#1" match
// because each branch is self-bounding.
const RANKING_RE = /(#\s?1\b|\bno\.?\s?1\b|\bnumber one\b|\btop[\s-]?rated\b|\bunbeatable\b|\bbest[\s-]in[\s-]class\b|\bhands[\s-]down\b|\bclear winner\b|\bthe winner\b|\bsuperior to\b|\bbetter than (?:everyone|the rest|all others|the competition|any other)\b|\bcrush\w* the competition\b|\bbest in (?:town|the area|swfl|southwest florida|florida|venice|sarasota|bradenton|manatee|charlotte|parrish|palmetto|north port)\b|\bthe best\b\s+(?:\w+\s+){0,2}(?:pest control|exterminators?|lawn (?:care|service)|company|companies|choice|option|service|provider|value|deal|price|in town))/i;

// Generic descriptors / methodologies that may precede a pest-industry suffix
// in PROSE but are not a business name — skip them so "Professional Pest
// Control" / "Integrated Pest Management" / "Year-Round Pest Control" are not
// misread as a competitor in the whole-body scan.
const GENERIC_LEAD_EXCLUSIONS = 'Professional|Local|Quality|Affordable|Best|Reliable|Trusted|Expert|Licensed|Insured|Residential|Commercial|Pest|Lawn|Green|Safe|Eco|Modern|Premier|Quarterly|Monthly|Annual|Seasonal|National|Regional|Nationwide|Same|Top|Your|Our|The|This|That|These|Those|A|An|Florida|Southwest|Sarasota|Manatee|Charlotte|Bradenton|Venice|Integrated|Sustainable|Comprehensive|Targeted|Routine|Ongoing|Effective|Proper|Smart|Organic|Natural|General|Basic|Standard|Custom|Year';
const PROVIDER_NAME_SRC = `\\b((?!(?:${GENERIC_LEAD_EXCLUSIONS})\\b)[A-Z][A-Za-z0-9&'.\\-]*(?:\\s+(?:[A-Z][A-Za-z0-9&'.\\-]*|of|and|&)){0,3}\\s+(?:Pest Control|Pest Management|Pest Solutions?|Pest Services?|Exterminators?|Exterminating|Termite (?:&|and) Pest|Environmental(?: Pest)?|Lawn (?:&|and) Pest))\\b`;
function providerNameRe(flags) { return new RegExp(PROVIDER_NAME_SRC, flags); }

// A pest-industry suffix anywhere in a comparison OPTION header marks it as a
// business name (not a category) — so "National Pest Control" / "Bug Off Pest
// Service" are not swallowed by the category regex's generic words. Allowlisted
// businesses are matched earlier; anything else routes to review.
const INDUSTRY_SUFFIX_RE = /\b(pest (?:control|management|solutions?|services?)|exterminat(?:or|ors|ing)|termite (?:&|and) pest|environmental(?: pest)?|lawn (?:&|and) pest)\b/i;

// Legal-entity / possessive markers that signal a business name in an option
// header. Case-sensitive: lowercase "company" in "Local SWFL company" is a
// category descriptor, not a marker.
const BUSINESS_MARKER_RE = /\b[A-Z][a-z]+'s\b|\b(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Co\.|Bros\.?|Brothers|& Sons?)\b/;

// Recognized generic provider CATEGORY / option labels (NOT a named business).
const CATEGORY_OPTION_RE = /\b(national|nationwide|chains?|franchises?|big[\s-]?box|corporate|regional|local(?:ly)?|independent|small(?:er)?|diy|do[\s-]it[\s-]yourself|self[\s-]?treat\w*|home(?:owner)?|store[\s-]bought|over[\s-]the[\s-]counter|professionals?|pros?|quarterly|monthly|annual|seasonal|one[\s-]?time|one[\s-]?off|recurring|reactive|preventive|preventative|on[\s-]demand|subscription|plans?|programs?|packages?|services?|options?|untreated|no treatment|ignoring it|what (?:to|you))\b/i;

const OWN_BRAND_RE = /\bwaves\b/i;

function finding(severity, code, message) {
  return { severity, code, message };
}

/**
 * extractComparisonBlocks(body) → [rawComponentString]
 * Grabs each <ComparisonTable ... /> or <ComparisonTable ...>...</ComparisonTable>.
 */
function extractComparisonBlocks(body) {
  const text = String(body || '');
  const blocks = [];
  const re = /<ComparisonTable\b[\s\S]*?(?:\/>|<\/ComparisonTable>)/gi;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[0]);
  return blocks;
}

/**
 * extractCaption(block) → the caption string (caption="..." / caption={'...'})
 * or ''. The quote backreference (\1) keeps an apostrophe inside a
 * double-quoted caption from closing the match early.
 */
function extractCaption(block) {
  const m = String(block || '').match(/caption\s*=\s*\{?\s*(["'])([\s\S]*?)\1/i);
  return m ? m[2] : '';
}

/** extractColumns(block) → the column header strings (first is the row-label header). */
function extractColumns(block) {
  const m = String(block || '').match(/columns\s*=\s*\{?\s*\[([\s\S]*?)\]/i);
  if (!m) return [];
  const out = [];
  const re = /(["'])([\s\S]*?)\1/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) out.push(mm[2]);
  return out;
}

/**
 * hasAttribution(caption) → true iff the caption carries an "as of <date>" plus
 * a source pointer — the minimum honest attribution for stated competitor facts
 * (the human reviewer still verifies the facts themselves).
 */
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
 * Classifies a single comparison OPTION column header. Business-looking names
 * (industry suffix / legal-entity marker / proper-noun + suffix) are checked
 * BEFORE the category regex so generic words inside a business name ("Bug Off
 * Pest Service", "National Pest Control") cannot pass as a safe category.
 */
function classifyOption(header) {
  const h = String(header || '').trim();
  if (!h) return 'category';
  const mentions = competitorFacts.findBusinessMentions(h);
  if (mentions.some((m) => m.inAllowlist)) return 'known_competitor';
  if (mentions.some((m) => !m.inAllowlist)) return 'unknown_competitor';
  if (INDUSTRY_SUFFIX_RE.test(h) || BUSINESS_MARKER_RE.test(h) || providerNameRe().test(h)) return 'unclassified';
  if (OWN_BRAND_RE.test(h)) return 'own';
  if (CATEGORY_OPTION_RE.test(h)) return 'category';
  return 'unclassified';
}

/**
 * evaluate(draft, { namedCompetitorEnabled }) → { pass, findings }
 *
 * draft: { body | content }
 * namedCompetitorEnabled: feature-gates.namedCompetitorComparison — when false,
 *   a named competitor routes the post to review instead of publishing.
 */
function evaluate(draft, { namedCompetitorEnabled = false } = {}) {
  const body = String(draft?.body || draft?.content || '');
  const findings = [];
  const blocks = extractComparisonBlocks(body);
  // Only comparison/listicle drafts are scrutinized — no table, no scan.
  if (!body || blocks.length === 0) return { pass: true, findings };

  const known = new Set();   // allowlisted competitor display names
  const unknown = new Set(); // recognized brand, not allowlisted (P0)
  const unclassified = new Set(); // business-looking, not categorizable (P1)

  // ── Whole-body scans (the table + its surrounding buyer-guide prose) ──
  const disp = body.match(DISPARAGEMENT_RE);
  if (disp) {
    findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
      `Body contains disparaging language about a provider ("${disp[0]}"). State attributes, never insults — the reader judges.`));
  }
  const rank = body.match(RANKING_RE);
  if (rank) {
    findings.push(finding('P1', 'COMPARISON_RIGGED_RANKING',
      `Body uses ranking/superlative framing ("${rank[0].trim()}"). Present neutral trade-offs and let the reader conclude — do not declare a winner, in the table or the surrounding copy.`));
  }
  for (const m of competitorFacts.findBusinessMentions(body)) {
    (m.inAllowlist ? known : unknown).add(m.name);
  }
  for (const m of body.matchAll(providerNameRe('g'))) {
    const nm = m[1].trim();
    if (OWN_BRAND_RE.test(nm)) continue;
    if (competitorFacts.isKnownCompetitor(nm)) known.add(competitorFacts.findCompetitor(nm).name);
    else unclassified.add(nm); // business-looking name → route to review (fail closed)
  }

  // ── Per-table checks: classify comparison OPTIONS + table-scoped reliability ──
  for (const block of blocks) {
    const options = extractColumns(block).slice(1); // drop the row-label header
    for (const opt of options) {
      const cls = classifyOption(opt);
      if (cls === 'known_competitor') {
        const mm = competitorFacts.findBusinessMentions(opt).find((x) => x.inAllowlist);
        if (mm) known.add(mm.name);
      } else if (cls === 'unknown_competitor') {
        unknown.add(opt.trim());
      } else if (cls === 'unclassified') {
        unclassified.add(opt.trim());
      }
    }
    const neg = block.match(PROVIDER_NEGATIVE_RE);
    if (neg) {
      findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
        `Comparison table makes a negative service-reliability claim about an option ("${neg[0].trim()}"). Routed to human review — phrase it as a neutral, verifiable attribute or remove it.`));
    }
  }

  // Reconcile overlaps so one name yields one finding at its strongest severity:
  // allowlisted (known) > recognized-but-unlisted (unknown, P0) > business-
  // looking (unclassified, P1).
  for (const nm of known) unknown.delete(nm);
  for (const nm of [...unclassified]) {
    if (known.has(nm) || unknown.has(nm)) unclassified.delete(nm);
  }

  // ── Resolve named-business findings ──
  for (const nm of unknown) {
    findings.push(finding('P0', 'COMPARISON_UNKNOWN_COMPETITOR',
      `Names "${nm}", a recognized competitor that is not on the curated competitor-facts allowlist — its attributes cannot be verified. Use a provider CATEGORY (e.g. "National chain", "Local SWFL company") instead, or add "${nm}" to competitor-facts.js with sourced, dated facts.`));
  }
  for (const nm of unclassified) {
    findings.push(finding('P1', 'COMPARISON_UNCLASSIFIED_OPTION',
      `References "${nm}", which looks like a business but is neither a recognized provider category, Waves, nor an allowlisted competitor — routed to human review (fail-closed). Use a category label, or add it to competitor-facts.js if it is a real competitor.`));
  }
  if (known.size) {
    const names = [...known].join(', ');
    if (!namedCompetitorEnabled) {
      findings.push(finding('P1', 'COMPARISON_NAMED_COMPETITOR_DISABLED',
        `Names a competitor (${names}) but named-competitor comparisons are currently disabled (GATE_NAMED_COMPETITOR_COMPARISON). Use a category comparison to publish autonomously, or enable the flag.`));
    } else if (!blocks.some((b) => hasAttribution(extractCaption(b)))) {
      findings.push(finding('P1', 'COMPARISON_COMPETITOR_UNSOURCED',
        `Names a competitor (${names}) but no comparison-table caption carries an "as of <date>" + source attribution. Add e.g. caption="Attributes as of June 2026, per each company's public website."`));
    }
    // else: enabled + allowlisted + sourced + otherwise clean → PASS. The post
    // still goes through the pipeline's trust-build human-approval ramp before
    // publishing (no bespoke, un-approvable review state).
  }

  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  return { pass, findings };
}

module.exports = {
  evaluate,
  extractComparisonBlocks,
  extractCaption,
  extractColumns,
  classifyOption,
  hasAttribution,
  DISPARAGEMENT_RE,
  RANKING_RE,
  PROVIDER_NEGATIVE_RE,
};
