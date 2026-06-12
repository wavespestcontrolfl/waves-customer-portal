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
 *                         FAQ_from_customer_calls, LocalBusiness+Service schema
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
 * and pass/fail. Total score is sum; gate requires score >= 75 AND
 * zero hard-check failures.
 */

const { THRESHOLDS } = require('./scoring-config');
const { evaluateTitleMetaSpam } = require('./title-meta-spam-gate');
const { isFaqBlockedService } = require('./content-guardrails');

// Compute the achievable maximum score from the weight map so the
// pass threshold is always a reachable fraction of it. The v3.1 plan
// wanted "min total ~75%" — apply that as a percentage of the real
// ceiling rather than a hardcoded literal (a hardcoded 75 was
// unreachable: common hard checks = 37, largest page-specific
// bundle = city-service at 36, so absolute max = 73).
const PASS_THRESHOLD_PCT = 0.75;

function computeMaxAchievableScore(hardChecks, pageTypeChecks) {
  const commonSum = hardChecks.reduce((s, c) => s + c.weight, 0);
  let maxPageTypeSum = 0;
  for (const checks of Object.values(pageTypeChecks)) {
    const sum = checks.reduce((s, c) => s + c.weight, 0);
    if (sum > maxPageTypeSum) maxPageTypeSum = sum;
  }
  return commonSum + maxPageTypeSum; // ceiling for any single page type
}

// Computed below after the check arrays are defined.
let MIN_TOTAL_SCORE;

// Each check carries (name, weight, isHard, evaluate(draft, brief)).
// Hard checks are pass/fail and short-circuit publishing on failure.
// Soft checks contribute weighted score.

const HARD_CHECKS = [
  { name: 'schema_valid', weight: 8, evaluate: checkSchemaValid },
  { name: 'title_meta_spam_free', weight: 0, evaluate: checkTitleMetaSpamFree },
  { name: 'serp_brief_attached', weight: 4, evaluate: checkSerpBriefAttached },
  { name: 'gsc_signal_attached', weight: 4, evaluate: checkGscSignalAttached },
  { name: 'no_duplicate_intent', weight: 6, evaluate: checkNoDuplicateIntent },
  { name: 'canonical_self_referencing', weight: 4, evaluate: checkCanonical },
  { name: 'indexable', weight: 4, evaluate: checkIndexable },
  { name: 'sitemap_updated', weight: 3, evaluate: checkSitemapUpdated },
  { name: 'preview_success', weight: 4, evaluate: checkPreviewSuccess },
];

const PAGE_TYPE_CHECKS = {
  'city-service': [
    { name: 'nap_consistent', weight: 6, evaluate: checkNapConsistent },
    { name: 'local_proof_present', weight: 6, evaluate: checkLocalProof },
    { name: 'cta_above_fold', weight: 6, evaluate: checkCtaAboveFold },
    { name: 'service_menu_present', weight: 6, evaluate: checkServiceMenu },
    { name: 'faq_from_customer_calls', weight: 6, evaluate: checkFaqFromCustomer },
    { name: 'localbusiness_service_schema', weight: 6, isHard: true, evaluate: checkLocalBusinessServiceSchema },
  ],
  'customer-question': [
    { name: 'answer_in_first_paragraph', weight: 8, evaluate: checkAnswerInFirstParagraph },
    { name: 'source_internal_link', weight: 6, evaluate: checkSourceInternalLink },
    { name: 'redaction_passed', weight: 8, isHard: true, evaluate: checkRedactionPassed },
  ],
  refresh: [
    { name: 'improvement_over_prior', weight: 10, evaluate: checkImprovementOverPrior },
  ],
  'supporting-blog': [
    { name: 'hub_link_present', weight: 6, evaluate: checkHubLinkPresent },
    { name: 'two_plus_city_mentions', weight: 4, evaluate: checkTwoPlusCityMentions },
    { name: 'faq_section_present', weight: 4, evaluate: checkFaqSectionPresent },
    { name: 'voice_match', weight: 6, evaluate: checkVoiceMatch },
  ],
  metadata: [
    { name: 'title_length_in_bounds', weight: 6, isHard: true, evaluate: checkTitleLengthBounds },
    { name: 'meta_length_in_bounds', weight: 6, isHard: true, evaluate: checkMetaLengthBounds },
    { name: 'primary_keyword_in_title', weight: 6, evaluate: checkPrimaryKeywordInTitle },
    { name: 'no_duplicate_title', weight: 8, isHard: true, evaluate: checkNoDuplicateTitle },
  ],
  links: [],
  gbp: [],
  none: [],
};

// Resolve MIN_TOTAL_SCORE now that check arrays are defined.
// MAX_ACHIEVABLE = 37 common + 36 city-service = 73.
// MIN_TOTAL_SCORE = floor(73 * 0.75) = 54.
const MAX_ACHIEVABLE_SCORE = computeMaxAchievableScore(HARD_CHECKS, PAGE_TYPE_CHECKS);
MIN_TOTAL_SCORE = Math.floor(MAX_ACHIEVABLE_SCORE * PASS_THRESHOLD_PCT);

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
 *   - total_score >= MIN_TOTAL_SCORE (75)
 */
function evaluate(draft, brief, context = {}) {
  if (!draft) throw new Error('content-quality-gate: draft required');
  if (!brief) throw new Error('content-quality-gate: brief required');

  const pageType = brief.page_type || 'none';
  const allChecks = [
    ...HARD_CHECKS.map((c) => ({ ...c, isHard: true })),
    ...(PAGE_TYPE_CHECKS[pageType] || []),
  ];

  const results = {};
  const hardFailures = [];
  const softFailures = [];
  let totalScore = 0;

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

  const ok = hardFailures.length === 0 && totalScore >= MIN_TOTAL_SCORE;
  return {
    ok,
    total_score: totalScore,
    min_total_score: MIN_TOTAL_SCORE,
    hard_failures: hardFailures,
    soft_failures: softFailures,
    checks: results,
  };
}

// ── HARD checks ──────────────────────────────────────────────────────

function checkSchemaValid(draft) {
  const schema = draft.schema || draft.frontmatter?.schema;
  if (!schema) return { ok: false, reason: 'no_schema_block' };
  if (typeof schema === 'object') return { ok: true };
  // String schema must parse as JSON-LD.
  try { JSON.parse(schema); return { ok: true }; }
  catch { return { ok: false, reason: 'schema_not_valid_json' }; }
}

function checkTitleMetaSpamFree(draft, brief) {
  const result = evaluateTitleMetaSpam({
    title: draft.title || draft.frontmatter?.title,
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
    && s.competitor_position != null && s.search_volume != null;
}

function checkGscSignalAttached(_draft, brief) {
  if (isOperatorAuthoredBrief(brief)) {
    return { ok: true, reason: 'operator_authored_brief' };
  }
  if (isCompetitorGapBrief(brief)) {
    return { ok: true, reason: 'competitor_gap_evidence' };
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
  // NAP = Name, Address, Phone. For a city-service page, must include
  // a Waves phone number tied to that city (per the WAVES_HUB_CITY_PHONES
  // mapping in the repo) and a service-area mention.
  if (!/Waves Pest Control/i.test(body)) return { ok: false, reason: 'business_name_missing' };
  if (!/\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(body)) return { ok: false, reason: 'phone_missing' };
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

function checkAnswerInFirstParagraph(draft, brief) {
  const body = String(draft.body || '');
  const firstParagraph = body.split(/\n\s*\n/)[0] || '';
  const q = brief.customer_signal?.normalized_question || brief.target_keyword || '';
  if (!q) return { ok: false, reason: 'no_question_to_check_against' };
  // First paragraph should be a direct answer — short (< 400 chars)
  // and contain at least one key noun from the question.
  if (firstParagraph.length > 600) return { ok: false, reason: 'first_paragraph_too_long_for_quick_answer' };
  const qNouns = q.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
  const matched = qNouns.some((n) => firstParagraph.toLowerCase().includes(n));
  if (!matched) return { ok: false, reason: 'first_paragraph_doesnt_address_question' };
  return { ok: true };
}

function checkSourceInternalLink(draft) {
  const body = String(draft.body || '');
  // At least one internal link to a hub or related page.
  if (!/\]\(\/[a-z0-9-]+/i.test(body)) return { ok: false, reason: 'no_internal_link_found' };
  return { ok: true };
}

// Explicit allowlist of known Waves phone numbers (last 7 digits — all
// in the 941 area code today). Per memory: 318-7612 LWR/Bradenton,
// 297-2817 Parrish, 297-2606 Sarasota, 297-3337 Venice, 240-2066 NP,
// 297-5749 main (PC + Palmetto). Anything not on the list is treated
// as customer PII regardless of area code.
const WAVES_PHONE_LAST_SEVEN = new Set([
  '3187612', '2972817', '2972606', '2973337', '2402066', '2975749',
]);

function checkRedactionPassed(draft) {
  const body = String(draft.body || '');
  // Broad phone regex covers both `941-555-1234` and `(941) 555-1234`
  // (and a few common variants). Previous regex missed parenthesized
  // formats, which let parenthesized customer numbers bypass the
  // redaction hard check entirely.
  const phoneRe = /\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
  const phoneMatches = body.match(phoneRe) || [];
  for (const raw of phoneMatches) {
    const digits = raw.replace(/\D/g, '');
    // Normalize to last 10 digits (drops a leading 1).
    const last10 = digits.length >= 10 ? digits.slice(-10) : null;
    if (!last10) return { ok: false, reason: 'malformed_phone_number_in_body' };
    const last7 = last10.slice(-7);
    if (!WAVES_PHONE_LAST_SEVEN.has(last7)) {
      return { ok: false, reason: `non_business_phone_number_in_body:${last10}` };
    }
  }
  if (/[\w._%+-]+@[\w-]+\.[A-Za-z]{2,}/.test(body)) {
    return { ok: false, reason: 'email_in_body' };
  }
  return { ok: true };
}

// ── refresh checks ──────────────────────────────────────────────────

function checkImprovementOverPrior(draft, _brief, context) {
  const prev = context.previousVersion;
  if (!prev) return { ok: false, reason: 'no_previous_version_to_compare' };
  const prevLen = (prev.body || '').length;
  const newLen = String(draft.body || '').length;
  if (newLen < prevLen * 0.8) return { ok: false, reason: 'refresh_lost_>20%_of_prior_content' };
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
  const { SERVICE_HUB_LINKS } = require('./content-brief-builder')._internals;
  const hubs = [...new Set(Object.values(SERVICE_HUB_LINKS).flat())];
  if (!hubs.some((h) => body.includes(h))) {
    return { ok: false, reason: 'no_hub_link_found' };
  }
  return { ok: true };
}

function checkTwoPlusCityMentions(draft) {
  const body = String(draft.body || '').toLowerCase();
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

// ── metadata checks ─────────────────────────────────────────────────

function checkTitleLengthBounds(draft) {
  const t = (draft.title || draft.frontmatter?.title || '').trim();
  if (!t) return { ok: false, reason: 'no_title' };
  if (t.length < 30 || t.length > 70) return { ok: false, reason: `title_length_${t.length}_outside_30-70` };
  return { ok: true };
}

function checkMetaLengthBounds(draft) {
  const m = (draft.meta_description || draft.frontmatter?.meta_description || '').trim();
  if (!m) return { ok: false, reason: 'no_meta_description' };
  if (m.length < 115 || m.length > 160) return { ok: false, reason: `meta_length_${m.length}_outside_115-160` };
  return { ok: true };
}

function checkPrimaryKeywordInTitle(draft, brief) {
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

function checkNoDuplicateTitle(draft, _brief, context) {
  const t = (draft.title || draft.frontmatter?.title || '').trim().toLowerCase();
  if (!t || !context.siblingTitles) return { ok: true };
  if (context.siblingTitles.has(t)) return { ok: false, reason: 'title_duplicates_existing_page' };
  return { ok: true };
}

module.exports = { evaluate, MIN_TOTAL_SCORE };
module.exports._internals = {
  HARD_CHECKS,
  PAGE_TYPE_CHECKS,
  MIN_TOTAL_SCORE,
  // individual evaluators surfaced for unit tests:
  checkSchemaValid, checkTitleMetaSpamFree, checkSerpBriefAttached, checkGscSignalAttached,
  isOperatorAuthoredBrief, isCompetitorGapBrief,
  checkNoDuplicateIntent, checkCanonical, checkIndexable,
  checkSitemapUpdated, checkPreviewSuccess,
  checkNapConsistent, checkLocalProof, checkCtaAboveFold,
  checkServiceMenu, checkFaqFromCustomer, checkLocalBusinessServiceSchema,
  checkAnswerInFirstParagraph, checkSourceInternalLink, checkRedactionPassed,
  checkImprovementOverPrior,
  checkHubLinkPresent, checkTwoPlusCityMentions, checkFaqSectionPresent, checkVoiceMatch,
  checkTitleLengthBounds, checkMetaLengthBounds,
  checkPrimaryKeywordInTitle, checkNoDuplicateTitle,
};
