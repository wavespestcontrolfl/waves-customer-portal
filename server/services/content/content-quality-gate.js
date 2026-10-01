/**
 * content-quality-gate.js — page-type-specific QA gate. Applied to
 * every draft before auto-publish. Min total score 75; any hard-gate
 * failure routes the draft to pending_review regardless of score.
 *
 * Per v3.1 plan:
 *
 *   Common to all page types (hard checks):
 *     schema_valid, title_meta_spam_free, no_duplicate_intent,
 *     serp_brief_attached, gsc_signal_attached,
 *     canonical_self_referencing, indexable, sitemap_updated,
 *     preview_success
 *
 *   Extra checks by page type:
 *     city-service        nap_consistent, local_proof_present,
 *                         cta_above_fold, service_menu_present,
 *                         FAQ_from_customer_calls, LocalBusiness+Service schema,
 *                         redaction_passed
 *     customer-question   answer_in_first_paragraph,
 *                         source_internal_link, redaction_passed,
 *                         (FAQPage schema NOT required — deprecated May 7 2026)
 *     refresh             improvement_over_prior
 *     supporting-blog     hub_link_present, 2+ city mentions,
 *                         FAQ section, voice-match score
 *     metadata-rewrite    length bounds, primary keyword in title,
 *                         no duplicate title across site
 *
 * Pure functions. The gate scores each check 0..n (per a weight map)
 * and pass/fail. Total score is sum; gate requires zero hard-check
 * failures AND score >= the page type's threshold: 75% of its own
 * achievable ceiling, floored so it always tolerates at most one
 * worst-case soft-check miss beyond the hard checks.
 */

const { THRESHOLDS } = require('./scoring-config');
const { evaluateTitleMetaSpam, renderMetaTokens, PHONE_TOKEN_RE, CITY_PHONE_TOKEN_RE, SALESY_META_RE, endsWithSoftCta, metaHasSalesCopy, BARE_PHONE_DIGITS_RE } = require('./title-meta-spam-gate');
const { isFaqBlockedService } = require('./content-guardrails');

// Compute the achievable maximum score PER PAGE TYPE so the pass
// threshold is always a reachable fraction of that page type's own
// ceiling. The v3.1 plan wanted "min total ~75%" — an earlier global
// threshold derived from the LARGEST bundle (common 37 + city-service
// 36 = 73 → 54) made the gate unpassable for smaller bundles: refresh
// maxes at 47, so a PERFECT refresh scored 47/54 and gate-failed
// (prod, 2026-06-12), and supporting-blog maxes at 57, so any single
// soft miss worth >3 points sank the post.
const PASS_THRESHOLD_PCT = 0.75;

function computeMinTotalScores(hardChecks, pageTypeChecks) {
  const commonSum = hardChecks.reduce((s, c) => s + c.weight, 0);
  const thresholds = {};
  for (const [pageType, checks] of Object.entries(pageTypeChecks)) {
    const ceiling = commonSum + checks.reduce((s, c) => s + c.weight, 0);
    let min = Math.floor(ceiling * PASS_THRESHOLD_PCT);
    // The threshold must demand more than the hard checks alone — ok
    // already requires zero hard failures, so a threshold at or below
    // the hard sum tolerates a draft missing EVERY soft check (e.g.
    // supporting-blog: 37 common + 6 hub = 43 >= the formula's 42 with
    // cities/FAQ/voice all failed). When the percentage formula lands
    // there, raise it to "one worst-case soft miss": ceiling minus the
    // largest single soft weight (= ceiling itself for all-hard bundles).
    const hardSum = commonSum + checks.filter((c) => c.isHard).reduce((s, c) => s + c.weight, 0);
    const maxSoftWeight = checks.filter((c) => !c.isHard).reduce((m, c) => Math.max(m, c.weight), 0);
    if (min <= hardSum) min = ceiling - maxSoftWeight;
    thresholds[pageType] = min;
  }
  return thresholds;
}

// Computed below after the check arrays are defined.
let MIN_TOTAL_SCORES;

// Unknown page types HARD-FAIL in evaluate() (fail closed — a typo'd
// or legacy page_type must not bypass its real bundle's hard checks by
// gating on commons alone). The .none fallback here only keeps the
// reported min_total_score sane on that failure path. hasOwnProperty
// guards against prototype-chain keys ('constructor' etc.).
function minTotalScoreFor(pageType) {
  return Object.prototype.hasOwnProperty.call(MIN_TOTAL_SCORES, pageType)
    ? MIN_TOTAL_SCORES[pageType]
    : MIN_TOTAL_SCORES.none;
}

// Each check carries (name, weight, isHard, evaluate(draft, brief)).
// Hard checks are pass/fail and short-circuit publishing on failure.
// Soft checks contribute weighted score.

const HARD_CHECKS = [
  { name: 'schema_valid', weight: 8, evaluate: checkSchemaValid },
  { name: 'title_meta_spam_free', weight: 0, evaluate: checkTitleMetaSpamFree },
  // Truncation guard: the length BAND lives in title-meta-spam-gate (meta
  // >190 hard / >160 soft) — this is the COMPLETENESS complement. Weight 0,
  // same as title_meta_spam_free: pure hard gate, no score contribution.
  { name: 'meta_description_complete', weight: 0, evaluate: checkMetaDescriptionComplete },
  { name: 'serp_brief_attached', weight: 4, evaluate: checkSerpBriefAttached },
  { name: 'gsc_signal_attached', weight: 4, evaluate: checkGscSignalAttached },
  { name: 'no_duplicate_intent', weight: 6, evaluate: checkNoDuplicateIntent },
  { name: 'canonical_self_referencing', weight: 4, evaluate: checkCanonical },
  { name: 'indexable', weight: 4, evaluate: checkIndexable },
  { name: 'sitemap_updated', weight: 3, evaluate: checkSitemapUpdated },
  { name: 'preview_success', weight: 4, evaluate: checkPreviewSuccess },
  // Owner rule 2026-08-27: tabular data renders via <ComparisonTable>,
  // never a raw markdown pipe table (unstyled prose + bypasses the
  // comparison gate's honesty regime). Common because EVERY body-producing
  // lane must honor it (supporting-blog, city-service, customer-question,
  // refresh); bodyless lanes (metadata) pass trivially on an empty body.
  { name: 'no_raw_markdown_tables', weight: 0, evaluate: checkNoRawMarkdownTables },
  // Owner ruling 2026-08-28: bodies outside the writer's plain Markdown
  // subset park for human review instead of being parsed (fail-closed).
  { name: 'body_syntax_supported', weight: 0, evaluate: checkBodySyntaxSupported },
  // Owner ruling 2026-09-28 (work order C2): every identification
  // (post_type "diagnostic") or customer-question draft must open on the
  // verdict box, never a pitch. Weight 0 — pure hard gate, matches the
  // other structural checks above.
  { name: 'verdict_box_first', weight: 0, evaluate: checkVerdictBoxFirst },
  { name: 'cta_after_verdict_box', weight: 0, evaluate: checkCtaAfterVerdictBox },
  // Owner ruling 2026-09-28 (work order C3): an identification draft's
  // pest/sign/look-alike photos are a CLOSED set — exactly the licensed
  // URLs the brief's voice_constraints.photo_slots supplied. Common (not
  // page-type-scoped) because post_type is independent of page_type.
  { name: 'photo_slots_licensed_only', weight: 0, evaluate: checkPhotoSlotsLicensedOnly },
  // next_steps can ship on any body lane (supporting blogs included), so
  // their PII scan is common — next_steps only, never a body (#5216 r4).
  { name: 'next_steps_redacted', weight: 0, evaluate: checkNextStepsRedacted },
  // (C2 frontmatter next_steps / related_posts are NOT checked here: they
  // render as links, so content-guardrails.evaluate() judges them with the
  // body-link chokepoints — Codex r2 on #5216.)
];

const PAGE_TYPE_CHECKS = {
  'city-service': [
    { name: 'nap_consistent', weight: 6, evaluate: checkNapConsistent },
    { name: 'local_proof_present', weight: 6, evaluate: checkLocalProof },
    { name: 'cta_above_fold', weight: 6, evaluate: checkCtaAboveFold },
    { name: 'service_menu_present', weight: 6, evaluate: checkServiceMenu },
    { name: 'faq_from_customer_calls', weight: 6, evaluate: checkFaqFromCustomer },
    { name: 'localbusiness_service_schema', weight: 6, isHard: true, evaluate: checkLocalBusinessServiceSchema },
    // Owner rule 2026-07-29: non-blog metas carry {{cityPhone}} — weight 0
    // like title_meta_spam_free (pure hard gate, thresholds unchanged).
    { name: 'meta_phone_token_present', weight: 0, isHard: true, evaluate: checkCityServiceMetaPhone },
    { name: 'meta_rendered_length_in_bounds', weight: 0, isHard: true, evaluate: checkAuthoredMetaLength },
    // Hard: city-service bodies are built from customer-derived signals
    // (FAQ-from-calls, local proof) exactly like customer-question pages,
    // but this was the ONE body-writing lane with no publish-time PII
    // check — a customer name/phone/email surviving the insights miner's
    // redactor published unchecked. Same check the customer-question
    // bundle enforces.
    { name: 'redaction_passed', weight: 8, isHard: true, evaluate: checkRedactionPassed },
  ],
  'customer-question': [
    // Both hard: commons (37) + redaction (8) = 45 already clears this
    // type's threshold (44), so as soft checks a question page that
    // neither answers up front nor links anywhere internal would pass.
    // Answer-up-front is what a customer-question page IS; a page with
    // zero internal links is an orphan dead-end.
    { name: 'answer_in_first_paragraph', weight: 8, isHard: true, evaluate: checkAnswerInFirstParagraph },
    { name: 'source_internal_link', weight: 6, isHard: true, evaluate: checkSourceInternalLink },
    { name: 'redaction_passed', weight: 8, isHard: true, evaluate: checkRedactionPassed },
  ],
  refresh: [
    // Hard: refresh edits an EXISTING prod page, and the common checks
    // alone (37, all hard) clear refresh's threshold (35) — if this were
    // soft, a refresh that guts >20% of prior content or has no prior
    // version to compare would still pass on common points alone.
    { name: 'improvement_over_prior', weight: 10, isHard: true, evaluate: checkImprovementOverPrior },
    // Citability backfill only (isCitabilityBackfillBrief): every planned
    // gap must clear and no trait the live page already had may be lost
    // before the refresh may publish and complete its row. Weight-0 hard,
    // so an unresolved row gets its one feedback redraft, then skips —
    // never 'done' with open gaps. Every other refresh answers ok.
    { name: 'citability_backfill_gaps_cleared', weight: 0, isHard: true, evaluate: checkCitabilityBackfillGapsCleared },
    // Blog refreshes use this bundle too. These remain weight-zero signals;
    // nonBlogTarget() makes them no-ops for ordinary service/city pages.
    { name: 'citability_named_sources', weight: 0, evaluate: checkCitabilityNamedSources },
    { name: 'citability_concrete_specifics', weight: 0, evaluate: checkCitabilityConcreteSpecifics },
    { name: 'citability_comparison', weight: 0, evaluate: checkCitabilityComparison },
    { name: 'citability_how_to_choose', weight: 0, evaluate: checkCitabilityHowToChoose },
  ],
  'supporting-blog': [
    // Hard: hub links are the point of a supporting blog (hub-and-spoke
    // link equity), and the writer instructions promise the gate enforces
    // them. As a 6-pt soft miss, a hubless draft scores 51 >= 42 and
    // auto-publishes — the exact A1 first-batch failure shape.
    { name: 'hub_link_present', weight: 6, isHard: true, evaluate: checkHubLinkPresent },
    { name: 'two_plus_city_mentions', weight: 4, evaluate: checkTwoPlusCityMentions },
    { name: 'faq_section_present', weight: 4, evaluate: checkFaqSectionPresent },
    { name: 'voice_match', weight: 6, evaluate: checkVoiceMatch },
    // Owner rule 2026-07-29: blog metas carry NO phone and nothing salesy.
    // Weight 0 hard gate — without it a freshly authored blog meta bypassed
    // the metadata-lane check entirely. The soft-CTA ending was demoted out
    // of the hard contract 2026-07-30 (owner ruling) to the soft check below.
    { name: 'blog_meta_contract', weight: 0, isHard: true, evaluate: checkBlogMetaContract },
    { name: 'blog_meta_soft_cta', weight: 0, evaluate: checkBlogMetaSoftCta },
    { name: 'meta_rendered_length_in_bounds', weight: 0, isHard: true, evaluate: checkAuthoredMetaLength },
    // Citability nudges (2026-09-25): the traits AI answer engines cite —
    // a named source behind the claims, supported facts stated as numbers
    // with units, a ComparisonTable wherever the reader faces a choice, and a
    // "How to choose" section beside it. Weight 0 like blog_meta_soft_cta:
    // signal-only BY DESIGN — the writer prompt forbids a stat quota and
    // invented products/sources, so a weighted check would pressure the
    // writer toward fabrication. They ride the redraft feedback and the
    // review queue (soft_failures) without moving the pass threshold.
    { name: 'citability_named_sources', weight: 0, evaluate: checkCitabilityNamedSources },
    { name: 'citability_concrete_specifics', weight: 0, evaluate: checkCitabilityConcreteSpecifics },
    { name: 'citability_comparison', weight: 0, evaluate: checkCitabilityComparison },
    { name: 'citability_how_to_choose', weight: 0, evaluate: checkCitabilityHowToChoose },
  ],
  metadata: [
    { name: 'title_length_in_bounds', weight: 6, isHard: true, evaluate: checkTitleLengthBounds },
    { name: 'meta_length_in_bounds', weight: 6, isHard: true, evaluate: checkMetaLengthBounds },
    { name: 'primary_keyword_in_title', weight: 6, evaluate: checkPrimaryKeywordInTitle },
    { name: 'no_duplicate_title', weight: 8, isHard: true, evaluate: checkNoDuplicateTitle },
    // Owner rule 2026-07-29: every meta carries the page's phone — as the
    // {{cityPhone}} TOKEN (pages render on many domains with different
    // tracking numbers; a typed-out number shows the wrong phone). Weight 0
    // like title_meta_spam_free: pure hard gate, no score contribution, so
    // the metadata threshold math is unchanged.
    { name: 'meta_phone_token_present', weight: 0, isHard: true, evaluate: checkMetaPhoneTokenPresent },
    // Blog-target rewrites lost the soft-CTA nudge when it left the hard
    // contract (2026-07-30 ruling) — same weight-0 soft signal as the
    // supporting-blog bundle; skips page targets via target_page_type.
    { name: 'blog_meta_soft_cta', weight: 0, evaluate: checkBlogMetaSoftCta },
  ],
  links: [],
  gbp: [],
  none: [],
};

// Resolve per-page-type thresholds now that check arrays are defined.
// Common hard checks sum to 37. Ceiling → threshold per page type
// (75% of ceiling, floored at one-worst-case-soft-miss — see
// computeMinTotalScores):
//   city-service      37+44 = 81 → 60 (75% formula; hard sum 51)
//   customer-question 37+22 = 59 → 59 (all-hard bundle)
//   refresh           37+10 = 47 → 47 (all-hard bundle)
//   supporting-blog   37+20 = 57 → 51 (= 57 - voice 6; formula's 42 sat
//                                      below the 43 hard sum)
//   metadata          37+26 = 63 → 57 (= 63 - keyword 6)
//   links/gbp/none    37+0  = 37 → 37 (common-only)
MIN_TOTAL_SCORES = computeMinTotalScores(HARD_CHECKS, PAGE_TYPE_CHECKS);

// ── main API ────────────────────────────────────────────────────────

/**
 * evaluate(draft, brief, context)
 *
 * draft: { url?, body, title?, meta_description?, frontmatter?, schema? }
 * brief: row from content_briefs.
 * context: {
 *   siblingTitles?: Set<string> — existing titles on the site (for no_duplicate_title),
 *   previousVersion?: { body, word_count } — for refresh comparison,
 *   previewBuildSuccess?: bool — Cloudflare Pages preview status,
 *   sitemapHasUrl?: bool — whether sitemap.xml currently contains target URL,
 * }
 *
 * Returns {
 *   ok, total_score, hard_failures: [], soft_failures: [],
 *   checks: { [name]: { ok, score, reason? } }
 * }
 *
 * ok requires:
 *   - zero hard_failures
 *   - total_score >= the page type's threshold (see computeMinTotalScores)
 */
function evaluate(draft, brief, context = {}) {
  if (!draft) throw new Error('content-quality-gate: draft required');
  if (!brief) throw new Error('content-quality-gate: brief required');

  const pageType = brief.page_type || 'none';
  // Fail closed on unrecognized page types: every known type maps to a
  // bundle here ('links'/'gbp'/'none' are EXPLICIT empty bundles), so an
  // unknown value means a typo, a legacy alias, or drift — and silently
  // gating it on commons alone (37 vs the 27 'none' threshold) would
  // bypass that type's real hard checks (hub_link_present,
  // answer_in_first_paragraph, improvement_over_prior).
  const knownPageType = Object.prototype.hasOwnProperty.call(PAGE_TYPE_CHECKS, pageType);
  const allChecks = [
    ...HARD_CHECKS.map((c) => ({ ...c, isHard: true })),
    ...(knownPageType ? PAGE_TYPE_CHECKS[pageType] : []),
  ];

  const results = {};
  const hardFailures = [];
  const softFailures = [];
  let totalScore = 0;

  if (!knownPageType) {
    hardFailures.push({ name: 'known_page_type', reason: `unknown_page_type:${pageType}` });
  }

  for (const check of allChecks) {
    let result;
    try {
      result = check.evaluate(draft, brief, context);
    } catch (err) {
      result = { ok: false, reason: `evaluator_threw:${err.message}` };
    }
    if (typeof result !== 'object' || result === null) result = { ok: !!result };
    result.weight = check.weight;
    if (result.ok) totalScore += check.weight;
    else if (check.isHard) hardFailures.push({ name: check.name, reason: result.reason });
    else softFailures.push({ name: check.name, reason: result.reason });
    results[check.name] = result;
  }

  const minTotalScore = minTotalScoreFor(pageType);
  const ok = hardFailures.length === 0 && totalScore >= minTotalScore;
  return {
    ok,
    total_score: totalScore,
    min_total_score: minTotalScore,
    hard_failures: hardFailures,
    soft_failures: softFailures,
    checks: results,
  };
}

// ── HARD checks ──────────────────────────────────────────────────────

function checkSchemaValid(draft, brief) {
  // A refresh cannot change schema: publishRefresh starts from the live
  // frontmatter and overrides only the editable meta fields
  // (REFRESH_EDITABLE_META_FIELDS), and the layout renders the page's
  // JSON-LD. Grading the draft's own schema block hard-failed refreshes
  // over a field that never publishes (prod run b48a687d: no_schema_block).
  if (brief?.action_type === 'refresh_existing_page') return { ok: true, reason: 'refresh_schema_frozen_to_live_page' };
  const schema = draft.schema || draft.frontmatter?.schema;
  if (!schema) return { ok: false, reason: 'no_schema_block' };
  if (typeof schema === 'object') return { ok: true };
  // String schema must parse as JSON-LD.
  try { JSON.parse(schema); return { ok: true }; }
  catch { return { ok: false, reason: 'schema_not_valid_json' }; }
}

function checkTitleMetaSpamFree(draft, brief, context) {
  const result = evaluateTitleMetaSpam({
    // protectedTitle: the target's rendered title is a protected service/
    // location metaTitle the publisher will keep regardless of the draft
    // (owner rule 2026-07-16) — spam-checking the discarded proposal would
    // gate text that can never ship. Blank title makes inspectTitle skip;
    // the meta-description half still runs in full.
    title: context?.protectedTitle ? '' : (draft.title || draft.frontmatter?.title),
    meta_description: draft.meta_description || draft.frontmatter?.meta_description,
    city: brief.city,
    service: brief.service,
    target_keyword: brief.target_keyword,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.hard_failures.map((f) => f.reason || f.code).join(','),
      soft_warnings: result.soft_failures,
    };
  }
  return {
    ok: true,
    soft_warnings: result.soft_failures,
  };
}

// Meta descriptions that read as CUT OFF — no terminal punctuation, a
// trailing ellipsis, or a dangling article/preposition/conjunction before
// the period — shipped on generated posts (truncated mid-sentence metas were
// a recurring Codex finding). The publisher's sentence-aware clamp fixes the
// overflow path; this hard check parks drafts whose meta was AUTHORED
// truncated. Absence is not failed here — presence/length are owned by the
// schema + title-meta-spam checks.
const DANGLING_META_ENDINGS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'to', 'of', 'for', 'with',
  'in', 'on', 'at', 'by', 'from', 'into', 'over', 'under', 'near', 'about',
  'between', 'during', 'without', 'within', 'vs', 'versus', 'than', 'as',
  'if', 'when', 'while', 'because', 'that', 'which', 'your', 'our', 'their',
  'its', 'his', 'her', 'my',
]);

function checkMetaDescriptionComplete(draft, brief) {
  // Two meta contracts. snake_case meta_description on a BLOG draft gets
  // the full complete-sentence check. Snippet-style metas are legitimate on
  // the non-blog surfaces — camelCase metaDescription (service/location
  // refresh casing) AND metadata-only rewrites (page_type 'metadata', whose
  // emit_metadata_only result is copied into top-level meta_description
  // regardless of target page type) — there only authored TRUNCATION
  // (ellipsis) is a hard fail.
  const blogMeta = (draft.meta_description || draft.frontmatter?.meta_description || '').trim();
  const refreshMeta = (draft.metaDescription || draft.frontmatter?.metaDescription || '').trim();
  // When BOTH casings exist, camelCase is the RENDERED service/location
  // field (publishMetadataRewrite treats snake_case duplicates as dead
  // fields) — judge the rendered value, snippet-style.
  const m = refreshMeta || blogMeta;
  if (!m) return { ok: true, reason: 'no_meta_to_check' };
  if (/(\.\.\.|…)["'”’)\]]*$/.test(m)) return { ok: false, reason: 'meta_ends_with_ellipsis' };
  // Full sentence check applies only to BLOG-contract metas: a snake_case
  // blog draft, or a metadata rewrite whose TARGET is a blog post
  // (target_page_type rides on the wrapped metadata brief). Everything else
  // — service/location refresh casings and non-blog metadata rewrites — is
  // legitimate snippet style, gated on truncation only above.
  // Classified by PAGE TYPE, not meta casing: city-service and
  // customer-question drafts also carry snake_case meta_description but are
  // snippet-legitimate surfaces. Only supporting-blog (directly, or as a
  // metadata rewrite's resolved target) gets the full sentence contract;
  // briefs without a page_type fall back to the casing heuristic (legacy
  // scheduler drafts are blogs).
  // 'refresh' says nothing about the TARGET either — a refresh that
  // rewrites a blog post's meta_description keeps the full blog contract.
  // The runner resolves target_page_type from the actual astro file (same
  // derivation as the metadata lane); a refresh brief that arrives without
  // it falls back to the casing heuristic (snake_case-only = blog).
  const pt = brief?.page_type;
  const casingHeuristicIsBlog = Boolean(blogMeta) && !refreshMeta;
  const isBlogTarget = pt === 'metadata'
    ? brief?.target_page_type === 'supporting-blog'
    : pt === 'refresh'
      ? (brief?.target_page_type ? brief.target_page_type === 'supporting-blog' : casingHeuristicIsBlog)
      : (pt ? pt === 'supporting-blog' : casingHeuristicIsBlog);
  if (!isBlogTarget) return { ok: true, reason: 'snippet_style_meta_allowed' };
  const core = m.replace(/["'”’)\]]+$/, '');
  if (!/[.!?]$/.test(core)) return { ok: false, reason: 'meta_missing_terminal_punctuation' };
  const beforePunct = core.replace(/[.!?]+$/, '').trim();
  const lastWord = (beforePunct.split(/\s+/).pop() || '').toLowerCase().replace(/[^a-z']/g, '');
  if (DANGLING_META_ENDINGS.has(lastWord)) {
    return { ok: false, reason: `meta_ends_with_dangling_word_${lastWord}` };
  }
  return { ok: true };
}

function isPageOnlyOpportunity(brief) {
  // brief-builder intentionally skips SERP profiling when the
  // opportunity has no keyword (e.g. decay_refresh on a known page
  // URL). Page-only briefs cannot satisfy a serp_signal check by
  // construction, so the SERP hard check must skip for them.
  return !brief.target_keyword && Boolean(brief.target_url);
}

// Operator-authored intercept briefs (intercept-brief-seeder, bucket
// 'operator_intercept') are composed WITHOUT SERP profiling or mined GSC
// numbers — the operator manifest IS the provenance these two
// evidence-attachment hard checks exist to verify. Without the exemption
// every intercept brief would hard-fail no_serp_signal / no_gsc_signal and
// the auto-publish lane would silently skip the row. Keyed on the
// persisted gsc_signal.bucket so the exemption survives a content_briefs
// round-trip and cannot be spoofed by a draft.
function isOperatorAuthoredBrief(brief) {
  const s = brief?.gsc_signal;
  return !!s && s.bucket === 'operator_intercept';
}

function checkSerpBriefAttached(_draft, brief) {
  if (isOperatorAuthoredBrief(brief)) {
    return { ok: true, reason: 'operator_authored_brief' };
  }
  if (isPageOnlyOpportunity(brief)) {
    return { ok: true, reason: 'serp_skip_page_only' };
  }
  const s = brief.serp_signal;
  if (!s || !s.dominant_intent) return { ok: false, reason: 'no_serp_signal' };
  return { ok: true };
}

// competitor_gap briefs (competitor-gap-miner) have zero GSC footprint by
// construction — the gap IS the opportunity. Their evidence is the
// competitor's ranking + search volume, persisted into gsc_signal by the
// brief builder. Keyed on the persisted gsc_signal.bucket (same
// anti-spoofing rationale as isOperatorAuthoredBrief); the evidence fields
// must actually be present, so a competitor_gap row that somehow lost its
// provenance still hard-fails.
function isCompetitorGapBrief(brief) {
  const s = brief?.gsc_signal;
  return !!s && s.bucket === 'competitor_gap'
    && s.competitor_position != null && s.search_volume != null
    // The domain is part of the provenance contract — without it the
    // reviewer can't audit the competitor source, so the gate must not
    // waive GSC evidence on numbers alone.
    && !!s.competitor_domain;
}

// aeo_question_gap briefs (gsc-opportunity-miner) can be admitted on
// answer-engine evidence alone: a benchmark question whose target page
// several engines don't cite, where that page has no GSC impressions (or
// doesn't exist yet). That evidence rides the persisted gsc_signal — same
// keying and presence rule as isCompetitorGapBrief, so a row that lost its
// provenance still hard-fails.
function isAeoQuestionGapBrief(brief) {
  const s = brief?.gsc_signal;
  return !!s && s.bucket === 'aeo_question_gap'
    && !!s.aeo_benchmark_id
    && Array.isArray(s.aeo_engines_missing) && s.aeo_engines_missing.length > 0;
}

// citability_backfill briefs (citability-backfill-seeder) are page-anchored
// refreshes mined from a corpus SCAN, not from GSC: the scan result — a
// non-empty gsc_signal.citability_gaps list — IS the provenance. Same
// anti-spoofing key (persisted gsc_signal.bucket) and presence rule as
// isCompetitorGapBrief: a backfill brief that lost its gap list still
// hard-fails no_gsc_signal.
function isCitabilityBackfillBrief(brief) {
  const s = brief?.gsc_signal;
  return !!s && s.bucket === 'citability_backfill'
    && Array.isArray(s.citability_gaps) && s.citability_gaps.length > 0;
}

function checkGscSignalAttached(_draft, brief) {
  if (isOperatorAuthoredBrief(brief)) {
    return { ok: true, reason: 'operator_authored_brief' };
  }
  if (isCompetitorGapBrief(brief)) {
    return { ok: true, reason: 'competitor_gap_evidence' };
  }
  if (isAeoQuestionGapBrief(brief)) {
    return { ok: true, reason: 'aeo_question_gap_evidence' };
  }
  if (isCitabilityBackfillBrief(brief)) {
    return { ok: true, reason: 'citability_backfill_scan_evidence' };
  }
  const s = brief.gsc_signal;
  if (!s || s.impressions == null) return { ok: false, reason: 'no_gsc_signal' };
  return { ok: true };
}

function checkNoDuplicateIntent(_draft, brief) {
  // The brief flags this on the router side (cannibalization /
  // page_type_mismatch buckets → human_review_required). If
  // human_review_required is set for those reasons, gate fails so the
  // draft can't sneak past.
  if (brief.human_review_required && /cannibal|mismatch|loop/.test(brief.human_review_reason || '')) {
    return { ok: false, reason: brief.human_review_reason };
  }
  return { ok: true };
}

function checkCanonical(draft) {
  const canonical = draft.frontmatter?.canonical_url || draft.canonical;
  const url = draft.url;
  if (!url) return { ok: true, reason: 'no_url_yet_for_new_page' };
  if (canonical && canonical !== url) return { ok: false, reason: 'canonical_points_elsewhere' };
  return { ok: true };
}

function checkIndexable(draft) {
  const noindex = (draft.frontmatter?.robots || '').toLowerCase().includes('noindex');
  if (noindex) return { ok: false, reason: 'robots_noindex_set' };
  return { ok: true };
}

function checkSitemapUpdated(_draft, _brief, context) {
  if (context.sitemapHasUrl === false) return { ok: false, reason: 'sitemap_missing_url' };
  if (context.sitemapHasUrl === true) return { ok: true };
  return { ok: true, reason: 'sitemap_check_skipped_no_context' };
}

function checkPreviewSuccess(_draft, _brief, context) {
  if (context.previewBuildSuccess === false) return { ok: false, reason: 'cloudflare_preview_failed' };
  if (context.previewBuildSuccess === true) return { ok: true };
  return { ok: true, reason: 'preview_check_skipped_no_context' };
}

// ── city-service checks ─────────────────────────────────────────────

function checkNapConsistent(draft, brief) {
  const body = String(draft.body || '');
  // NAP = Name, Address, Phone. For a city-service page, must include a
  // WAVES phone number (WAVES_PHONES allowlist). The previous any-phone
  // regex let a stray CUSTOMER number satisfy the "phone present"
  // requirement — the one check meant to assert the business's own NAP.
  if (!/Waves Pest Control/i.test(body)) return { ok: false, reason: 'business_name_missing' };
  const phones = body.match(/\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g) || [];
  if (!phones.some(isWavesPhone)) return { ok: false, reason: 'waves_phone_missing' };
  return { ok: true };
}

function checkLocalProof(draft) {
  const body = String(draft.body || '');
  // Same patterns as uniqueness-gate.checkUniqueLocalProof — kept
  // duplicated so the modules can evolve independently.
  if (!/\b\d+\s*(\+|plus)?\s*(jobs?|treatments?|customers?|reviews?)\b/i.test(body)
      && !/["“"][^"”"]{20,200}["”"]/.test(body)
      && !/\b(tech|technician)\s+(noted|reported|observed)\b/i.test(body)) {
    return { ok: false, reason: 'no_local_proof_signal' };
  }
  return { ok: true };
}

function checkCtaAboveFold(draft) {
  const body = String(draft.body || '');
  const firstChunk = body.slice(0, 800);
  const hasCta = /\b(get a quote|free inspection|call now|book online|same.?day|estimate|schedule|contact us)\b/i.test(firstChunk);
  if (!hasCta) return { ok: false, reason: 'no_cta_in_first_800_chars' };
  return { ok: true };
}

function checkServiceMenu(draft) {
  const body = String(draft.body || '');
  // Looks for a list of services covered — H2/H3 headings or bullets.
  const serviceListing = /(\n[#*-]\s+|<li>|<h[23][^>]*>)[^.\n]{4,80}/g;
  const matches = body.match(serviceListing) || [];
  if (matches.length < 3) return { ok: false, reason: `only_${matches.length}_list_items_found_need_3+` };
  return { ok: true };
}

// Topic fields the FAQ-blocked policy is matched against — same idea as
// publishAstro's guardrail call ([post.category, post.tag]) plus the brief's
// service, which is what the autonomous runner feeds content-guardrails.
// Also consult the brief's customer_signal: a city-service brief can carry
// the broad service ('pest') while the real topic lives on
// customer_signal.service/topic ('rodent'/'termite' — persisted by
// content-brief-builder), and a compliant no-FAQ draft on those topics must
// not be failed as no_faq_section_heading.
function faqPolicyTopicFields(draft, brief) {
  return [
    brief?.service,
    brief?.tag,
    brief?.customer_signal?.service,
    brief?.customer_signal?.topic,
    draft?.frontmatter?.category,
    draft?.frontmatter?.tag,
    // Spoke seeds carry the coarse 'pest' service (so link gates work) but tag
    // a blocked pest topic here so the FAQ-blocked policy still applies.
    brief?.voice_constraints?.operator_brief?.faq_blocked_topic,
    // listicle_family rows canonicalize specialty→pest; the specific
    // blocked topic (wasp, bed-bug…) rides gsc_signal and must reach this
    // policy or a wasp refresh on a broad pest page passes with an FAQ
    // (Codex r25).
    brief?.gsc_signal?.specialty_topic,
  ];
}

// Shared FAQ-blocked-topic handling for the FAQ checks: a draft on a
// FAQ-blocked service (content-guardrails.isFaqBlockedService — same module
// the publish-time P0 enforces) must NOT be scored down for correctly
// OMITTING the FAQ section the generator is now instructed to skip. Neutral
// = the check passes at full weight when the FAQ is (correctly) absent;
// an FAQ that IS present on a blocked topic fails here too (the guardrail
// P0s it at publish anyway). Returns null when the policy doesn't apply.
// Narrow operator override of the FAQ-blocked policy: an operator-authored
// intercept brief whose seeded manifest mandates an FAQ carries
// voice_constraints.operator_brief.faq_required=true (set by
// intercept-brief-seeder from the manifest payload, never from generated
// content — owner directive 2026-06-11: FAQPage on every intercept post).
// Mirrors content-guardrails' operatorFaqException flag so the gate and the
// publish-time guard can't disagree about the same draft.
function operatorFaqMandate(brief) {
  const voice = typeof brief?.voice_constraints === 'string'
    ? safeParseObject(brief.voice_constraints)
    : brief?.voice_constraints;
  return !!(voice && typeof voice === 'object' && voice.operator_brief?.faq_required === true);
}

function safeParseObject(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function faqBlockedTopicResult(hasFaqSection, draft, brief) {
  if (operatorFaqMandate(brief)) return null; // operator mandate — the normal FAQ checks apply
  if (!isFaqBlockedService(faqPolicyTopicFields(draft, brief))) return null;
  if (hasFaqSection) return { ok: false, reason: 'faq_present_on_faq_blocked_service' };
  return { ok: true, reason: 'faq_blocked_service_omission_is_correct' };
}

function checkFaqFromCustomer(draft, brief) {
  const body = String(draft.body || '');
  const hasFaq = /\b(faq|frequently asked|common questions)\b/i.test(body);
  const blockedResult = faqBlockedTopicResult(hasFaq, draft, brief);
  if (blockedResult) return blockedResult;
  // Must include "FAQ" or "Frequently Asked" + at least one question
  // matching the brief's customer_signal topic.
  if (!hasFaq) {
    return { ok: false, reason: 'no_faq_section_heading' };
  }
  const cs = brief.customer_signal;
  if (!cs) return { ok: false, reason: 'no_customer_signal_to_anchor_faq' };
  const q = (cs.normalized_question || cs.topic || '').toLowerCase();
  if (q && !body.toLowerCase().includes(q.split('?')[0].slice(0, 30))) {
    return { ok: false, reason: 'faq_does_not_address_customer_signal_topic' };
  }
  return { ok: true };
}

function checkLocalBusinessServiceSchema(draft) {
  const schemaText = JSON.stringify(draft.schema || draft.frontmatter?.schema || '');
  if (!/LocalBusiness|Service/i.test(schemaText)) {
    return { ok: false, reason: 'missing_LocalBusiness_or_Service_schema' };
  }
  return { ok: true };
}

// ── customer-question checks ────────────────────────────────────────

// When the answer-first contract puts the verdict box first (C2), the
// box's verdict IS the first answer: its text is judged, never the raw
// component tag, and a direct verdict ("Yes, some species can.") need not
// repeat a noun from the question (Codex r4 on #5216).
// A box prop's rendered value: a quoted attribute, or a static string
// expression ({"…"}, {'…'}, {`…`}) that MDX renders the same (Codex r4 on
// #5272).
// Values are read as they RENDER (Codex r5–r7 on #5272). Props are split
// by the guardrails' own JSX attribute walker (eachJsxAttr). A quoted
// value is HTML-decoded in full (entities.decodeHTML: &nbsp; &Tab;
// &#160;…). A {…} expression is parsed as JavaScript (acorn — comments,
// escapes and string concatenation as the renderer sees them); anything but
// a static string reads as empty. Unicode spaces collapse to a plain space.
// boxPropInfo → { text, opaque }: opaque when the prop is an expression
// that is not a static string (a conditional, a variable…), or when the box
// carries a JSX spread — the renderer
// shows SOMETHING the checks cannot read, so callers fail closed (Codex r8
// on #5272).
function boxPropInfo(tag, name) {
  const { eachJsxAttr } = require('./content-guardrails')._internals;
  const attrs = String(tag).replace(/^<BottomLineBox\b/, '').replace(/\/?>\s*$/, '');
  // A spread ({...{recommendation: "Call today."}}) can set or override any
  // prop at render time and eachJsxAttr skips it, so a box that is not
  // plain props only is opaque (fails closed).
  if (!plainBoxAttrs(attrs)) return { text: '', opaque: true };
  // A repeated prop renders its LAST value; rather than guess, a box that
  // repeats verdict/recommendation is opaque and fails closed (Codex r9 on
  // #5272).
  const matches = eachJsxAttr(attrs).filter((a) => a.name === name);
  if (matches.length > 1) return { text: '', opaque: true };
  const [attr] = matches;
  if (!attr) return { text: '', opaque: false };
  let text = '';
  if (attr.literal !== null && attr.literal !== undefined) text = require('entities').decodeHTML(String(attr.literal));
  else if (attr.expr) {
    const value = staticExpressionString(attr.expr);
    if (value === null) return { text: '', opaque: true };
    text = value;
  }
  return { text: text.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' '), opaque: false };
}
// The box's attributes are plain props only — name, name="…", name='…' or
// name={…}, separated by whitespace. The writer never emits anything else;
// a spread, comment trivia or any other token makes the box unreadable
// (#5380: pattern-matching spreads through comments did not converge).
function plainBoxAttrs(attrs) {
  const { closeOfExpressionAt } = require('./content-guardrails')._internals;
  const s = String(attrs || '');
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i >= s.length) return true;
    const nm = /^[A-Za-z_$][\w$-]*/.exec(s.slice(i));
    if (!nm) return false;
    i += nm[0].length;
    if (s[i] !== '=') {
      if (i < s.length && !/\s/.test(s[i])) return false;
      continue;
    }
    i += 1;
    const c = s[i];
    let end;
    if (c === '"' || c === "'") end = s.indexOf(c, i + 1);
    else if (c === '{') end = closeOfExpressionAt(s, i);
    else return false;
    if (end < 0) return false;
    i = end + 1;
    if (i < s.length && !/\s/.test(s[i])) return false;
  }
}
function boxProp(tag, name) {
  return boxPropInfo(tag, name).text;
}
function staticExpressionString(expr) {
  const inner = String(expr).replace(/^\{/, '').replace(/\}$/, '');
  let node;
  try {
    node = require('acorn').parse(`(${inner}\n)`, { ecmaVersion: 'latest' }).body[0]?.expression;
  } catch {
    return null;
  }
  const evaluate = (n) => {
    if (!n) return null;
    if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
    if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked).join('');
    if (n.type === 'BinaryExpression' && n.operator === '+') {
      const left = evaluate(n.left);
      const right = evaluate(n.right);
      return left !== null && right !== null ? left + right : null;
    }
    return null;
  };
  return evaluate(node);
}

function leadingVerdictBox(body) {
  const trimmed = String(body || '').replace(/^\s+/, '');
  if (!/^<BottomLineBox\b/.test(trimmed)) return null;
  const tag = findBottomLineBoxTag(trimmed);
  if (!tag || tag.index !== 0) return null;
  return {
    verdict: boxProp(tag.text, 'verdict').trim(),
    recommendation: boxProp(tag.text, 'recommendation').trim(),
  };
}

// A yes/no-shaped question is one that opens with an auxiliary/modal —
// "Can…", "Do…", "Is…" — where a direct answer word alone (not a repeated
// question noun) IS the answer ("Yes, some species can.").
const YES_NO_QUESTION_RE = /^\s*(can|do|does|did|is|are|will|should|could|would|has|have)\b/i;
const DIRECT_ANSWER_WORD_RE = /^\s*(yes|no|usually|rarely|sometimes|often|generally|mostly|not|only|it\s+depends)\b/i;

// Codex r5 on #5216 ("Require the verdict to answer the customer question"):
// r4 accepted ANY nonempty short verdict once the box was first, so a
// generic "Professional help is available." verdict passed as long as SOME
// text was there. Judged by the SAME rule the plain-paragraph path below
// uses (a question noun >4 chars appears in the answer) OR, for a
// yes/no-shaped question, a verdict that leads with a direct answer word —
// "Yes, some species can." answers "Can cockroaches fly?" without repeating
// "cockroaches". Kept deliberately small: no growing phrase list beyond this.
// Codex r6: question tokens are read with punctuation stripped ("like?"
// never matched anything) and without question scaffolding; a short WH
// question ("What do fire ants look like?") falls back to its 4-letter
// words. A question with no judgeable word at all is not failed on wording.
const QUESTION_SCAFFOLD_WORDS = new Set(['what', 'when', 'where', 'which', 'whose', 'does', 'look', 'looks', 'like', 'with', 'that', 'this', 'have', 'your', 'they', 'them', 'from', 'into', 'there', 'their', 'about', 'should', 'would', 'could']);
function questionKeywords(question) {
  const words = String(question || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w && !QUESTION_SCAFFOLD_WORDS.has(w));
  // Four letters and up: "fire ants" must survive beside "florida"
  // (Codex r9).
  return words.filter((w) => w.length >= 4);
}
// Whole words only (Codex r7: "plants" contained "ants"); a plain plural
// on either side still matches ("ant" / "ants", "cockroach" / "cockroaches").
function verdictAnswersQuestion(question, verdictText) {
  const keys = questionKeywords(question);
  const words = new Set(String(verdictText || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean));
  const said = (k) => words.has(k) || words.has(`${k}s`) || words.has(`${k}es`)
    || (k.endsWith('es') && words.has(k.slice(0, -2))) || (k.endsWith('s') && words.has(k.slice(0, -1)));
  if (keys.some(said)) return true;
  if (YES_NO_QUESTION_RE.test(question)) return DIRECT_ANSWER_WORD_RE.test(String(verdictText || '').trim());
  return keys.length === 0;
}

function checkAnswerInFirstParagraph(draft, brief) {
  const body = String(draft.body || '');
  const q = brief.customer_signal?.normalized_question || brief.target_keyword || '';
  if (!q) return { ok: false, reason: 'no_question_to_check_against' };
  const box = leadingVerdictBox(body);
  if (box) {
    if (!box.verdict) return { ok: false, reason: 'verdict_box_has_no_verdict' };
    if (`${box.verdict} ${box.recommendation}`.length > 600) return { ok: false, reason: 'first_paragraph_too_long_for_quick_answer' };
    if (!verdictAnswersQuestion(q, box.verdict)) return { ok: false, reason: 'verdict_does_not_answer_question' };
    return { ok: true };
  }
  const firstParagraph = body.split(/\n\s*\n/)[0] || '';
  // First paragraph should be a direct answer — short (< 400 chars)
  // and contain at least one key noun from the question.
  if (firstParagraph.length > 600) return { ok: false, reason: 'first_paragraph_too_long_for_quick_answer' };
  if (!verdictAnswersQuestion(q, firstParagraph)) return { ok: false, reason: 'first_paragraph_doesnt_address_question' };
  return { ok: true };
}

function checkSourceInternalLink(draft) {
  const body = String(draft.body || '');
  // At least one internal link to a hub or related page.
  if (!/\]\(\/[a-z0-9-]+/i.test(body)) return { ok: false, reason: 'no_internal_link_found' };
  return { ok: true };
}

// Single-sourced from waves-phones.js (shared with seo-completion-gate and
// content-guardrails' tel: destination check) — the per-file copies had
// already drifted once (last-7 vs full-10 keys).
const { isWavesPhone } = require('./waves-phones');

// Waves' own office street addresses (config/locations.js) are legitimate
// city-service NAP furniture — strip them before the PII address scan so
// the business's own address can never hard-fail the redaction gate.
function stripWavesOfficeAddresses(text) {
  let out = String(text || '');
  try {
    const { WAVES_LOCATIONS } = require('../../config/locations');
    for (const loc of WAVES_LOCATIONS || []) {
      const street = String(loc?.address || '').split(',')[0].trim(); // street portion
      if (!street) continue;
      // Strip the BASE street (unit/suite marker removed): valid NAP copy
      // may write "13649 Luxe Ave" without the "#110", and the base form is
      // a substring of the full form, so one replacement covers both (a
      // leftover " #110" fragment doesn't match the address pattern).
      const base = street.split(/\s+(?:#|Ste\.?\b|Suite\b|Unit\b)/i)[0].trim() || street;
      const re = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
      out = out.replace(re, '[waves-office]');
    }
  } catch { /* locations unavailable — scan unstripped (more conservative) */ }
  return out;
}

// Title-case vocabulary that generated STRUCTURAL headings are built from —
// question/marketing words plus home/lawn/treatment nouns. A capitalized
// pair in a heading blocks as a customer name only when NEITHER token is
// structural and the redactor's own allowlists (brand, staff, pests,
// cities, all-caps, city bigrams via looksLikeFalsePositiveName) don't
// clear it. This narrows the old blanket heading-name exemption ("## John
// Smith" must block) without resurrecting the round-9 false positives
// ("## Why Choose Waves Pest Control" reads as a name pair otherwise).
// Fail-closed bias: an unlisted vocabulary word in a heading pair parks the
// draft for human review — cheap next to a published customer name.
// NO surname-shaped singles: a word that is both domain vocabulary and a
// real surname ('Brown', 'Carpenter', 'Wood', 'Day', 'Bond', 'Love',
// 'Summer', 'Winter') must NOT be listed here — the pair scan skips a pair
// when EITHER token is structural, so a structural 'Brown' waves
// "## James Brown" through. Those words are cleared pair-scoped instead,
// via the redactor's DOMAIN_TERM_PAIRS ("Brown Patch" clears, "James
// Brown" blocks) inside looksLikeFalsePositiveName.
const STRUCTURAL_HEADING_WORDS = new Set([
  'Why', 'Choose', 'Choosing', 'Our', 'Your', 'The', 'How', 'What', 'When',
  'Where', 'Which', 'Who', 'Guide', 'Complete', 'Ultimate', 'Process',
  'Tips', 'Signs', 'Cost', 'Costs', 'Pricing', 'Price', 'Service',
  'Services', 'Serving', 'Treatment', 'Treatments', 'Prevention', 'Prevent',
  'Preventing', 'Benefits', 'Common', 'Questions', 'Question', 'Frequently',
  'Asked', 'Near', 'Best', 'Top', 'Versus', 'Vs', 'Plan', 'Plans', 'Options',
  'Option', 'Works', 'Safe', 'Safety', 'Kids', 'Pets', 'Home', 'Homes',
  'House', 'Yard', 'Garden', 'Free', 'Get', 'Getting', 'Avoid', 'Identify',
  'Identifying', 'Remove', 'Removing', 'Removal', 'Stop', 'Keep', 'Keeping',
  'Protect', 'Protecting', 'About', 'Contact', 'Visit', 'Areas', 'Area',
  'Local', 'Professional', 'Expert', 'Experts', 'Year', 'Round', 'Season',
  'Seasonal', 'Spring', 'Fall', 'Every', 'Homeowner',
  'Homeowners', 'Need', 'Needs', 'Know', 'Should', 'Right', 'Now', 'Today',
  'Emergency', 'Same', 'Inspection', 'Inspections', 'Estimate',
  'Estimates', 'Quote', 'Quotes', 'Schedule', 'Book', 'Booking', 'Call',
  'Bed', 'Bug', 'Bugs', 'Heat', 'Damage', 'Repair', 'Explained',
  'Checklist', 'Myths', 'Facts', 'Natural', 'Chemical', 'Baits', 'Traps',
  'Spray', 'Spraying', 'Granules', 'Fertilizer', 'Weed', 'Weeds', 'Grass',
  'Sod', 'Turf', 'Soil', 'Patch', 'Grub', 'Grubs', 'Chinch',
  'Fire', 'Ghost', 'Sugar', 'Flea', 'Fleas', 'Tick', 'Ticks',
  'Silverfish', 'Earwig', 'Earwigs', 'Millipede', 'Millipedes', 'Fly',
  'Flies', 'Gnat', 'Gnats', 'Mole', 'Cricket', 'Crickets', 'Sentricon',
  'Warranty', 'Coverage', 'Covered', 'Included', 'Includes',
  // Function words + common heading vocabulary — needed because the pair
  // scan runs on CASE-NORMALIZED heading text (see below), which promotes
  // every lowercase word to a pair candidate ("in", "to", "ants").
  'In', 'On', 'At', 'To', 'Of', 'For', 'And', 'Or', 'But', 'It', 'Is',
  'Are', 'Be', 'Do', 'Does', 'Did', 'Can', 'Could', 'Will', 'Would',
  'May', 'Might', 'You', 'We', 'They', 'My', 'Me', 'Us', 'This', 'That',
  'These', 'Those', 'There', 'Here', 'With', 'Without', 'From', 'Into',
  'Over', 'Under', 'After', 'Before', 'During', 'Between', 'Against',
  'More', 'Most', 'Less', 'Very', 'Much', 'Many', 'Few', 'Some', 'Any',
  'All', 'No', 'Not', 'So', 'Than', 'Then', 'If', 'As', 'By', 'Up',
  'Down', 'Out', 'Off', 'New', 'Old', 'Long', 'Short', 'High', 'Low',
  'Good', 'Bad', 'Easy', 'Hard', 'Fast', 'Slow', 'First', 'Last', 'Next',
  'Ants', 'Roaches', 'Cockroach', 'Cockroaches', 'Spiders', 'Termites',
  'Rodents', 'Mosquitoes', 'Wasps', 'Bees', 'Rats', 'Mice', 'Rat',
  'Mouse', 'Snakes', 'Snake', 'Lizards', 'Lizard', 'Beetles', 'Beetle',
  'Kitchen', 'Bathroom', 'Bedroom', 'Garage', 'Attic', 'Cabinets',
  'Walls', 'Windows', 'Doors', 'Baseboards', 'Lanai', 'Pool', 'Patio',
  'Deck', 'Fence', 'Roof', 'Eaves', 'Soffit', 'Foundation', 'Slab',
  'Mulch', 'Trees', 'Shrubs', 'Plants', 'Hate', 'Hide',
  'Hiding', 'Bite', 'Bites', 'Biting', 'Sting', 'Stings', 'Swarm',
  'Swarming', 'Swarmers', 'Nest', 'Nesting', 'Nests', 'Eat', 'Eating',
  'Come', 'Coming', 'Back', 'Return', 'Returning', 'Live', 'Living',
  'Look', 'Looks', 'Like', 'Mean', 'Means', 'Work', 'Working', 'Find',
  'Finding', 'See', 'Seeing', 'Smell', 'Smells', 'Sound', 'Sounds',
  'Cause', 'Causes', 'Causing', 'Damp', 'Wet', 'Dry', 'Dark', 'Warm',
  'Cold', 'Rain', 'Rainy', 'Storm', 'Storms', 'Water', 'Food', 'Trash',
]);

// The one heading-scan exception the redactor's name heuristic needs: find a
// First+Last-shaped pair that survives BOTH the structural vocabulary above
// and the redactor's own false-positive filters. Case-NORMALIZED first —
// customer-derived headings from SMS/voice transcripts are frequently
// lowercase ("## john smith"), and a Title-Case-only pair scan was blind to
// exactly the text the transcripts produce. Normalizing every word to
// Title Case makes lowercase words pair candidates too; the expanded
// structural vocabulary + allowlists absorb ordinary heading prose, and an
// unlisted pair parks the draft for review (fail-closed by design).
// Returns the offending pair or null.
function headingCustomerNamePair(headingText) {
  let looksLikeFalsePositiveName;
  try {
    ({ looksLikeFalsePositiveName } = require('./pii-redactor')._internals);
  } catch {
    // Redactor unavailable — caller's outer try/catch fails the gate closed.
    throw new Error('pii-redactor unavailable for heading name scan');
  }
  const normalized = String(headingText || '').replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  const pairRe = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,20})\b/g;
  let m;
  while ((m = pairRe.exec(normalized)) !== null) {
    const [, first, last] = m;
    // OVERLAPPING scan: resume from after the FIRST token, not after the
    // whole match — a non-overlapping pass consumes "About John" and never
    // evaluates "John Smith" ("## about john smith…" sailed through).
    pairRe.lastIndex = m.index + first.length;
    if (STRUCTURAL_HEADING_WORDS.has(first) || STRUCTURAL_HEADING_WORDS.has(last)) continue;
    if (looksLikeFalsePositiveName(first, last)) continue;
    return `${first} ${last}`;
  }
  return null;
}

// Broad phone regex covers `941-555-1234`, `(941) 555-1234`, and compact
// 11-digit / E.164 forms (`+19415551234`, `19415551234`) — the earlier
// 10-digit-only pattern could not match an 11-digit run (no interior
// word boundary), so a customer number pasted in E.164 form sailed
// through. The digit lookbehind keeps mid-run starts out, so long
// numeric IDs still don't false-match.
// The CORE number is captured separately from an optional attached
// extension (`x99`, `ext. 4`): the trailing \b cannot sit between a digit
// and an `x` (both word chars), so `212-555-1234x99` previously matched
// nothing at all — and extension digits must not pollute the last-10
// comparison against the Waves allowlist.
const phoneRe = /(?<!\d)(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?\b/gi;
const scanPhones = (text, where) => {
  const re = new RegExp(phoneRe.source, phoneRe.flags);
  let pm;
  while ((pm = re.exec(text)) !== null) {
    const digits = pm[1].replace(/\D/g, '');
    const last10 = digits.length >= 10 ? digits.slice(-10) : null;
    if (!last10) return { ok: false, reason: `malformed_phone_number_in_${where}` };
    // isWavesPhone, not the core-office set: spoke/refresh copy legitimately
    // carries domain/GBP tracking lines, which are Waves' own numbers too.
    if (!isWavesPhone(last10)) {
      return { ok: false, reason: `non_business_phone_number_in_${where}:${last10}` };
    }
  }
  return null;
};

const BLOCKING_PII_TYPES = new Set(['name', 'address', 'ssn', 'card']);

// Percent/plus-decoding for scanning only — a malformed escape keeps the
// raw text rather than hiding it.
function decodeLinkText(text) {
  const plus = String(text || '').replace(/\+/g, ' ');
  try { return decodeURIComponent(plus); } catch { return plus.replace(/%40/gi, '@').replace(/%20/g, ' '); }
}

// One public frontmatter field's PII scan — the SEO fields in
// checkRedactionPassed and the next_steps check below share it. Phones and
// emails use the Waves allowlists; name/address/ssn/card use the redactor.
// Name semantics follow FIELD SHAPE: Title-Case furniture (titles, link
// labels) gets the heading-pair name check (the raw scan reads "Chinch Bug
// Control" as a person); sentence-cased prose (metas) gets the raw name
// scan plus the low-confidence backstop. Throws if the redactor is missing
// — callers fail closed.
function scanPublicFieldForPii(where, raw, { titleCased }) {
  if (!String(raw || '').trim()) return null;
  const { redact } = require('./pii-redactor');
  const phoneHit = scanPhones(raw, where);
  if (phoneHit) return phoneHit;
  const fieldEmails = raw.match(/[\w._%+-]+@[\w-]+\.[A-Za-z]{2,}/g) || [];
  if (fieldEmails.some((e) => !e.toLowerCase().endsWith('@wavespestcontrol.com'))) {
    return { ok: false, reason: `email_in_${where}` };
  }
  const stripped = stripWavesOfficeAddresses(raw);
  const fieldScan = redact(stripped);
  const fieldHit = (fieldScan.findings || [])
    .find((f) => BLOCKING_PII_TYPES.has(f.type) && (titleCased ? f.type !== 'name' : true));
  if (fieldHit) return { ok: false, reason: `unredacted_${fieldHit.type}_in_${where}` };
  if (titleCased && headingCustomerNamePair(stripped)) {
    return { ok: false, reason: `unredacted_name_in_${where}` };
  }
  // A lowercase self-intro meta ("this is john smith ants are back")
  // reports low confidence with ZERO findings; Title-Case fields skip this
  // (the heading-pair check covers casing-blind names there).
  if (!titleCased && fieldScan.confidence === 'low') {
    return { ok: false, reason: `pii_confidence_low_in_${where}` };
  }
  return null;
}

// next_steps render publicly as links on every lane that ships them
// (supporting blogs included), so they get the PII scan wherever they can
// ship — a COMMON hard check scoped to next_steps only; it never starts
// scanning a supporting-blog body (Codex r3/r4 on #5216). Each entry is the
// SAME "[label](href)" text the guardrails synthesize
// (content-guardrails.nextStepsLinkMarkdown), with the href's query decoded
// ("name=Jane+Doe", "%40") so the redactor sees what a visitor would.
// Title-Case semantics: link labels are UI furniture, and the heading-pair
// name check also catches a lowercase name in a query string.
// Codex r5 on #5216 ("Skip draft next-step PII checks on refreshes"):
// publishRefresh keeps the LIVE frontmatter and applies only the title/meta
// fields (astro-publisher.js) — a refresh draft's own next_steps never ship,
// so scanning them can only park a clean refresh on text that will never
// publish. Same refresh predicate content-guardrails.evaluate() uses to skip
// next_steps there (nextStepsLinks = isRefresh ? '' : nextStepsLinkMarkdown
// (frontmatter)) — the two must agree on what "a refresh" is.
function checkNextStepsRedacted(draft, brief) {
  if (brief?.action_type === 'refresh_existing_page') return { ok: true, reason: 'refresh_frontmatter_not_published' };
  const text = decodeLinkText(require('./content-guardrails').nextStepsLinkMarkdown(draft?.frontmatter || {}));
  if (!text.trim()) return { ok: true, reason: 'no_next_steps' };
  try {
    return scanPublicFieldForPii('next_steps', text, { titleCased: true }) || { ok: true };
  } catch (err) {
    return { ok: false, reason: `pii_scan_unavailable:${err.message}` };
  }
}

function checkRedactionPassed(draft) {
  // Exact licensed-photo attribution lines (a photographer's name, a long
  // numeric Commons URL) are catalog text, not customer PII — Codex r7.
  const body = require('./licensed-photo-library').blankLibraryPhotoAttributions(String(draft.body || ''));
  const bodyPhoneHit = scanPhones(body, 'body');
  if (bodyPhoneHit) return bodyPhoneHit;
  // Waves' own addresses are legitimate page furniture (city-service NAP
  // blocks carry info@wavespestcontrol.com); every other email is customer
  // PII. The previous any-email hard fail false-positived the business's
  // own contact line.
  const emails = body.match(/[\w._%+-]+@[\w-]+\.[A-Za-z]{2,}/g) || [];
  if (emails.some((e) => !e.toLowerCase().endsWith('@wavespestcontrol.com'))) {
    return { ok: false, reason: 'email_in_body' };
  }
  // Names + street addresses via the pii-redactor's own patterns — phones
  // and emails alone left exactly the gap this hard check exists to close:
  // customer-derived local proof like "John Smith at 4867 Maple Street"
  // sailed through. Waves' own office addresses (NAP furniture) are
  // stripped first so they can never hard-fail the gate; the redactor's
  // staff/place allowlist handles team names. ZIP findings are deliberately
  // NOT failed — "Venice, FL 34285" is service-area furniture, and a
  // customer ZIP only identifies anyone alongside an address, which fails
  // on its own.
  try {
    const { redact } = require('./pii-redactor');
    // Which redactor finding types BLOCK here: every structured PII type
    // except the ones with a deliberate reason not to —
    //   phone/email: already validated ABOVE with the Waves allowlists
    //     (isWavesPhone / @wavespestcontrol.com); the redactor's own
    //     phone/email findings carry NO allowlist, so blocking on them
    //     would hard-fail the business's own contact lines.
    //   zip: "Venice, FL 34285" is service-area furniture; a customer ZIP
    //     only identifies anyone alongside an address, which fails itself.
    //   url: link policy is owned end-to-end by the outbound-link gate in
    //     content-guardrails (scheme/host/mailto/tel validation on every
    //     destination); a long https URL is a citation, not per-se PII.
    // Everything else — name, address, ssn, card — is customer PII with no
    // legitimate page-furniture form and hard-fails the publish gate.
    // Markdown HEADING lines are excluded from the redactor's raw NAME scan
    // (title-case section headings like "## Why Choose Waves Pest Control"
    // read as name pairs) but NOT from name detection altogether: a
    // narrower heading-specific pair check (headingCustomerNamePair) blocks
    // "## John Smith" while the structural vocabulary + redactor allowlists
    // clear generated section headings. Objective checks apply in full:
    // phone/email were scanned above on the whole body, and the structured
    // scan here fails on address/ssn/card — "## John Smith at 4867 Maple
    // Street" fails on the address before the name pair is even consulted.
    const headingText = (body.match(/^#{1,6}\s.*$/gm) || []).join('\n');
    if (headingText) {
      const strippedHeadings = stripWavesOfficeAddresses(headingText);
      const headingScan = redact(strippedHeadings);
      const headingHit = (headingScan.findings || [])
        .find((f) => BLOCKING_PII_TYPES.has(f.type) && f.type !== 'name');
      if (headingHit) {
        return { ok: false, reason: `unredacted_${headingHit.type}_in_heading` };
      }
      if (headingCustomerNamePair(strippedHeadings)) {
        return { ok: false, reason: 'unredacted_name_in_heading' };
      }
    }
    const scanBody = body.replace(/^#{1,6}\s.*$/gm, '');
    const scanned = redact(stripWavesOfficeAddresses(scanBody));
    const hit = (scanned.findings || []).find((f) => BLOCKING_PII_TYPES.has(f.type));
    if (hit) return { ok: false, reason: `unredacted_${hit.type}_in_body` };
    // 'low' confidence means the redactor itself says its heuristics were
    // blind on this text (effectively all-lowercase, long unstructured
    // runs) — "no findings" proves nothing there, so a hard publish gate
    // must fail: a lowercase customer quote with an unredacted name
    // reports exactly low + zero findings. Generated drafts are properly
    // capitalized markdown and never trip this.
    if (scanned.confidence === 'low') {
      return { ok: false, reason: 'pii_confidence_low' };
    }
    // SEO FIELDS — the publisher writes title + meta_description to the
    // public page too, so a clean body with "John Smith" or a customer
    // phone in the frontmatter still published PII. Same checks, same
    // allowlists. Name semantics differ BY FIELD SHAPE: titles are Title
    // Case furniture, so they get the heading-pair check (the raw name
    // scan reads "Chinch Bug Control" as a person) — while metas are
    // sentence-cased prose like the body, so they get the body-style raw
    // name scan (the heading check would case-promote every meta word and
    // flag any unlisted adjacent pair, e.g. "straight antennae"). Objective
    // PII (address/ssn/card, phone, email) blocks outright in both.
    // Both casings of each field are collected — refreshes/non-blog pages
    // preserve camelCase frontmatter (metaTitle/metaDescription, the
    // editable-meta set content-guardrails scans) and Astro renders those
    // too, so scanning only the snake_case names left the camelCase route
    // unchecked. Concatenated for scanning; the `where` label stays the
    // canonical rendered slot.
    const fm = draft.frontmatter || {};
    const joinFields = (...vals) => vals.filter(Boolean).map(String).join('\n');
    const seoFields = [
      ['title', joinFields(draft.title, fm.title, draft.metaTitle, fm.metaTitle)],
      ['meta_description', joinFields(draft.meta_description, fm.meta_description, draft.metaDescription, fm.metaDescription)],
    ];
    for (const [where, raw] of seoFields) {
      const hit = scanPublicFieldForPii(where, raw, { titleCased: where === 'title' });
      if (hit) return hit;
    }
  } catch (err) {
    // Redactor unavailable = we cannot prove the body is clean — this is a
    // HARD publish gate, so fail closed rather than silently passing.
    return { ok: false, reason: `pii_scan_unavailable:${err.message}` };
  }
  return { ok: true };
}

// ── refresh checks ──────────────────────────────────────────────────

function checkImprovementOverPrior(draft, brief, context) {
  const prev = context.previousVersion;
  if (!prev) return { ok: false, reason: 'no_previous_version_to_compare' };
  const prevLen = (prev.body || '').length;
  const newLen = String(draft.body || '').length;
  if (newLen < prevLen * 0.8) return { ok: false, reason: 'refresh_lost_>20%_of_prior_content' };
  // A citability backfill is a targeted edit (an attribution or a number can
  // be a few words), so body growth is not its improvement proof —
  // citability_backfill_gaps_cleared is. The 20% loss floor above still holds.
  if (isCitabilityBackfillBrief(brief)) return { ok: true, reason: 'citability_backfill_targeted_edit' };
  if (newLen < prevLen + 200) return { ok: false, reason: 'refresh_adds_less_than_200_chars' };
  return { ok: true };
}

// ── supporting-blog checks ──────────────────────────────────────────

function checkHubLinkPresent(draft, brief) {
  const body = String(draft.body || '');
  // Per v3.1 — supporting blogs must link to the relevant hub. The accepted
  // set derives from the brief builder's SERVICE_HUB_LINKS (single source of
  // truth): a service the builder steers toward its hub (termite →
  // /termite-inspection/, rodent → /rodent-control/) must never fail the
  // gate for linking exactly where it was told to. Lazy require avoids any
  // load-order coupling with content-brief-builder.
  // Spoke-seed / operator briefs carry a CURATED hub link (the most-relevant hub
  // city/service page, e.g. /pest-control-sarasota-fl/) that is NOT in the fixed
  // SERVICE_HUB_LINKS set. When present it is the AUTHORITATIVE backlink target
  // for the post (the branded-local spoke→hub link is the contract), so REQUIRE
  // exactly that link — a generic service link the brief also carries must not
  // let the draft skip the curated backlink.
  const curatedHubLink = brief?.voice_constraints?.operator_brief?.hub_link;
  if (curatedHubLink) {
    return body.includes(String(curatedHubLink))
      ? { ok: true }
      : { ok: false, reason: 'no_curated_hub_link_found' };
  }
  const { SERVICE_HUB_LINKS, SERVICE_CITY_SLUG, SERVICE_ID_ALIASES } = require('./content-brief-builder')._internals;
  // Resolve the brief's service FIRST and check only ITS hubs. Testing the union
  // of every service's hubs let any vertical satisfy a check named
  // "relevant hub" with an unrelated one — and it made the hubless carve-out
  // below dead code, since a tree/shrub draft linking /pest-control-services/
  // passed before the carve-out was ever reached.
  const service = SERVICE_ID_ALIASES[brief?.service] || brief?.service;
  const serviceHubs = service ? SERVICE_HUB_LINKS[service] : null;

  // Unknown or absent service: fall back to the union. The service is what makes
  // "relevant" meaningful, so without it there is nothing stricter to assert, and
  // failing here would park briefs that simply carry no service.
  if (!Array.isArray(serviceHubs)) {
    const anyHub = [...new Set(Object.values(SERVICE_HUB_LINKS).flat())];
    return anyHub.some((h) => body.includes(h))
      ? { ok: true }
      : { ok: false, reason: 'no_hub_link_found' };
  }

  if (serviceHubs.some((h) => body.includes(h))) return { ok: true };

  // A vertical with NO hub-level page (tree & shrub: /tree-shrub-care/ does not
  // exist, only /tree-and-shrub-care-{city}-fl/) has an empty SERVICE_HUB_LINKS
  // entry, so no hub link can ever satisfy it and EVERY such draft parked —
  // including city-scoped ones that followed their brief exactly. For those
  // services the city-service page IS the most relevant local page the brief
  // mandates, so accept it. Scoped to hubless services only: a vertical that HAS
  // a hub must link it rather than substituting a city page.
  if (!serviceHubs.length) {
    // Same specificity the SEO gate applies: prefer the brief's exact service+city
    // route, since the service prefix alone accepts any town's page.
    const { cityServiceRoute } = require('./blog-seo-contract');
    const city = brief?.city || brief?.voice_constraints?.operator_brief?.city;
    const exact = cityServiceRoute(service, city);
    if (exact) return body.includes(exact) ? { ok: true } : { ok: false, reason: 'no_hub_link_found' };
    const citySlug = SERVICE_CITY_SLUG[service];
    if (citySlug && new RegExp(`/${citySlug}-[a-z][a-z0-9-]*-fl/`).test(body)) return { ok: true };
  }
  return { ok: false, reason: 'no_hub_link_found' };
}

function checkTwoPlusCityMentions(draft, brief) {
  const body = String(draft.body || '').toLowerCase();
  // A spoke/operator brief targets ONE city — verify the post actually localizes
  // to THAT city (the manifest requires it twice), not just any two SWFL cities
  // (a Sarasota spoke post must not pass on Bradenton+Venice mentions alone).
  const targetCity = String(brief?.voice_constraints?.operator_brief?.city || '').trim().toLowerCase();
  if (targetCity) {
    const re = new RegExp(`\\b${targetCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const n = (body.match(re) || []).length;
    return n >= 2 ? { ok: true } : { ok: false, reason: `only_${n}_${targetCity.replace(/\s+/g, '_')}_mentions` };
  }
  const cities = ['bradenton', 'sarasota', 'venice', 'parrish', 'lakewood ranch', 'north port', 'palmetto', 'port charlotte'];
  let count = 0;
  for (const c of cities) {
    if (body.includes(c)) count++;
    if (count >= 2) return { ok: true };
  }
  return { ok: false, reason: `only_${count}_city_mentions` };
}

function checkFaqSectionPresent(draft, brief) {
  const body = String(draft.body || '');
  const hasFaq = /\b(faq|frequently asked|common questions)\b/i.test(body);
  const blockedResult = faqBlockedTopicResult(hasFaq, draft, brief);
  if (blockedResult) return blockedResult;
  if (!hasFaq) {
    return { ok: false, reason: 'no_faq_section' };
  }
  return { ok: true };
}

// Raw markdown pipe table detector — delegates to the single-source
// predicate in content-guardrails (hasRawMarkdownTable), which also
// enforces the rule on the manual publishAstro lane, so the two
// enforcement points can never drift. Mirrors the guardrails refresh
// grandfather: a table the prior live body already carried must not
// permanently park the refresh lane — only ADDED tables block.
function checkNoRawMarkdownTables(draft, _brief, context = {}) {
  const { hasRawMarkdownTable, hasUnpreservedRawTable } = require('./content-guardrails');
  // Refresh grandfather mirrors the guardrails finding: only tables the
  // prior live body already carried (content-compared) pass — adding or
  // swapping in a table still blocks.
  const violated = context.previousVersion
    ? hasUnpreservedRawTable(draft.body, context.previousVersion.body)
    : hasRawMarkdownTable(draft.body);
  if (!violated) return { ok: true };
  return { ok: false, reason: 'raw_markdown_table_in_body_use_ComparisonTable' };
}

// Fail-closed park for unsupported body syntax — single-source predicate
// in content-guardrails (unsupportedBodySyntax); the completion gate raises
// the matching P1 so both enforcement points agree.
// Refresh grandfather mirrors the guardrails finding: exact constructs the
// live prior body already carried pass; any new or changed construct parks.
function checkBodySyntaxSupported(draft, _brief, context = {}) {
  const { unsupportedBodySyntax, unsupportedBodySyntaxAdded } = require('./content-guardrails');
  const added = context.previousVersion
    ? unsupportedBodySyntaxAdded(draft.body, context.previousVersion.body)
    : unsupportedBodySyntax(draft.body);
  if (!added.length) return { ok: true };
  return { ok: false, reason: `unsupported_body_syntax:${added.join(',')}` };
}

// ── C2/C3 structural checks (owner ruling 2026-09-28) ─────────────────

// True for every draft the ANSWER FIRST, PITCH SECOND writer instruction
// covers: any post_type "diagnostic" draft (whatever page type it landed
// on — post_type is a writer decision independent of the brief's page_type)
// and every customer-question page (post_type doesn't gate that one; the
// page type itself IS the "question" case).
// Codex r2 on #5216: a refresh ships the LIVE frontmatter (publishRefresh
// freezes it), so a refresh is classified by the live post_type the runner
// hands in as context.liveFrontmatter — never by whatever the refresh draft
// happened to repeat (the refresh tool schema does not require post_type).
// When the runner reports the live load FAILED (liveFrontmatterUnavailable)
// the refresh is held to the identification checks — fail closed, so an
// unknown classification routes to review. A caller that supplies neither
// (unit tests, older callers) falls back to the draft's own value. The
// post_type comparison itself is licensed-photo-library.isIdentification
// Post — the SAME predicate the publisher and the merge-time image check use.
function effectiveFrontmatter(draft, brief, context) {
  const isRefresh = brief?.action_type === 'refresh_existing_page';
  if (isRefresh && context?.liveFrontmatter && typeof context.liveFrontmatter === 'object') return context.liveFrontmatter;
  return draft?.frontmatter || {};
}
function isIdentificationDraft(draft, brief, context) {
  if (brief?.action_type === 'refresh_existing_page' && context?.liveFrontmatterUnavailable && !context?.liveFrontmatter) return true;
  return isIdentificationPost(effectiveFrontmatter(draft, brief, context));
}
// A customer-question page keeps its answer-first contract through a
// refresh. Codex r5 on #5216 ("Persist customer-question identity across
// publication"): the r4 fix keyed this on liveFrontmatter.page_type, but
// page_type is not in the blog schema (packages/blog-schema/schema.json)
// and normalizeAutonomousBlogFrontmatter never writes it — no live post
// actually carries it. The durable marker is the LIVE BODY itself: a
// refresh whose live body (context.previousVersion.body — the runner
// already hands this in) opens with a BottomLineBox as its first block was
// published under the answer-first contract, whatever its frontmatter says,
// so the refresh is held to it too. Same test as leadingVerdictBox / the
// `^<BottomLineBox` check checkVerdictBoxFirst runs on the DRAFT.
function isIdentificationOrQuestionDraft(draft, brief, context) {
  if (isIdentificationDraft(draft, brief, context) || brief?.page_type === 'customer-question') return true;
  if (brief?.action_type !== 'refresh_existing_page') return false;
  // The durable marker is the run ledger: the runner reports whether this
  // target was first published by a customer-question run
  // (context.liveIsCustomerQuestion, from autonomous_runs) — any post_type,
  // "decision" included (Codex r8 on #5216).
  if (context?.liveIsCustomerQuestion === true) return true;
  // Pages the ledger does not know (published by hand, or before the
  // ledger), or a failed ledger read: a live body that opens on the box was
  // published answer-first — except a "decision" post, whose own contract
  // carries a box (Codex r7). A failed read holds even a decision post (fail
  // closed).
  if (!leadingVerdictBox(context?.previousVersion?.body)) return false;
  if (context?.liveQuestionLedgerUnavailable) return true;
  const livePostType = String(context?.liveFrontmatter?.post_type || '').trim().toLowerCase();
  return livePostType !== 'decision';
}

// C2: the verdict box (BottomLineBox) must be the LITERAL first block of
// the body — before any heading, prose, or other component. A plain
// leading `[BottomLineBox` component tag is unambiguous: the writer's
// Markdown subset never puts significant whitespace or commentary before
// the first real content.
function checkVerdictBoxFirst(draft, brief, context) {
  if (!isIdentificationOrQuestionDraft(draft, brief, context)) return { ok: true, reason: 'not_identification_or_question' };
  const body = String(draft.body || '').trim();
  if (!body) return { ok: false, reason: 'empty_body' };
  if (!/^<BottomLineBox\b/.test(body)) return { ok: false, reason: 'verdict_box_not_first_block' };
  // A leading box whose tag cannot be read (unbalanced braces, comment
  // trivia, a spread) is never a compliant answer box (#5380 r4).
  const firstTag = findBottomLineBoxTag(body);
  if (!firstTag || firstTag.index !== 0 || boxPropInfo(firstTag.text, 'verdict').opaque) return { ok: false, reason: 'verdict_box_unreadable' };
  // Codex r6 on #5216: an identification post's box must also say
  // something — the writer frames verdict as the answer to "Is it
  // dangerous?" and recommendation as "What to do now". The verdict is
  // judged by the same answer rule as a customer question (a direct answer
  // word leads it), or names a risk in the catalog's own safety terms
  // (stings, venom, toxic to pets, damage…). Customer-question pages judge
  // theirs against the reader's own question (answer_in_first_paragraph).
  if (isIdentificationDraft(draft, brief, context)) {
    const box = leadingVerdictBox(body);
    if (!box?.verdict) return { ok: false, reason: 'verdict_box_has_no_verdict' };
    if (!box.recommendation) return { ok: false, reason: 'verdict_box_has_no_recommendation' };
    if (!verdictAnswersQuestion('Is it dangerous?', box.verdict) && !DANGER_TERMS_RE.test(box.verdict)) {
      return { ok: false, reason: 'verdict_does_not_answer_is_it_dangerous' };
    }
  }
  return { ok: true };
}
// The catalog's safety fields (stings, bites, venomous, disease_vector,
// structural, allergen, toxic_to_pets, irritant) in plain words, plus the
// verdict scale's own words.
const DANGER_TERMS_RE = /\b(dangerous|danger|harmless|safe|unsafe|venom\w*|stings?|stinging|bites?|biting|toxic|poison\w*|irritat\w*|allerg\w*|disease\w*|damag\w*|risk\w*|threat\w*|medically|beneficial)\b/i;

// C2: on the same drafts, the early estimate/quote CTA link must land
// AFTER the verdict box closes, never before it. checkVerdictBoxFirst
// already covers "no box at all" / "box isn't first" — this check only
// judges relative order once a box is present, so the two never double-
// report the same root cause.
// Codex P2 (2nd round): the estimate/quote-labelled check only ever
// scanned for a CTA-SHAPED link, so a non-CTA markdown-link-shaped string
// INSIDE the box's own props (e.g. recommendation="See our [guide]
// (/pest-control-services/)") was invisible to it, AND any pitch-style
// link BEFORE the box worded differently ("Book Now", "Call Today",
// "Schedule Service") was equally invisible — only the estimate/quote
// wording was ever checked, with no broader catch-all. Both are now the
// SAME check: ANY markdown-link-shaped substring anywhere before the box
// closes (inside its own tag OR in the prose before it) is a hard
// failure — verdict_box_first already requires the box to be the literal
// first block, so a compliant draft has NOTHING at all before boxEnd;
// this is the fail-closed backstop for whatever reaches this check
// without that having held.
const ANY_MD_LINK_RE = /\[[^\]]*\]\([^)]+\)/g;
const BOX_PHONE_RE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/;
// The first <BottomLineBox …> tag, located the way MDX reads it: quoted
// attribute values skip to their closing quote, and a {…} expression skips
// to its balanced close through the guardrails' expression walker
// (strings, escapes, comments) — an escaped quote inside {"Don\"t…"} does
// not end the tag early (Codex r9 on #5272; the older quote-aware regex,
// Codex r10 on #5216, could not see escapes). { index, text } or null.
function findBottomLineBoxTag(body) {
  const s = String(body || '');
  const start = s.search(/<BottomLineBox\b/);
  if (start < 0) return null;
  const { closeOfExpressionAt } = require('./content-guardrails')._internals;
  for (let j = start + '<BottomLineBox'.length; j < s.length; j += 1) {
    const c = s[j];
    if (c === '{') {
      const end = closeOfExpressionAt(s, j);
      if (end < 0) return null;
      j = end;
    } else if (c === '"' || c === "'") {
      const end = s.indexOf(c, j + 1);
      if (end < 0) return null;
      j = end;
    } else if (c === '>') {
      return { index: start, text: s.slice(start, j + 1) };
    }
  }
  return null;
}
function checkCtaAfterVerdictBox(draft, brief, context) {
  if (!isIdentificationOrQuestionDraft(draft, brief, context)) return { ok: true, reason: 'not_identification_or_question' };
  const body = String(draft.body || '');
  // Codex P1 (r10): quote-aware — a naive `[^>]*` stopped at the first
  // literal `>` INSIDE a prop value ("more than > 1/4 inch"), truncating the
  // tag so a link later in the same prop escaped both checks below.
  const box = findBottomLineBoxTag(body);
  if (!box) {
    // A body that opens on a box tag nobody can read is not "no box" (#5380 r4).
    if (/^\s*<BottomLineBox\b/.test(body)) return { ok: false, reason: 'verdict_box_unreadable' };
    return { ok: true, reason: 'no_verdict_box_present' }; // verdict_box_first already fails this
  }
  const boxStart = box.index;
  ANY_MD_LINK_RE.lastIndex = 0;
  if (ANY_MD_LINK_RE.test(box.text)) return { ok: false, reason: 'link_inside_verdict_box' };
  // The box's props render as the reader's first answer — a sales pitch in
  // plain text ("Get a free estimate now", "Call today", a phone number)
  // is a pitch before the answer just like a link (Codex r8 on #5216).
  // Same sales-copy detectors the blog meta gate uses; "call a licensed
  // pro" style advice is not sales copy.
  const verdictProp = boxPropInfo(box.text, 'verdict');
  const recommendationProp = boxPropInfo(box.text, 'recommendation');
  if (verdictProp.opaque || recommendationProp.opaque) return { ok: false, reason: 'verdict_box_prop_not_static' };
  const boxText = `${verdictProp.text} ${recommendationProp.text}`;
  if (SALESY_META_RE.test(boxText) || metaHasSalesCopy(boxText) || PHONE_TOKEN_RE.test(boxText) || CITY_PHONE_TOKEN_RE.test(boxText) || BOX_PHONE_RE.test(boxText) || BARE_PHONE_DIGITS_RE.test(boxText)) {
    return { ok: false, reason: 'sales_pitch_inside_verdict_box' };
  }
  ANY_MD_LINK_RE.lastIndex = 0;
  let m;
  while ((m = ANY_MD_LINK_RE.exec(body))) {
    if (m.index < boxStart) return { ok: false, reason: 'cta_before_verdict_box' };
  }
  return { ok: true };
}

// C3: an identification draft's photos are a CLOSED set — the licensed
// photo library (licensed-photo-library.js: photos already committed in the
// Astro repo, embedded by their LOCAL path). Codex r3 on #5216: the gate
// looks each image up in the library by src — one lookup that works the
// same for a new post, a refresh and a remediation revalidation, with no
// brief allowlist, grants or provenance. Anything else (AI art, a remote
// URL, another post's image) fails.
// Each library photo must carry its catalog alt exactly and the EXACT
// attribution line on the RENDERED view (comments and code blanked — the
// guardrails' blankNonRenderedMarkdown):
//   Photo: [credit](source_page) ([license](license_url))
const PHOTO_CATALOG_FIELDS = ['credit', 'license', 'license_url', 'source_page'];
// Codex r8 on #5216: the credit sits DIRECTLY below its own image — the
// next non-blank rendered line after the image's line is the exact
// attribution line (a credit in a distant footer, or one credit shared by
// two copies of the photo, does not count).
function validateLibraryPhoto(photo, alt, url, renderedBody, line, { viewLines = null, usedCreditLines = new Set() } = {}) {
  if (!photo) return { ok: false, reason: `unlicensed_or_unknown_identification_photo:${url}` };
  if (alt !== photo.alt) return { ok: false, reason: `identification_photo_alt_mismatch:${url}` };
  if (PHOTO_CATALOG_FIELDS.some((field) => !photo[field])) return { ok: false, reason: `identification_photo_catalog_entry_incomplete:${url}` };
  // A raw <img>/srcset has no line here; it fails as an unsupported form
  // right after this, so only its presence is judged.
  if (!Number.isInteger(line)) {
    if (!renderedBody.includes(photoAttributionLine(photo))) return { ok: false, reason: `identification_photo_attribution_missing:${url}` };
    return null;
  }
  // Lines the publisher's rendered view leaves blank — blank lines and
  // non-rendered reference definitions, one line or several (Codex r1/r3 on
  // #5272) — are skipped; the credit TEXT is read from the visible body.
  // Each credit line is consumed by ONE image: two copies ending on the same
  // line cannot share it (Codex r3 on #5272).
  const lines = renderedBody.split('\n');
  // A line left with only blockquote markers is empty too.
  const skip = (i) => !(viewLines ? viewLines[i] || '' : lines[i]).replace(/^[\s>]+$/, '').trim();
  let next = line + 1;
  while (next < lines.length && skip(next)) next += 1;
  if (next >= lines.length || lines[next].trim() !== photoAttributionLine(photo) || usedCreditLines.has(next)) {
    return { ok: false, reason: `identification_photo_attribution_missing:${url}` };
  }
  usedCreditLines.add(next);
  return null;
}
// Every rendered image FORM is collected — Codex r5 on #5216 (3rd round on
// image parsing): the gate's OWN inline/reference regexes missed the
// CommonMark shortcut form (`![alt]` + `[alt]: /path`), which the publisher
// DOES render. There is now exactly ONE parser for "what Markdown images does
// this body render": the publisher's own bodyImageRefs (astro-publisher.js,
// built on renderedBodyView + contentGuardrails.eachMarkdownLink), lazily
// required — the gate must accept exactly what the publisher publishes, no
// more and no less. `mdx: true` matches the publisher's own default for the
// autonomous lane that mints identification posts (resolveBodyImages:
// "filePath is always `.mdx` here" — see astro-publisher.js). A raw `<img>`
// (src and srcset) is OUTSIDE that Markdown subset — validateBodyImageRefs parks
// it at publish — so it is still scanned separately here and tagged its own
// form, never folded into 'markdown'. An MDX component is not an image
// source today — SAFE_MDX_COMPONENTS carries none with an image-shaped prop;
// add an entry here if one is ever added.
const RAW_IMG_TAG_RE = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi; // quote-aware
const { htmlAttrValue: attrValue, isIdentificationPost, photoAttributionLine, libraryPhotoBySrc } = require('./licensed-photo-library');
// alt is trimmed in every form.
function collectBodyImageOccurrences(body, { mdx = true } = {}) {
  const out = [];
  // bodyImageRefs is an internal (astro-publisher requires this module at
  // load time for DANGLING_META_ENDINGS, so this stays a lazy, in-function
  // require — never top-level, or the two modules deadlock on load).
  const { bodyImageRefs } = require('../content-astro/astro-publisher')._internals;
  for (const ref of bodyImageRefs(body, { mdx })) {
    out.push({ alt: String(ref.alt || '').trim(), url: String(ref.src || '').trim(), form: 'markdown', line: Number.isInteger(ref.endLine) ? ref.endLine : ref.line });
  }

  let m;
  RAW_IMG_TAG_RE.lastIndex = 0;
  while ((m = RAW_IMG_TAG_RE.exec(body))) {
    const attrs = m[1] || '';
    const alt = String(attrValue(attrs, 'alt') || '').trim();
    const src = attrValue(attrs, 'src');
    if (src) out.push({ alt, url: src.trim(), form: 'img' });
    const srcset = attrValue(attrs, 'srcset');
    if (srcset) {
      for (const entry of srcset.split(',')) {
        const url = entry.trim().split(/\s+/)[0];
        if (url) out.push({ alt, url, form: 'srcset' });
      }
    }
  }
  return out;
}

// Codex r4 on #5216: the library lookup proves a photo is licensed and
// attributed, but a post may only show the photos its OWN brief assigned —
// a fire-ant post must not borrow the cockroach photo. The allowed set is
// the brief's voice_constraints.photo_slots srcs; remediation revalidation
// re-runs this with the run's own stored brief, so it gets the same set.
// A refresh (whose brief carries no slots) may also keep a library photo
// the LIVE previous body already showed (context.previousVersion, rendered
// view) — never add a new one.
function allowedIdentificationPhotoSrcs(brief, context) {
  const allowed = new Set(
    (Array.isArray(brief?.voice_constraints?.photo_slots) ? brief.voice_constraints.photo_slots : [])
      .map((slot) => slot?.photo?.src)
      .filter(Boolean),
  );
  const prior = context?.previousVersion?.body;
  if (brief?.action_type === 'refresh_existing_page' && typeof prior === 'string' && prior.trim()) {
    // Same parser as everywhere else here (bodyImageRefs, via
    // collectBodyImageOccurrences) — a shortcut or reference-style photo the
    // live body already carried grandfathers exactly like an inline one now.
    for (const { url, form } of collectBodyImageOccurrences(prior, { mdx: !markdownOnlyTarget(brief) })) {
      if (form === 'markdown' && libraryPhotoBySrc(url)) allowed.add(url);
    }
  }
  return allowed;
}

function checkPhotoSlotsLicensedOnly(draft, brief, context) {
  if (!isIdentificationDraft(draft, brief, context)) return { ok: true, reason: 'not_identification_post' };
  const body = String(draft.body || '');
  // Same Markdown/MDX flavor the publisher reads the target with (a legacy
  // .md refresh renders Markdown inside raw HTML as literal text) — Codex r7.
  const mdx = !markdownOnlyTarget(brief);
  // Codex r6: the attribution must be READER-VISIBLE — comments and code
  // blanked, then every definitely-hidden container (hidden, aria-hidden,
  // display:none…) through the guardrails' own walker. The publisher's
  // rendered view of the same text says which lines render at all (Codex r3
  // on #5272: multi-line reference definitions). Every image in the raw body
  // is still judged (a hidden image still ships), but only a visible one
  // counts as showing its slot.
  const cg = require('./content-guardrails');
  const renderedBody = cg.blankDefinitelyHiddenContent(cg.blankNonRenderedMarkdown(body));
  // Lines to skip between an image and its credit: blank once reference
  // definitions (any length) are blanked — a visible MDX component on the
  // way still counts as content (Codex r4 on #5272).
  // Block context (blockquote depth, list membership) comes from the
  // depth-aware blanker, so a definition inside "> [p]: …" is recognised
  // too (Codex r5 on #5272).
  const withDepths = cg.blankNonRenderedMarkdownWithDepths(body);
  const viewLines = cg.blankReferenceDefinitions(cg.blankDefinitelyHiddenContent(withDepths.text), { depths: withDepths.depths, inList: withDepths.inList }).split('\n');
  const allowed = allowedIdentificationPhotoSrcs(brief, context);
  const occurrences = collectBodyImageOccurrences(body, { mdx });
  const usedCreditLines = new Set();
  for (const { alt, url, form, line } of occurrences) {
    const failure = validateLibraryPhoto(libraryPhotoBySrc(url), alt, url, renderedBody, line, { viewLines, usedCreditLines });
    if (failure) return failure;
    // Raw <img> (src or srcset) is outside the publisher's Markdown subset —
    // validateBodyImageRefs parks it at publish — so a library photo shipped
    // that way still fails here. Every Markdown FORM bodyImageRefs resolves
    // (inline, full/collapsed reference, shortcut) is accepted, matching
    // what the publisher actually ships.
    if (form !== 'markdown') return { ok: false, reason: `identification_photo_unsupported_form:${form}:${url}` };
    if (!allowed.has(url)) return { ok: false, reason: `identification_photo_not_in_brief_slots:${url}` };
  }
  // Codex r5 on #5216: the writer must embed every slot its brief
  // POPULATED (null slots stay empty) — the loop above only judges images
  // that are present, so a draft that omitted them all passed. A refresh
  // carries no slots and is never required to add a photo.
  if (brief?.action_type !== 'refresh_existing_page') {
    const shown = new Set(collectBodyImageOccurrences(cg.blankDefinitelyHiddenContent(body), { mdx }).filter((o) => o.form === 'markdown').map((o) => o.url));
    const slots = Array.isArray(brief?.voice_constraints?.photo_slots) ? brief.voice_constraints.photo_slots : [];
    for (const slot of slots) {
      const src = slot?.photo?.src;
      if (src && !shown.has(src)) return { ok: false, reason: `identification_photo_slot_missing:${slot.slot || 'unknown'}:${src}` };
    }
  }
  return { ok: true };
}

function checkVoiceMatch(draft) {
  const body = String(draft.body || '').toLowerCase();
  // Lightweight voice signals from the canonical waves_default voice
  // (sandy soil / afternoon storms / St. Augustine / use "you" frequently).
  let signals = 0;
  if (/\b(sandy soil|afternoon storms?|st\.?\s*augustine|swfl|nitrogen.*phosphorus|chinch)\b/.test(body)) signals++;
  // Dense use of "you/your" is a Waves voice marker.
  const youMatches = (body.match(/\byou(r)?\b/g) || []).length;
  if (youMatches >= 5) signals++;
  if (signals === 0) return { ok: false, reason: 'no_voice_match_signals' };
  return { ok: true };
}

// ── citability nudges (supporting-blog, weight 0) ────────────────────
//
// Mirrors the writer prompt's CITABILITY section (same bracket codes). All
// four are heuristics over the raw body: they detect the SHAPE of a citable
// post, never the truth of a claim — truth stays with the guardrails and the
// evidence rules. Failing any of them only adds a nudge.

// Post types whose contract is a choice (packages/blog-schema
// postTypeRequirements: decision + comparison + cost all require a
// ComparisonTable). Read from the writer's frontmatter; unset or unknown
// post types are treated as non-choice (the astro publisher's own
// normalization decides the final type — this gate only nudges).
const CHOICE_POST_TYPES = new Set(['decision', 'comparison', 'cost']);

// A refresh ships the LIVE page's non-meta frontmatter (publishRefresh
// freezes it), so the prior version's post_type is what actually publishes
// (Codex r6 P2); a new post uses the writer's own frontmatter.
function draftPostType(draft, context) {
  const frozen = context?.previousVersion?.frontmatter?.post_type;
  const type = frozen != null && String(frozen).trim() ? frozen : (draft?.frontmatter?.post_type ?? draft?.post_type ?? '');
  return String(type).trim().toLowerCase();
}

// Named authorities the evidence rules already point the writer at (UF/IFAS,
// FDACS, EPA, CDC, county mosquito programs, product labels). Deliberately a
// SOURCE-attribution list, not a brand list: PRO_PRODUCT_TERMS stay banned in
// recommendation context and competitor names live only inside the
// ComparisonTable, so neither may count toward this nudge.
// The county prefix is REQUIRED: a bare "Mosquito Control" is our own
// service name and must not count as an external authority (fallback P2).
const NAMED_AUTHORITY = String.raw`(?:UF\s*\/\s*IFAS|IFAS|University of Florida|USDA|NOAA|National Weather Service|Cooperative Extension|FDACS|Florida Department of Agriculture|Florida Department of Health|(?:U\.?S\.? )?EPA\b|Environmental Protection Agency|CDC\b|Centers for Disease Control|National Pesticide Information Center|NPIC|NPMA|FPMA|National Pest Management Association|Florida Pest Management Association|National Hurricane Center|USGS|U\.S\. Geological Survey|Florida Statutes?|[A-Z][a-z]+ County Mosquito (?:Control|Management)|Mosquito Control District)`;
// Bare mentions are NOT attribution (Codex P2, 2026-09-26): "an
// EPA-registered product" names EPA without citing it for any claim. A named
// authority counts only in a citation frame — led by an attribution phrase,
// or followed by a reporting verb / source noun.
const NAMED_SOURCE_RE = new RegExp(
  String.raw`\b(?:[Aa]ccording to|[Pp]er|[Ff]rom|[Bb]y|[Cc]it(?:es?|ing)|[Uu]nder|[Ss]ee)\s+(?:the\s+)?(?:[\w.&'’-]+\s+){0,2}${NAMED_AUTHORITY}\b`
  + String.raw`|\b${NAMED_AUTHORITY}(?:'s|’s)?\s+(?:[\w-]+\s+){0,2}?(?:recommends?|says|notes?|reports?|advises?|found|finds|warns?|tracks?|lists?|states?|requires?|publish(?:es)?|estimates?|confirms?|defines?|guidance|data|research|fact sheets?|publications?|stud(?:y|ies)|surveys?|rules?|records?|recommendations?|label(?:ing)?)\b`
  + String.raw`|\b(?:[Pp]er|[Oo]n|[Uu]nder|[Aa]ccording to|[Rr]ead|[Ff]ollow) the (?:product )?label\b`,
);

// Refresh lane: the runner stamps target_page_type 'page' for non-blog
// targets (service/city pages), where the blog citability contract does not
// apply. Supporting-blog briefs carry no target_page_type → checks apply.
function nonBlogTarget(brief) {
  return brief?.target_page_type === 'page';
}

// Unquoted HTML attribute values (<aside aria-label=Recheck-in-14-days>)
// are configuration, like quoted ones — blank them in place so the
// equivalent attribute syntax cannot change a signal (Codex r6 P2).
function maskUnquotedAttrValues(src) {
  return String(src || '').replace(/<[A-Za-z][\w.:-]*(?:\s[^<>]*)?>/g, (tag) => tag.replace(
    /(\s[A-Za-z_:][\w:.-]*\s*=\s*)([^\s"'`{}<>=]+)/g,
    (_m, lead, value) => lead + ' '.repeat(value.length),
  ));
}

// Rendered lines only: fenced code, HTML/MDX comments and other non-rendered
// Markdown must not satisfy (or trip) a citability check (Codex r8 P2).
// The shared guardrails blanker preserves line structure but flattens list
// indentation, so restore only leading whitespace onto the masked text —
// never restore inline comments or code beside otherwise visible prose.
function renderedCitabilityBody(body) {
  const raw = String(body || '');
  const {
    blankNonRenderedMarkdown, blankDefinitelyHiddenContent, blankExpressions, maskJsxAttrQuotes, projectMdxDisplayText,
  } = require('./content-guardrails');
  // First remove comments/code, then containers a browser definitely hides;
  // finally mask JSX/HTML attribute values, which are configuration rather
  // than reader-visible copy. Keep tag names so visible ComparisonTable
  // components remain detectable.
  const visible = maskUnquotedAttrValues(blankDefinitelyHiddenContent(blankNonRenderedMarkdown(raw)));
  const blanked = maskJsxAttrQuotes(blankExpressions(visible));
  const orig = raw.split(/\r?\n/);
  const mask = blanked.split(/\r?\n/);
  if (orig.length !== mask.length) return blanked;
  const prose = orig.map((line, i) => (
    mask[i].trim() ? line.match(/^[\t ]*/)[0] + mask[i].trimStart() : ''
  )).join('\n');
  const componentText = projectMdxDisplayText(visible);
  return componentText ? `${prose}\n${componentText}` : prose;
}

// Attribution to ANY proper-noun source ("according to the Florida Forest
// Service", "data from NOAA", "per Mote Marine Laboratory"): the writer
// contract asks for the SPECIFIC authority the evidence came from, so the
// hardcoded list above cannot be exhaustive (Codex P2, 2026-09-26). The
// source must start with a capital; our own company never counts as the
// authority behind a claim.
const ATTRIBUTED_SOURCE_RE = /\b(?:[Aa]ccording to|[Pp]er|[Rr]eported by|[Pp]ublished by|[Dd]ata from|[Gg]uidance from|[Rr]esearch (?:from|by))\s+(?:the\s+)?([A-Z][\w&.'’-]*(?:\s+(?:of|for|and|&)?\s*[A-Z][\w&.'’-]*){0,6})/g;
// Natural subject-first attribution for named institutions outside the
// finite authority list ("Florida Forest Service reports ..."). Require an
// institutional head noun so a sentence-leading generic group such as
// "Homeowners report" does not become a named source merely by casing.
const DIRECT_INSTITUTION_SOURCE_RE = /\b((?:The\s+)?(?:[A-Z][\w&.'’-]*\s+){1,7}(?:Service|Laboratory|Department|Agency|Institute|University|Extension|District|Center|Centre|Commission|Council|Office|Association|Society|Foundation|Administration|Bureau|Authority|Program|Survey|Clinic|Hospital|Organization|Organisation|Institution|Station|Museum|Garden|Gardens))(?:'s|’s)?\s+(?:recommends?|says|notes?|reports?|advises?|found|finds|warns?|tracks?|lists?|states?|requires?|publishes?|estimates?|confirms?|defines?)\b/g;
const OWN_COMPANY_RE = /^(?:the\s+)?Waves\b/i;
// Capitalization is not evidence that a source is specific. These generic
// source head nouns are common LLM attribution filler and must not satisfy
// the named-source contract even when arbitrary title-cased modifiers make
// the whole phrase look proper ("Leading Experts", "Trusted Research").
const GENERIC_SOURCE_HEAD_RE = /\b(?:authorities|authority|experts?|officials?|professionals?|research|researchers?|scientists?|specialists?|studies|study)\s*$/i;
const SPECIFIC_SOURCE_ORG_RE = /\b(?:Service|Laboratory|Department|Agency|Institute|University|Extension|District|Center|Centre|Commission|Council|Office|Association|Society|Foundation|Administration|Bureau|Authority|Program|Survey|Clinic|Hospital|Organization|Organisation|Institution|Station|Museum|Garden|Gardens)\b/i;
const GENERIC_ORG_NAME_TOKEN_RE = /^(?:local|county|state|federal|national|regional|city|municipal|government|public|health|pest|control|industry|professional|professionals|management|community|trusted|leading|independent|official|recognized|respected|expert|research|science|scientific)$/i;
const CREDENTIALED_PERSON_RE = /^(?:Dr|Prof|Professor)\.?\s+[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+)+$/;
const NAMED_PUBLICATION_RE = /^(?:Nature|Science|Consumer Reports|Scientific American|Journal of(?:\s+[A-Z][\w&.'’-]*){1,6}|(?:[A-Z][\w&.'’-]*\s+){0,5}(?:Journal|Review|Times|Tribune|Post|Herald|Magazine))$/;

function genericAttributedSource(source) {
  return GENERIC_SOURCE_HEAD_RE.test(String(source || '').trim());
}

function hasSpecificOrganizationName(source) {
  const words = String(source || '').trim().replace(/^the\s+/i, '').split(/\s+/)
    .map((word) => word.replace(/^[^\w&]+|[^\w&]+$/g, ''))
    .filter(Boolean);
  const head = words.findIndex((word) => SPECIFIC_SOURCE_ORG_RE.test(word));
  if (head < 0) return false;
  const identifying = words.filter((word, index) => index !== head
    && !SPECIFIC_SOURCE_ORG_RE.test(word)
    && !/^(?:of|for|and|&)$/i.test(word)
    && !GENERIC_ORG_NAME_TOKEN_RE.test(word));
  // Universities, extension offices, services, and laboratories commonly
  // have one distinctive name token (Cornell University, University of
  // Miami, Florida Forest Service), and so do centers, surveys, and clinics
  // (National Hurricane Center, U.S. Geological Survey, Mayo Clinic) and
  // named organizations or stations (World Health Organization, Smithsonian
  // Institution, Everglades Research and Education Station) once the generic
  // tokens are gone (Codex r4/r5 P2). Looser heads such as Program
  // and Association need two, so locality-shaped filler like "Sarasota
  // County Program" does not become evidence merely through capitalization.
  const distinctiveHead = /^(?:University|Extension|Service|Laboratory|Center|Centre|Survey|Clinic|Hospital|Organization|Organisation|Institution|Station|Museum|Garden|Gardens)$/i.test(words[head]);
  return identifying.length >= (distinctiveHead ? 1 : 2);
}

function hasAttributedSource(body) {
  for (const m of String(body || '').matchAll(ATTRIBUTED_SOURCE_RE)) {
    const source = m[1].trim();
    const withoutArticle = source.replace(/^the\s+/i, '');
    if (!OWN_COMPANY_RE.test(source)
      && !genericAttributedSource(source)
      && (hasSpecificOrganizationName(source) || CREDENTIALED_PERSON_RE.test(source)
        || NAMED_PUBLICATION_RE.test(withoutArticle))) return true;
  }
  for (const m of String(body || '').matchAll(DIRECT_INSTITUTION_SOURCE_RE)) {
    const source = m[1].trim();
    if (!OWN_COMPANY_RE.test(source) && !genericAttributedSource(source)
      && hasSpecificOrganizationName(source)) return true;
  }
  return false;
}

// Reduce inline Markdown/HTML to its visible text so a LINKED or emphasized
// source ("According to [UF/IFAS](…)", "**CDC** recommends") reads the same
// as plain text to the attribution matchers (Codex P2, 2026-09-26).
function visibleInlineText(body) {
  return String(body || '')
    .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*(?:\n|$)/gm, ' ')
    .replace(/!\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])/g, ' ')
    .replace(/\[([^\]\n]+)\](?:\([^)\n]*\)|\[[^\]\n]*\])/g, '$1')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/(\*\*|__|\*|_)(?=\S)([^*_\n]+?)\1/g, '$2');
}

function checkCitabilityNamedSources(draft, brief) {
  if (nonBlogTarget(brief)) return { ok: true, reason: 'non_blog_target' };
  const body = visibleInlineText(renderedCitabilityBody(draft.body));
  if (NAMED_SOURCE_RE.test(body) || hasAttributedSource(body)) return { ok: true };
  return { ok: false, reason: 'no_named_source_attribution' };
}

// A "concrete specific" is a number bound to a unit of measure, time, or
// rate. Dollar amounts are excluded on purpose (HARDCODED_PRICE bans them),
// as are bare years and bare counts ("3 ways", "2024") — those are not the
// extractable measurements the nudge is after. Ranges ("3.5–4 inches",
// "10-14 days") count once.
const CONCRETE_SPECIFIC_RE = /(?<![$\d.,\/])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+|\/\d+| \d+\/\d+)?(?:\s?(?:-|–|to)\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+|\/\d+| \d+\/\d+)?)?(?:\s*[-–—]\s*|\s*)(?:%|(?:percent|inch(?:es)?|feet|foot|ft\b|yards?|sq\.? ?ft|square feet|millimeters?|mm\b|centimeters?|cm\b|meters?|°\s?F|degrees|days?|weeks?|months?|hours?|minutes?|seconds?|mph|gallons?|ounces?|oz\b|pounds?|lbs?|acres?|applications?|treatments?|visits?|mowings?|times? (?:a|per) (?:year|month|week|day)|per (?:year|month|week|day|acre|1,?000 sq))\b)(?:\s+(?:per|a|an|each|every)\s+(?:year|month|week|day|application|treatment|visit)\b)?/gi;
const CALENDAR_WINDOW_RE = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\s*(?:-|–|—|to|through)\s*(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+)?\d{1,2}(?:st|nd|rd|th)?\b/gi;

// Vague stand-ins for a measurement — the prompt's own examples ("tall",
// "a couple of weeks", "deeply"). Softening is what the nudge targets.
const VAGUE_QUALIFIER_RE = /\b(?:a (?:couple|few) (?:of )?(?:days|weeks|months|hours|inches|feet)|several (?:days|weeks|months|hours|inches)|(?:water|soak)(?:ing)? deeply|mow(?:ing)? (?:it )?(?:tall|high|short|low)|a while|(?:in|during|this|next|last|early|late|each|every|throughout|by|before|after) (?:the )?(?:spring|summer|fall|autumn|winter)|(?:spring|summer|fall|autumn|winter) (?:season|months?|weather|rains?|rainfall|temperatures?|conditions?|timing|window|applications?|treatments?|service|pressure|activity)|(?:rainy|dry) season)\b/i;

const UNIT_KEYS = [
  [/^(?:%|percent)$/, '%'],
  [/^inch(?:es)?$/, 'inch'],
  [/^(?:feet|foot|ft)$/, 'foot'],
  [/^(?:sq\.? ?ft|square feet)$/, 'sq ft'],
  [/^(?:°\s?f|degrees)$/, 'degree'],
  [/^(?:lbs?|pounds?)$/, 'pound'],
  [/^(?:oz|ounces?)$/, 'ounce'],
  [/^(?:mm|millimeters?)$/, 'mm'],
  [/^(?:cm|centimeters?)$/, 'cm'],
];

// One comparable key per measurement: the number (range dashes unified) and
// its unit in a single spelling, so "14 days", "14-day", and "14 day"
// compare equal while "4 inches" never stands in for "10–14 days".
function measurementKey(match) {
  const m = match.toLowerCase().replace(/\s+/g, ' ').trim();
  // Whole formatted numbers: "1,000" and "3 1/2" never shrink to a
  // trailing "000" / "1/2" (Codex r6 P2).
  const num = m.match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+|\/\d+| \d+\/\d+)?)(?:\s?(?:-|–|to)\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+|\/\d+| \d+\/\d+)?))?/);
  let unit = m.slice(num[0].length).replace(/^[\s\-–—]+/, '').trim();
  unit = unit.replace(/^times? (?:a|per) /, 'times per ');
  // Keep the trailing cadence ("1 inch per week" vs "1 inch per month",
  // Codex r7 P2) in one spelling: "a/each/every week" reads as "per week".
  let rate = '';
  const cadence = unit.match(/\s+(?:per|a|an|each|every)\s+(year|month|week|day|application|treatment|visit)$/);
  if (cadence && !/^(?:times per|per)\b/.test(unit)) {
    rate = ` per ${cadence[1]}`;
    unit = unit.slice(0, cadence.index);
  }
  const alias = UNIT_KEYS.find(([re]) => re.test(unit));
  if (alias) unit = alias[1];
  else unit = unit.split(' ').map((w) => w.replace(/s$/, '')).join(' ');
  const clean = (v) => v.replace(/,/g, '');
  return `${clean(num[1])}${num[2] ? `-${clean(num[2])}` : ''} ${unit}${rate}`;
}

function calendarKey(match) {
  const t = match.toLowerCase()
    .replace(/(\d)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/\s*(?:–|—|-|\bto\b|\bthrough\b)\s*/g, '-')
    .replace(/\b([a-z]{3})[a-z]*\.?/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return `cal:${t}`;
}

function concreteSpecificKeys(body) {
  // Remove complete dollar literals before scanning. Otherwise a
  // comma-formatted price such as "$1,200 per year" can be entered midway
  // at "200 per year" and masquerade as a non-price measurement.
  const text = visibleInlineText(body).replace(/\$\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:-|–|—|to)\s*\$?\s*\d[\d,]*(?:\.\d+)?)?/g, ' ');
  return [
    ...(text.match(CONCRETE_SPECIFIC_RE) || []).map(measurementKey),
    ...(text.match(CALENDAR_WINDOW_RE) || []).map(calendarKey),
  ];
}

function countConcreteSpecifics(body) {
  return concreteSpecificKeys(body).length;
}

// How many of the prior page's measurements the refresh still states, each
// counted at most as often as the draft repeats it — an unrelated new
// number or a repeated retained one cannot stand in for a dropped value
// (Codex r4 P2).
function retainedMeasurements(beforeKeys, afterKeys) {
  const available = new Map();
  for (const key of afterKeys) available.set(key, (available.get(key) || 0) + 1);
  let retained = 0;
  for (const key of beforeKeys) {
    const left = available.get(key) || 0;
    if (left > 0) {
      retained += 1;
      available.set(key, left - 1);
    }
  }
  return retained;
}

// NOT a count quota (Codex P2, 2026-09-26): a fixed minimum fired on every
// brief whose evidence held fewer measurements, pressuring a redraft toward
// invented numbers. The gate cannot see the writer's tool evidence, so it
// flags only what is visible as softening: a refresh that states fewer
// measurements than the page it replaces, or a draft with no measurement at
// all that leans on a vague stand-in instead.
function checkCitabilityConcreteSpecifics(draft, brief, context) {
  if (nonBlogTarget(brief)) return { ok: true, reason: 'non_blog_target' };
  const keys = concreteSpecificKeys(renderedCitabilityBody(draft.body));
  const n = keys.length;
  const prev = context?.previousVersion?.body;
  if (prev != null) {
    const beforeKeys = concreteSpecificKeys(renderedCitabilityBody(prev));
    const retained = retainedMeasurements(beforeKeys, keys);
    if (retained < beforeKeys.length) {
      return { ok: false, reason: `refresh_dropped_measurements_${beforeKeys.length}_to_${retained}` };
    }
  }
  if (n === 0) {
    const vague = renderedCitabilityBody(draft.body).match(VAGUE_QUALIFIER_RE);
    if (vague) return { ok: false, reason: `vague_qualifier_without_measurement:${vague[0].toLowerCase()}` };
  }
  return { ok: true };
}

const COMPARISON_TABLE_RE = /<ComparisonTable\b/;
// A choice the post itself frames: the title or a heading pits options
// against each other, or the post type's contract is a choice. Body prose
// is NOT scanned ("DIY" appears in most posts) — the nudge must not push a
// generic DIY-vs-pro table onto every post (the no-filler visual rule).
// Deliberately narrow: "X vs Y", "X or Y?" as a whole heading/title, and
// "which option/approach…". A bare "Should you…?" or a yes/no question is
// NOT a two-path comparison (it fired on 73% of the live corpus in the
// 2026-09-25 calibration run — most were single-answer questions).
const CHOICE_FRAMING_RE = /\bvs\.?\b|\bversus\b|^ {0,3}#*\s*[\w'’-]+(?: [\w'’-]+){0,3} or [\w'’-]+(?: [\w'’-]+){0,3}(?:\s*[:—-]\s*[^?\n]{1,80})?\??\s*$|\bwhich (?:[\w'’-]+ ){0,2}?(?:one|option|approach|method|plan|product|treatment|service)s? (?:is|are|fits|works|makes|do|does|should)\b|\bwhich (?:one |option )?(?:is|works|fits) (?:better|best)\b/i;

function headingLines(body) {
  return String(body || '').split(/\r?\n/).filter((l) => /^ {0,3}#{1,3}\s+\S/.test(l));
}

function postFramesAChoice(draft, context) {
  if (CHOICE_POST_TYPES.has(draftPostType(draft, context))) return true;
  const title = String(draft.title || draft.frontmatter?.title || '');
  if (CHOICE_FRAMING_RE.test(visibleInlineText(title))) return true;
  // Rendered heading text only: a link destination such as
  // "(/bait-vs-spray/)" is invisible to the reader (Codex r4 P2).
  return headingLines(renderedCitabilityBody(draft.body))
    .some((h) => CHOICE_FRAMING_RE.test(visibleInlineText(h)));
}

// Legacy .md posts cannot carry MDX components: publishRefresh keeps the
// extension and 422s a refreshed .md body containing <ComparisonTable>, so
// asking for one there could never publish (Codex r7 P2; same rule as the
// #4845 backfill scan). The markdown-only signals still apply.
function markdownOnlyTarget(brief) {
  return /\.md$/i.test(String(brief?.target_file_path || ''));
}

function checkCitabilityComparison(draft, brief, context) {
  if (nonBlogTarget(brief)) return { ok: true, reason: 'non_blog_target' };
  if (markdownOnlyTarget(brief)) return { ok: true, reason: 'markdown_only_post_cannot_carry_ComparisonTable' };
  const hasTable = COMPARISON_TABLE_RE.test(renderedCitabilityBody(draft.body));
  if (hasTable) return { ok: true };
  if (!postFramesAChoice(draft, context)) return { ok: true, reason: 'no_choice_framed' };
  return { ok: false, reason: 'choice_framed_without_ComparisonTable' };
}

const HOW_TO_CHOOSE_HEADING_RE = /\b(?:how to (?:choose|pick|decide)|choosing (?:between|the right|a|your)|which (?:one|option|approach|method|plan|treatment|service)[^\n]{0,40}\b(?:right|fits?|for you|for your)|what to (?:weigh|look for|consider)|decision (?:guide|checklist)|fits your situation)\b/i;

const HOW_TO_CHOOSE_MIN_CRITERIA = 3;
const HOW_TO_CHOOSE_MAX_CRITERIA = 5;

// The contract is an H2 carrying 3–5 bulleted criteria (Codex P2s,
// 2026-09-26 — both bounds): an H3, or an H2 over plain prose, is not the extractable
// structure the nudge measures. Criteria = list items before the next H1/H2.
function howToChooseSectionCriteria(body) {
  const lines = String(body || '').split(/\r?\n/);
  let best = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^ {0,3}##\s+\S/.test(lines[i]) || !HOW_TO_CHOOSE_HEADING_RE.test(visibleInlineText(lines[i]))) continue;
    // Top-level criteria only; nested explanation bullets never count.
    let items = 0;
    let topContentColumn = null;
    for (let j = i + 1; j < lines.length && !/^ {0,3}#{1,2}\s/.test(lines[j]); j += 1) {
      const m = lines[j].match(/^(\s*)[-*+]([ \t]+)(\S.*)$/);
      if (!m) continue;
      const indent = m[1].replace(/\t/g, '    ').length;
      // CommonMark decides nesting against the preceding peer item's
      // content column, not one global minimum marker indent. Thus 0/1/2
      // and 1/2/3 marker columns are peers, while 0/1/3 nests the third
      // marker beneath the second (whose content begins at column 3).
      const topLevel = topContentColumn === null || indent < topContentColumn;
      if (topLevel) topContentColumn = indent + 1 + m[2].replace(/\t/g, '    ').length;
      const criterion = visibleInlineText(m[3]).trim();
      // An observable condition: a conditional lead word, or any noun-phrase
      // check ahead of an arrow ("Active mud tubes → choose liquid", Codex r6 P2).
      const hasCondition = /^(?:if|when|for|where|with|without|after|before|once)\b/i.test(criterion)
        || /^[^→]*\w[^→]*\s*(?:→|->)\s*\S/.test(criterion);
      const namesOption = /(?:→|->|\b(?:choose|pick|use|prefer|select|go with|call|hire|apply|install|schedule|start with|switch to)\b)/i.test(criterion);
      if (topLevel && hasCondition && namesOption) items += 1;
    }
    best = Math.max(best, items);
  }
  return best; // -1 = no H2 found
}

function checkCitabilityHowToChoose(draft, brief, context) {
  if (nonBlogTarget(brief)) return { ok: true, reason: 'non_blog_target' };
  const body = renderedCitabilityBody(draft.body);
  const applies = COMPARISON_TABLE_RE.test(body) || postFramesAChoice(draft, context);
  if (!applies) return { ok: true, reason: 'no_comparison_to_choose_from' };
  const criteria = howToChooseSectionCriteria(body);
  if (criteria < 0) return { ok: false, reason: 'no_how_to_choose_section' };
  if (criteria < HOW_TO_CHOOSE_MIN_CRITERIA) return { ok: false, reason: `how_to_choose_has_${criteria}_criteria_need_${HOW_TO_CHOOSE_MIN_CRITERIA}+` };
  if (criteria > HOW_TO_CHOOSE_MAX_CRITERIA) return { ok: false, reason: `how_to_choose_has_${criteria}_criteria_max_${HOW_TO_CHOOSE_MAX_CRITERIA}` };
  return { ok: true };
}

// ── citability backfill completion (refresh, weight-0 hard) ──────────
//
// Composes the four signals above — no heuristic of its own. Two traits
// bind as STRUCTURE on a backfill: once a comparison / how_to_choose gap is
// planned (or the live page already carried the structure), only the
// <ComparisonTable> or the 3–5-criteria How-to-choose H2 itself satisfies
// it. The signal checks answer "not applicable" once the choice framing is
// gone, so without this a refresh could rename a heading and skip the work.
const CITABILITY_GAP_CHECKS = {
  named_sources: checkCitabilityNamedSources,
  concrete_specifics: checkCitabilityConcreteSpecifics,
  comparison: checkCitabilityComparison,
  how_to_choose: checkCitabilityHowToChoose,
};

const CITABILITY_STRUCTURES = {
  comparison: (body) => COMPARISON_TABLE_RE.test(body),
  how_to_choose: (body) => {
    const n = howToChooseSectionCriteria(body);
    return n >= HOW_TO_CHOOSE_MIN_CRITERIA && n <= HOW_TO_CHOOSE_MAX_CRITERIA;
  },
};

function citabilityStructurePresent(gap, body) {
  return CITABILITY_STRUCTURES[gap](renderedCitabilityBody(body));
}

function checkCitabilityBackfillGapsCleared(draft, brief, context) {
  if (!isCitabilityBackfillBrief(brief)) return { ok: true, reason: 'not_citability_backfill' };
  if (nonBlogTarget(brief)) return { ok: true, reason: 'non_blog_target' };
  const ctx = context || {};
  const planned = brief.gsc_signal.citability_gaps;
  const unresolved = [];
  for (const gap of planned) {
    const check = CITABILITY_GAP_CHECKS[gap];
    if (!check) continue;
    // A legacy .md target cannot carry the MDX table; the signal already
    // answers not-applicable there, so the structure is never demanded.
    if (CITABILITY_STRUCTURES[gap] && !(gap === 'comparison' && markdownOnlyTarget(brief))) {
      if (!citabilityStructurePresent(gap, draft.body)) unresolved.push(`${gap}(structure_missing)`);
      continue;
    }
    const r = check(draft, brief, ctx);
    if (!r.ok) unresolved.push(`${gap}(${r.reason})`);
  }
  if (unresolved.length) return { ok: false, reason: `planned_gaps_unresolved:${unresolved.join(',')}` };
  // A targeted edit must not trade one trait for another: a trait the live
  // page already satisfied may not be lost.
  const prev = ctx.previousVersion;
  if (prev && typeof prev.body === 'string') {
    const prevDraft = {
      ...draft,
      body: prev.body,
      title: prev.frontmatter?.title || draft.title,
      frontmatter: prev.frontmatter || draft.frontmatter,
    };
    // The prior page is judged on its own (no body to compare against); the
    // frozen frontmatter still classifies its post_type.
    const prevCtx = prev.frontmatter ? { previousVersion: { frontmatter: prev.frontmatter } } : {};
    const regressed = [];
    for (const [gap, check] of Object.entries(CITABILITY_GAP_CHECKS)) {
      if (planned.includes(gap)) continue;
      if (CITABILITY_STRUCTURES[gap]) {
        if (citabilityStructurePresent(gap, prev.body) && !citabilityStructurePresent(gap, draft.body)) regressed.push(gap);
        continue;
      }
      if (check(prevDraft, brief, prevCtx).ok && !check(draft, brief, ctx).ok) regressed.push(gap);
    }
    if (regressed.length) return { ok: false, reason: `citability_traits_regressed:${regressed.join(',')}` };
  }
  return { ok: true };
}

// The four optional signals as retry advisories ({ code, message }), for
// the writer's in-session emit_draft redraft, which runs before any
// run-level evaluate() (5013 Codex r2 P2). Same checks, same codes as the
// run-level soft_failures path.
const CITABILITY_CHECKS = [
  ['citability_named_sources', checkCitabilityNamedSources],
  ['citability_concrete_specifics', checkCitabilityConcreteSpecifics],
  ['citability_comparison', checkCitabilityComparison],
  ['citability_how_to_choose', checkCitabilityHowToChoose],
];

function citabilityAdvisories(draft, brief, context) {
  const out = [];
  for (const [name, check] of CITABILITY_CHECKS) {
    let result;
    try { result = check(draft, brief, context); } catch { continue; }
    if (result && result.ok === false) {
      out.push({ code: name.toUpperCase(), message: String(result.reason || 'optional citability signal').slice(0, 300) });
    }
  }
  return out;
}

// ── metadata checks ─────────────────────────────────────────────────

function checkTitleLengthBounds(draft, brief, context) {
  // Protected service/location metaTitle: the publisher keeps the live value,
  // so the draft's proposal never ships — length-checking it would park valid
  // description-only rewrites (owner rule 2026-07-16).
  if (context?.protectedTitle) return { ok: true, reason: 'protected_title_not_published' };
  const t = (draft.title || draft.frontmatter?.title || '').trim();
  if (!t) return { ok: false, reason: 'no_title' };
  if (t.length < 30 || t.length > 70) return { ok: false, reason: `title_length_${t.length}_outside_30-70` };
  return { ok: true };
}

function checkMetaLengthBounds(draft) {
  const raw = (draft.meta_description || draft.frontmatter?.meta_description || '').trim();
  if (!raw) return { ok: false, reason: 'no_meta_description' };
  // Bound the RENDERED length — metas carry per-domain tokens ({{cityPhone}},
  // {{brandShort}}) and Google measures what renders, not the template
  // (owner rule 2026-07-29: never over 160 rendered characters).
  const m = renderMetaTokens(raw).trim();
  if (m.length < 115 || m.length > 160) return { ok: false, reason: `meta_rendered_length_${m.length}_outside_115-160` };
  return { ok: true };
}

function checkPrimaryKeywordInTitle(draft, brief, context) {
  // Protected metaTitle targets: the shipped title is the unchanged live one
  // (which carries the keyword by construction) — see checkTitleLengthBounds.
  if (context?.protectedTitle) return { ok: true, reason: 'protected_title_not_published' };
  const t = (draft.title || draft.frontmatter?.title || '').toLowerCase();
  const kw = (brief.target_keyword || '').toLowerCase();
  if (!kw) return { ok: false, reason: 'no_target_keyword_on_brief' };
  const kwTokens = kw.split(/\s+/).filter((w) => w.length > 3);
  const matched = kwTokens.filter((w) => t.includes(w)).length;
  if (matched < Math.max(1, kwTokens.length - 1)) {
    return { ok: false, reason: `title_missing_keyword_tokens_(${matched}/${kwTokens.length})` };
  }
  return { ok: true };
}

// Literal phone shapes: "(941) 555-1234", "941-555-1234", "941.555.1234".
// Meta text must use the {{cityPhone}} token instead — see the bundle entry.
const LITERAL_PHONE_IN_META_RE = /\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/;

// The two meta contracts (owner rule 2026-07-29), applied per target type.
// SALESY_META_RE / SOFT_CTA_RE are shared with content-guardrails via
// title-meta-spam-gate so the definitions can't drift.
function pageMetaPhoneResult(m) {
  // Requirement is {{cityPhone}} SPECIFICALLY — {{phone}}/{{tel}} render the
  // generic line, not the tracking number that belongs to this page.
  if (!CITY_PHONE_TOKEN_RE.test(m)) return { ok: false, reason: 'meta_missing_cityPhone_token' };
  if (LITERAL_PHONE_IN_META_RE.test(m)) return { ok: false, reason: 'literal_phone_in_meta_use_cityPhone_token' };
  return { ok: true };
}
function blogMetaContractResult(m) {
  // BARE_PHONE_DIGITS_RE: a separator-less "9412972606" slips the shaped
  // literal-phone regex and the PII scan (known business number) — Codex r4.
  if (PHONE_TOKEN_RE.test(m) || LITERAL_PHONE_IN_META_RE.test(m) || BARE_PHONE_DIGITS_RE.test(m)) {
    return { ok: false, reason: 'blog_meta_must_not_carry_phone' };
  }
  if (SALESY_META_RE.test(m)) return { ok: false, reason: 'blog_meta_salesy' };
  // Sales-copy shapes stay HARD in every sentence — "Learn more about
  // saving big with Waves." is sales copy SALESY_META_RE alone misses (the
  // gerund), even when an informational closer follows it. This rejection
  // used to live inside endsWithSoftCta; demoting the CTA requirement must
  // not demote it (Codex P1s, 2026-07-30).
  if (metaHasSalesCopy(m)) return { ok: false, reason: 'blog_meta_sales_copy' };
  // Soft-CTA ending is NOT part of the hard contract (owner ruling
  // 2026-07-30: an otherwise-clean draft must never park on it) — it's the
  // weight-0 soft check blog_meta_soft_cta instead.
  return { ok: true };
}

// Owner ruling 2026-07-30: the soft-CTA ending ("Learn more…") is a nudge,
// not a publish blocker — drafts that passed every other check were being
// hard-parked on this alone. Weight-0 SOFT: the miss stays visible in
// soft_failures / reviewer notes (and feeds back to the writer on redraft)
// but contributes nothing to scores, thresholds, or ok.
function checkBlogMetaSoftCta(draft, brief) {
  // Metadata lane can target non-blog pages, whose metas have no CTA
  // contract (they carry {{cityPhone}} instead — see pageMetaPhoneResult).
  if (brief?.target_page_type === 'page') return { ok: true, reason: 'page_meta_has_no_cta_contract' };
  const m = (draft.meta_description || draft.frontmatter?.meta_description || draft.frontmatter?.metaDescription || '').trim();
  if (!m) return { ok: true, reason: 'no_meta_to_check' };
  // The CTA must END the meta (last sentence), not merely appear somewhere —
  // "Learn more about X. Professional treatment available…" is not the shape.
  if (!endsWithSoftCta(m)) return { ok: false, reason: 'blog_meta_missing_soft_cta' };
  return { ok: true };
}

// A typed-out phone in the publishable TITLE ships the wrong tracking number
// on every other domain, same as in the meta. Checked wherever the title
// will actually publish (a protected metaTitle proposal is discarded by the
// publisher, so it's exempt via context.protectedTitle).
function titleLiteralPhoneResult(draft) {
  const t = (draft.title || draft.frontmatter?.title || '').trim();
  if (t && LITERAL_PHONE_IN_META_RE.test(t)) return { ok: false, reason: 'literal_phone_in_title' };
  return { ok: true };
}

// Metadata-rewrite lane: target-aware (brief.target_page_type is derived from
// the RESOLVED target file by the runner; unresolved targets now PARK before
// this gate runs — see metadata_target_unresolved).
function checkMetaPhoneTokenPresent(draft, brief, context) {
  // Publishable titles never carry a typed-out number either — skip only
  // when the proposal is discarded (protected metaTitle target).
  if (!context?.protectedTitle) {
    const titleResult = titleLiteralPhoneResult(draft);
    if (!titleResult.ok) return titleResult;
  }
  const m = (draft.meta_description || draft.frontmatter?.meta_description || draft.frontmatter?.metaDescription || '').trim();
  if (!m) return { ok: false, reason: 'no_meta_description' };
  return brief?.target_page_type === 'page' ? pageMetaPhoneResult(m) : blogMetaContractResult(m);
}

// city-service bundle: newly authored city/service pages must carry the
// {{cityPhone}} token. Meta PRESENCE is other gates' job — empty defers.
function checkCityServiceMetaPhone(draft) {
  const titleResult = titleLiteralPhoneResult(draft);
  if (!titleResult.ok) return titleResult;
  const m = (draft.meta_description || draft.frontmatter?.meta_description || draft.frontmatter?.metaDescription || '').trim();
  if (!m) return { ok: true, reason: 'no_meta_to_check' };
  return pageMetaPhoneResult(m);
}

// Authoring bundles: rendered-length hard check for NEW drafts. The blog
// schema and the spam gate measure LITERAL length (spam gate soft-warns
// 161-190), so a 156-char template carrying {{brandName}} could render 161+
// and publish. Empty defers — presence is other gates' job.
function checkAuthoredMetaLength(draft, brief, context) {
  const raw = (draft.meta_description || draft.frontmatter?.meta_description || draft.frontmatter?.metaDescription || '').trim();
  if (!raw) return { ok: true, reason: 'no_meta_to_check' };
  return checkMetaLengthBounds(draft, brief, context);
}

// supporting-blog bundle: newly authored blog posts get the full blog meta
// contract (no phone, nothing salesy, soft CTA) — without this, a fresh blog
// draft bypassed the metadata-lane check entirely and could auto-publish a
// promotional meta.
function checkBlogMetaContract(draft) {
  const titleResult = titleLiteralPhoneResult(draft);
  if (!titleResult.ok) return titleResult;
  const m = (draft.meta_description || draft.frontmatter?.meta_description || '').trim();
  if (!m) return { ok: true, reason: 'no_meta_to_check' };
  return blogMetaContractResult(m);
}

function checkNoDuplicateTitle(draft, _brief, context) {
  // Protected metaTitle targets: the shipped title is the unchanged live one,
  // which cannot NEWLY collide with a sibling — see checkTitleLengthBounds.
  if (context?.protectedTitle) return { ok: true, reason: 'protected_title_not_published' };
  const t = (draft.title || draft.frontmatter?.title || '').trim().toLowerCase();
  if (!t || !context.siblingTitles) return { ok: true };
  if (context.siblingTitles.has(t)) return { ok: false, reason: 'title_duplicates_existing_page' };
  return { ok: true };
}

// DANGLING_META_ENDINGS is exported as the single source of truth for
// "words a meta may not end on" — astro-publisher's clamp fallback strips
// against the SAME set so a clamped meta can never fail this gate.
module.exports = { evaluate, MIN_TOTAL_SCORES, minTotalScoreFor, DANGLING_META_ENDINGS, citabilityAdvisories };
module.exports._internals = {
  HARD_CHECKS,
  PAGE_TYPE_CHECKS,
  MIN_TOTAL_SCORES,
  // individual evaluators surfaced for unit tests:
  checkSchemaValid, checkTitleMetaSpamFree, checkMetaDescriptionComplete, checkSerpBriefAttached, checkGscSignalAttached,
  isOperatorAuthoredBrief, isCompetitorGapBrief, isAeoQuestionGapBrief, isCitabilityBackfillBrief,
  checkNoDuplicateIntent, checkCanonical, checkIndexable,
  checkSitemapUpdated, checkPreviewSuccess,
  checkNapConsistent, checkLocalProof, checkCtaAboveFold,
  checkServiceMenu, checkFaqFromCustomer, checkLocalBusinessServiceSchema,
  checkAnswerInFirstParagraph, checkSourceInternalLink, checkRedactionPassed,
  checkImprovementOverPrior,
  checkHubLinkPresent, checkTwoPlusCityMentions, checkFaqSectionPresent, checkVoiceMatch,
  checkCitabilityNamedSources, checkCitabilityConcreteSpecifics, checkCitabilityComparison, checkCitabilityHowToChoose,
  checkCitabilityBackfillGapsCleared,
  countConcreteSpecifics, CHOICE_POST_TYPES,
  checkTitleLengthBounds, checkMetaLengthBounds,
  checkPrimaryKeywordInTitle, checkNoDuplicateTitle,
  checkMetaPhoneTokenPresent, checkCityServiceMetaPhone, checkBlogMetaContract,
  checkBlogMetaSoftCta, checkAuthoredMetaLength,
  checkNoRawMarkdownTables,
  checkBodySyntaxSupported,
  checkVerdictBoxFirst, checkCtaAfterVerdictBox,
  checkPhotoSlotsLicensedOnly, isIdentificationOrQuestionDraft, effectiveFrontmatter, checkNextStepsRedacted,
  collectBodyImageOccurrences,
};
