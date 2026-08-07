/**
 * gate-retry-directives.js — canonical redraft directives for hard content
 * gate findings.
 *
 * SINGLE source for the finding-code -> corrective-instruction map, consumed
 * by BOTH redraft feedback paths:
 *   - content-brief-builder (run-level: a rejected draft gets exactly one
 *     feedback-informed redraft via voice_constraints.retry_directives), and
 *   - brief-driven-tools emit_draft (in-loop: the writer self-lints at
 *     capture and redrafts inside the same agent session).
 *
 * Dependency-free on purpose so the agent-tools module can require it
 * without the brief builder's full graph (db/queue/router).
 */

// the runner deferred it for exactly one feedback-informed redraft
// (autonomous-runner._gateFailRetryOrSkip). Translate the recorded findings
// into binding writer directives; known codes get a corrective instruction,
// unknown ones fall back to the gate's own finding text. Rides in
// voice_constraints.retry_directives (persisted jsonb → returned intact by
// the writer agent's get_content_brief tool).
const GATE_RETRY_INSTRUCTIONS = {
  HARDCODED_PRICE: 'Do NOT write any specific dollar amount or price anywhere in the draft — link /pest-control-calculator/ wherever cost comes up.',
  FAQ_BLOCKED_SERVICE: 'Do NOT include an FAQ section or FAQ-style Q&A for this service — FAQ treatment is policy-blocked for it. Cover the material as normal prose sections instead.',
  DISALLOWED_EXTERNAL_LINK: 'Only link external domains from the approved source list already cited in the brief/facts pack; remove every other external link.',
  UNKNOWN_INTERNAL_ROUTE: 'Remove or replace every internal link that is not in the brief\'s internal_links_to_add, the allowlisted site pages, or a real /{service-slug}-{city}-fl/ city page — never link a guessed or remembered route; if unsure a page exists, link the hub or calculator instead.',
  CITATION_TOKEN_RESIDUE: 'Strip ALL citation markup — <cite> tags, index="N" tokens, [^footnote] markers, citeturn/oaicite/:contentReference tokens, 【…】 brackets. Attribute sources in plain prose ("per UF/IFAS…") with no scaffolding of any kind.',
  OFF_FOOTPRINT_CITY_CLAIM: 'Remove every service claim naming a city outside the Waves footprint — either drop the city or rewrite it as a purely educational mention with NO serve/schedule/call/book/your-home language attached. The gate attaches that language across structure, not just sentences: a heading, colon-terminated list introduction ("We serve these cities:"), or table header carrying service/CTA wording taints EVERY bullet/cell under it — restructure those too, not only same-sentence wording.',
  PRODUCT_CLAIM: 'Remove active-ingredient names and every recommendation/usage/efficacy claim about professional products — never state or imply what Waves technicians carry, use, or recommend. A professional product may remain as the INFORMATIONAL TOPIC of the piece (what it is, how it is designed to work per its label), so keep the brief\'s target keyword and title intact and strip only the offending claim sentences.',
  PREVENTION_PROMISE: 'Remove every promise that pests are prevented, eliminated, or won\'t return — describe REDUCED recurrence instead, always conditional, never guaranteed. Mention free re-treatment between visits ONLY if the piece concerns recurring WaveGuard plan coverage; one-time, termite, rodent, mosquito, and tree-and-shrub-only topics and DIY guides are not re-service eligible, so soften the outcome claim there WITHOUT promising a callback.',
  REENTRY_SAFETY_CLAIM: 'Never describe treatments, treated areas, or re-entry as "safe" (including pet-safe/child-safe compounds and "safe for kids and pets"), and never cite EPA registration as an endorsement — replace with label-directed phrasing: "follow the label re-entry directions", "once the application is dry per the label".',
  BANNED_TOPIC: 'Waves does NOT offer door-to-door sales, structural fumigation/tenting, insulation, or wildlife/animal trapping — remove every we/our/schedule/call framing around these. A purely informational mention (what the method is, when a specialist handles it) is fine; presenting it as our service is not.',
  COMPARISON_RIGGED_RANKING: 'Remove all ranking/winner framing ("#1", "best", "top-rated", "winner") from the comparison and the title/meta — present neutral trade-offs and let the reader conclude (highlight={} column emphasis is layout and stays fine; a declared winner is not).',
  COMPARISON_COMPETITOR_IN_PROSE: 'Move the SPECIFIC competitor(s) this finding names out of prose, title, and meta — outside your operator brief, a competitor may be named ONLY inside the <ComparisonTable> itself; in the surrounding copy say "national chains" or "other providers" instead. Competitors your operator brief itself names (its binding title/thesis/outline) are authorized and MUST stay as briefed — do not remove those.',
  COMPARISON_UNKNOWN_COMPETITOR: 'Remove every business name that get_competitor_facts did not return — replace each with a generic provider category ("national chain", "local SWFL company", "DIY"); never invent a business name or pull one from web search. EXCEPTION: a business your operator brief itself names (its binding title/thesis/outline) MUST stay in prose/title/meta as briefed — remove it only from the <ComparisonTable> block (columns, cells, headers), where its attributes cannot be validated; keep the table options generic and make the briefed comparison in prose instead.',
  COMPARISON_DISPARAGEMENT: 'Remove all negative or disparaging language about named businesses; comparisons must be neutral and factual.',
  COMPARISON_UNCLASSIFIED_OPTION: 'Every comparison-table option must be either a generic category (no business names) or a competitor from the curated allowlist — replace unlisted names with generic categories.',
};

// The header defaults to the RUN-LEVEL framing (one feedback-informed
// redraft, then the draft is discarded). The in-loop self-lint passes its
// own header — inside the agent session the draft is retried immediately,
// so the "final attempt" language would be false there.
function buildRetryDirectives(gateRetry, { header } = {}) {
  const findings = Array.isArray(gateRetry?.findings) ? gateRetry.findings : [];
  // Always carry the gate's own finding text alongside the canonical
  // directive: the message names the OFFENDING entity (which competitor,
  // which city, which product), and without it a directive like "move the
  // competitor this finding names" gives the sole redraft nothing to act on
  // (Codex r4).
  const directives = findings.map((f) => {
    const canonical = GATE_RETRY_INSTRUCTIONS[f.code];
    if (!canonical) return `Previous draft failed ${f.severity || 'P0'} ${f.code || 'gate check'}${f.message ? `: ${f.message}` : ''} — do not repeat it.`;
    return f.message ? `${canonical} [Gate reported: ${f.message}]` : canonical;
  });
  return [
    header || 'PREVIOUS ATTEMPT REJECTED by hard content gates. This is the final attempt — the draft is discarded (never published, never reviewed) if any of these repeat:',
    ...Array.from(new Set(directives)),
  ];
}


module.exports = { GATE_RETRY_INSTRUCTIONS, buildRetryDirectives };
