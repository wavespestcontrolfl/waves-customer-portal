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
  REENTRY_SAFETY_CLAIM: 'Never describe a pesticide, treatment, or treated area as unconditionally "safe" (including pet-safe/child-safe compounds and "safe for kids and pets"); never write "EPA-approved" (the required wording is EPA-registered or EPA-exempt); never give a fixed re-entry/drying minute figure. The ONLY approved safety idiom is conditional: "safe once dry", with the technician confirming timing.',
  BANNED_TOPIC: 'Waves does NOT offer door-to-door sales, structural fumigation/tenting, insulation, or wildlife/animal trapping — remove every we/our/schedule/call framing around these. A purely informational mention (what the method is, when a specialist handles it) is fine; presenting it as our service is not.',
  COMPARISON_RIGGED_RANKING: 'Remove all ranking/winner framing ("#1", "best", "top-rated", "winner") from the comparison and the title/meta — present neutral trade-offs and let the reader conclude (highlight={} column emphasis is layout and stays fine; a declared winner is not).',
  COMPARISON_COMPETITOR_IN_PROSE: 'Move the SPECIFIC competitor(s) this finding names out of prose, title, and meta — outside your operator brief, a competitor may be named ONLY inside the <ComparisonTable> itself; in the surrounding copy say "national chains" or "other providers" instead. Competitors your operator brief itself names (its binding title/thesis/outline) are authorized and MUST stay as briefed — do not remove those.',
  COMPARISON_UNKNOWN_COMPETITOR: 'Remove every business name that get_competitor_facts did not return — replace each with a generic provider category ("national chain", "local SWFL company", "DIY"); never invent a business name or pull one from web search. EXCEPTION: a business your operator brief itself names (its binding title/thesis/outline) MUST stay in prose/title/meta as briefed — remove it only from the <ComparisonTable> block (columns, cells, headers), where its attributes cannot be validated; keep the table options generic and make the briefed comparison in prose instead.',
  COMPARISON_DISPARAGEMENT: 'Remove all negative or disparaging language about named businesses; comparisons must be neutral and factual.',
  COMPARISON_UNCLASSIFIED_OPTION: 'Every comparison-table option must be either a generic category (no business names) or a competitor from the curated allowlist — replace unlisted names with generic categories.',
  // Affiliate family (owner monetization pilot 2026-08-31). The writer only
  // ever references product IDs its BRIEF supplies — it never invents one,
  // never pastes a retailer URL, and never adds affiliate links unasked.
  UNREGISTERED_AFFILIATE_LINK: 'Remove every <AffiliateLink> whose product id your brief did not explicitly supply — never invent a product id, compute the prop, or paste a retailer/tracking URL; if the brief supplied no affiliate products, this post carries none.',
  AFFILIATE_LINK_WITHOUT_DISCLOSURE: 'This post carries an <AffiliateLink>, so frontmatter.disclosure must be type "affiliate" (FTC material-connection rule) — set it, or remove every affiliate component.',
  AFFILIATE_LINK_IN_META: 'Remove every <AffiliateLink> (and any retailer URL) from title/meta fields — affiliate links are body-only; metas stay informational.',
  AFFILIATE_LINK_ADDED_ON_REFRESH: 'A refresh may preserve the affiliate links the live body already carries but may NEVER add one — remove every <AffiliateLink> the live body does not already contain, occurrence for occurrence.',
  AFFILIATE_LINK_ON_PROTECTED_PAGE: 'This post type never carries affiliate links (it captures local service intent) — remove every <AffiliateLink>; keep the Waves service CTA as the only call to action.',
  PROHIBITED_AFFILIATE_PRODUCT: 'This product is prohibited (restricted-use/professional class or an explicit owner denial) — remove the recommendation entirely; do not substitute another product unless the brief names one.',
  INACTIVE_OR_EXPIRED_AFFILIATE_PRODUCT: 'This affiliate product is not currently active — remove the <AffiliateLink> (a plain unlinked product mention is fine if the prose needs it) or use an active product id your brief supplies.',
  PESTICIDE_LINK_WITHOUT_CURRENT_LABEL_REVIEW: 'This consumer-pesticide product\'s manual label review is missing or stale, so it cannot be linked — remove the <AffiliateLink>; the product may be discussed in prose under the normal product-claim rules but not linked until the owner re-verifies its registry row.',
  AFFILIATE_PLACEMENT_NOT_ALLOWED: 'Every <AffiliateLink> needs a quoted literal placement="…" id that the product allows (your brief names the allowed placements; use primary-rec unless told otherwise) — never omit, compute, or invent a placement.',
  SERVICE_CTA_MISSING_FROM_LOCAL_ARTICLE: 'Add a Waves service CTA link (e.g. /pest-control-calculator/, /quote/, or the relevant city-service page) BEFORE any product recommendation — affiliate links are fallback monetization; the service CTA stays primary.',
  EXCESSIVE_AFFILIATE_LINK_DENSITY: 'Cap affiliate links at 3 per post and keep the opening section product-free — answer the reader\'s question first, then recommend at most one primary product and one alternative later in the piece.',
  INVALID_INLINECTA_DESTINATION: 'Every <InlineCTA ctaHref> must be a single quoted literal that is a root-relative path (no dot segments) or an https URL — never a spread, expression, duplicate, or any other scheme; omit ctaHref entirely to use the default quote page.',
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
