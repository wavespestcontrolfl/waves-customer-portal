/**
 * comparison-table-gate.js — keeps the autonomous writer's <ComparisonTable>
 * "buyer's-guide listicle" honest.
 *
 * The writer may anchor a comparison/"how to choose" post on a <ComparisonTable>
 * (see agents/writer-agent-config.js). This is the constrained, honest version
 * of the AI-citation "listicle play": it earns the "best [service] in [city]"
 * demand by HELPING the reader choose, never by faking a ranking or trashing
 * competitors. This gate enforces that, for EVERY comparison table in a draft:
 *
 *   P0 COMPARISON_DISPARAGEMENT      — derogatory language about any provider
 *   P0 COMPARISON_UNKNOWN_COMPETITOR — a real business is named that is NOT on
 *                                      the curated competitor-facts allowlist
 *                                      (no sourced facts → cannot verify)
 *   P1 COMPARISON_RIGGED_RANKING     — self-declared "winner" / superlative
 *   P1 COMPARISON_NAMED_COMPETITOR_DISABLED — names a competitor while the
 *                                      named-competitor feature is gated off
 *   P1 COMPARISON_COMPETITOR_UNSOURCED — names a competitor but the caption
 *                                      lacks an "as of <date>" + source
 *   P1 COMPARISON_NAMED_COMPETITOR_REVIEW — informational: every named-
 *                                      competitor post routes to a human (never
 *                                      auto-publishes), even when fully sourced
 *
 * Category comparisons ("National chain" vs "Local SWFL company" vs "DIY")
 * name no business, so they only face the disparagement + ranking checks and
 * otherwise pass freely. Pure (no I/O). Returns
 * { pass, findings:[{severity,code,message}] }. P0/P1 block (route to review).
 */

const competitorFacts = require('./competitor-facts');

// Derogatory language about a provider has no place in a factual comparison —
// block outright. Deliberately limited to terms that are almost exclusively
// business-disparagement; words with legitimate pest/efficacy uses ("garbage",
// "useless", "unreliable", "terrible/awful infestation") are intentionally
// EXCLUDED to avoid false positives on real pest copy.
const DISPARAGEMENT_RE = /\b(worst|scams?|rip[\s-]?offs?|ripoffs?|overpriced|goug\w*|incompetent|shady|sketchy|dishonest|untrustworthy|crooks?|frauds?|fraudulent|hidden fees?|bait[\s-]and[\s-]switch|lousy|sloppy|clueless|second[\s-]?rate)\b/i;

// Self-declared ranking / superlative framing — the astroturf tell. Each
// alternative is self-bounding (the leading \b lives INSIDE each word-initial
// branch, not before the group, so non-word starts like "#1" still match). We
// match ranking CLAIMS, not the bare word "best" — but "the best" is banned
// outright, matching the title/meta spam gate.
const RANKING_RE = /(\bthe best\b|#\s?1\b|\bno\.?\s?1\b|\bnumber one\b|\btop[\s-]?rated\b|\bunbeatable\b|\bbest[\s-]in[\s-]class\b|\bhands[\s-]down\b|\bclear winner\b|\bthe winner\b|\bsuperior to\b|\bbetter than (?:everyone|the rest|all others|the competition)\b|\bcrush\w* the competition\b)/i;

function finding(severity, code, message) {
  return { severity, code, message };
}

/**
 * extractComparisonBlocks(body) → [rawComponentString]
 *
 * Grabs each <ComparisonTable ... /> (self-closing) or
 * <ComparisonTable ...>...</ComparisonTable> invocation, newlines included.
 * Heuristic but sufficient: the checks scan the captured region's text.
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

/**
 * hasAttribution(caption) → true iff the caption carries an "as of <date>" plus
 * a source pointer — the minimum honest attribution for stated competitor
 * facts (the human reviewer still verifies the facts themselves).
 */
function hasAttribution(caption) {
  const c = String(caption || '');
  if (!c) return false;
  const hasAsOf = /\bas of\b|\b(?:current|accurate|verified|updated)\s+as of\b|\bas published\b/i.test(c);
  const hasDate = /\b20\d{2}\b/.test(c)
    || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+20\d{2}\b/i.test(c)
    || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(c);
  const hasSource = /\b(source|per |according to|website|public(?:ly)?|state license|sunbiz|bbb|\.com\b|\.org\b|\.gov\b)\b/i.test(c);
  return hasAsOf && hasDate && hasSource;
}

/**
 * evaluate(draft, { namedCompetitorEnabled }) → { pass, findings }
 *
 * draft: { body | content }
 * namedCompetitorEnabled: feature-gates.namedCompetitorComparison — when false,
 *   a named competitor routes the post to review instead of publishing.
 */
function evaluate(draft, { namedCompetitorEnabled = false } = {}) {
  const body = draft?.body || draft?.content || '';
  const blocks = extractComparisonBlocks(body);
  const findings = [];

  for (const block of blocks) {
    const caption = extractCaption(block);

    // 1. Disparagement — never allowed in any comparison table.
    const disp = block.match(DISPARAGEMENT_RE);
    if (disp) {
      findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
        `Comparison table contains disparaging language ("${disp[0]}"). Comparisons must be neutral and factual — state attributes, don't insult a provider.`));
    }

    // 2. Self-declared ranking / superlative framing.
    const rank = block.match(RANKING_RE);
    if (rank) {
      findings.push(finding('P1', 'COMPARISON_RIGGED_RANKING',
        `Comparison table uses ranking/superlative framing ("${rank[0].trim()}"). Present neutral trade-offs and let the reader conclude — do not declare a winner.`));
    }

    // 3. Named businesses. A category comparison names none and passes here.
    const mentions = competitorFacts.findBusinessMentions(block);
    const unknown = mentions.filter((mm) => !mm.inAllowlist);
    const known = mentions.filter((mm) => mm.inAllowlist);

    for (const mm of unknown) {
      findings.push(finding('P0', 'COMPARISON_UNKNOWN_COMPETITOR',
        `Comparison names "${mm.name}", which is not on the curated competitor-facts allowlist — its attributes cannot be verified. Use a provider CATEGORY (e.g. "National chain", "Local SWFL company") instead, or add "${mm.name}" to competitor-facts.js with sourced, dated facts.`));
    }

    if (known.length) {
      const names = known.map((mm) => mm.name).join(', ');
      if (!namedCompetitorEnabled) {
        findings.push(finding('P1', 'COMPARISON_NAMED_COMPETITOR_DISABLED',
          `Comparison names a competitor (${names}) but named-competitor comparisons are currently disabled (GATE_NAMED_COMPETITOR_COMPARISON). Routed to human review; use a category comparison to publish autonomously.`));
      } else if (!hasAttribution(caption)) {
        findings.push(finding('P1', 'COMPARISON_COMPETITOR_UNSOURCED',
          `Comparison names a competitor (${names}) but the caption lacks an "as of <date>" + source attribution. Add e.g. caption="Attributes as of June 2026, per each company's public website."`));
      }
      // Named-competitor comparisons ALWAYS get a human in the loop — even when
      // sourced and enabled, they never auto-publish.
      findings.push(finding('P1', 'COMPARISON_NAMED_COMPETITOR_REVIEW',
        `Comparison names a competitor (${names}); named-competitor posts always route to human review before publishing.`));
    }
  }

  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  return { pass, findings };
}

module.exports = {
  evaluate,
  extractComparisonBlocks,
  extractCaption,
  hasAttribution,
  DISPARAGEMENT_RE,
  RANKING_RE,
};
