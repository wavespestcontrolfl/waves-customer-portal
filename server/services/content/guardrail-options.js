/**
 * guardrail-options.js — the SINGLE synchronous derivation of
 * content-guardrails evaluate() options from an opportunity + composed
 * brief.
 *
 * Consumed by:
 *   - autonomous-runner._deriveGuardrailOptions (gate 3c + the
 *     named-competitor approval re-check), which layers the ASYNC refresh
 *     hydration (live domains/meta/prior body) on top, and
 *   - the writer's in-loop self-lint (brief-driven-tools emit_draft), which
 *     uses the sync options as-is.
 *
 * One derivation, two call sites — the self-lint can never disagree with
 * the gate that authoritatively parks a run (the #3258 review loop
 * demonstrated ten times over what duplicate classifiers cost).
 * Dependency-free on purpose: requirable from the agent-tools module
 * without the runner's graph.
 */

const OPERATOR_INTERCEPT_BUCKET = 'operator_intercept';

const BRIEF_PRICE_PROHIBITION_RE = /\bno\s+(?:[\w-]+\s+){0,3}(?:dollar amounts?|prices|pricing)\b/i;

function briefForbidsCompetitorPrices(...sources) {
  let forbids = false;
  const walk = (v) => {
    if (forbids) return;
    if (typeof v === 'string') { if (BRIEF_PRICE_PROHIBITION_RE.test(v)) forbids = true; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  try { sources.forEach(walk); } catch { return true; }
  return forbids;
}

function deriveSyncGuardrailOptions(opp = {}, brief = {}) {
  // Operator provenance is the OPERATOR BRIEF itself (it only exists for
  // operator_intercept rows).
  const operatorBrief = opp?.bucket === OPERATOR_INTERCEPT_BUCKET
    ? (brief?.voice_constraints?.operator_brief || null)
    : null;
  // Narrow operator-FAQ exception (owner directive 2026-06-11: FAQPage on
  // every intercept post) — manifest-derived, never from generated content.
  const operatorFaqException = operatorBrief?.faq_required === true;
  const spokeDomains = Array.isArray(brief.target_sites) ? brief.target_sites.filter(Boolean) : [];
  // A spoke seed keeps the coarse 'pest' service for the link gates but
  // tags a FAQ-blocked pest topic on operator_brief.faq_blocked_topic —
  // fold it in so a writer-added FAQ on a blocked topic still P0s.
  // Deliberately NOT bucket-gated (unlike the exceptions above): this
  // TIGHTENS the guard, and spoke seeds carry it outside the intercept
  // bucket.
  const faqBlockedTopic = brief?.voice_constraints?.operator_brief?.faq_blocked_topic || null;
  const baseService = opp?.service || brief.service || null;
  // Brief-mandated internal links are binding writer instructions (the
  // prompt calls internal_links_to_add a checklist), so they are allowed on
  // top of the guardrails' static internal-route allowlist — same posture
  // as requiredSourceUrls on the external-link gate. The curated operator
  // hub_link (a city page outside the static set) is part of that contract.
  let briefLinks = brief?.internal_links_to_add;
  if (typeof briefLinks === 'string') { try { briefLinks = JSON.parse(briefLinks); } catch (_) { briefLinks = []; } }
  // hub_link is read un-bucket-gated (like faqBlockedTopic above): spoke
  // seeds carry it outside the intercept bucket and the quality gate's
  // hub_link_present check REQUIRES the draft to contain it.
  const curatedHubLink = brief?.voice_constraints?.operator_brief?.hub_link || null;
  const allowedInternalLinks = [
    ...(Array.isArray(briefLinks) ? briefLinks : []),
    ...(curatedHubLink ? [curatedHubLink] : []),
  ];
  const isRefresh = brief.action_type === 'refresh_existing_page';
  return {
    service: faqBlockedTopic ? [baseService, faqBlockedTopic].filter(Boolean) : baseService,
    primaryKeyword: brief.target_keyword || null,
    domains: spokeDomains.length ? spokeDomains : null,
    operatorFaqException,
    // The brief's NAMED sources are the citation allowance now that the
    // broad .gov/.edu TLD rule is gone (owner ruling 2026-08-01, third).
    // Both shapes count: `required_sources` (must-link instructions) and
    // the manifest's own `sources` list. Non-URL entries — the briefs
    // carry prose instructions in there too — are skipped downstream.
    requiredSourceUrls: [
      ...(Array.isArray(operatorBrief?.required_sources) ? operatorBrief.required_sources : []),
      ...(Array.isArray(operatorBrief?.sources) ? operatorBrief.sources : []),
      ...(Array.isArray(opp?.signal_metadata?.intercept_brief?.sources) ? opp.signal_metadata.intercept_brief.sources : []),
    ],
    operatorCitations: Boolean(operatorBrief),
    // Competitor-price citations are STRICTER: category/spoke seeds share
    // the operator_intercept bucket (and get citation hosts above) but
    // auto-publish informational posts — only a true competitor-intercept
    // brief (signal_metadata.intercept_brief) may cite competitor prices
    // (Codex P0, 2026-08-01) …and the brief must not FORBID them (B2/B4
    // carry "GATE RULE … NO TruGreen dollar amounts anywhere in the post").
    // Fail closed: an unreadable brief keeps the full guard.
    competitorPriceCitations: Boolean(opp?.signal_metadata?.intercept_brief)
      && !briefForbidsCompetitorPrices(opp?.signal_metadata?.intercept_brief, operatorBrief),
    // A ban is stronger than "no permission": it must also outrank the
    // generic calculator/quote/"pricing varies" framing exemption, which
    // the seeder's own writer instruction steers drafts straight into
    // (Codex).
    forbidAllPrices: briefForbidsCompetitorPrices(opp?.signal_metadata?.intercept_brief, operatorBrief),
    allowedInternalLinks,
    isRefresh,
  };
}

module.exports = { OPERATOR_INTERCEPT_BUCKET, briefForbidsCompetitorPrices, deriveSyncGuardrailOptions };
