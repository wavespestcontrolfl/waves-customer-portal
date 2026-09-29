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
const { resolveSpokeTarget } = require('../content-astro/spoke-routing');
const { HUB_SITE_KEYS, normalizeSpokeSites } = require('../content-astro/spoke-sites');

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
  // Same rationale for family rows: specialty→pest canonicalization hides
  // the specific blocked topic in gsc_signal (Codex r25 on #3258; DROPPED
  // in the extraction and restored by the PR r11 audit — without it a
  // bed-bug family draft passes FAQ_BLOCKED_SERVICE as coarse 'pest').
  const specialtyTopic = brief?.gsc_signal?.specialty_topic || null;
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
  // Related-post links (related-posts.js, supporting-blog only) — an OPTIONAL
  // allowance, not a checklist like internal_links_to_add: the writer may
  // link some of these, never all are required. Threaded from
  // voice_constraints.related_posts (no dedicated content_briefs column; see
  // content-brief-builder._composeBrief) so the gate accepts exactly the
  // paths the brief actually proposed — never a guessed blog-post slug.
  let relatedPostLinks = brief?.voice_constraints?.related_posts;
  if (typeof relatedPostLinks === 'string') { try { relatedPostLinks = JSON.parse(relatedPostLinks); } catch (_) { relatedPostLinks = []; } }
  const relatedPostPaths = (Array.isArray(relatedPostLinks) ? relatedPostLinks : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .filter(Boolean);
  const allowedInternalLinks = [
    ...(Array.isArray(briefLinks) ? briefLinks : []),
    ...(curatedHubLink ? [curatedHubLink] : []),
  ];
  const selectedRelatedHosts = brief?.voice_constraints?.related_posts_target_sites;
  const effectiveSpoke = resolveSpokeTarget(brief);
  const effectiveRelatedHosts = normalizeSpokeSites(effectiveSpoke ? [effectiveSpoke] : HUB_SITE_KEYS).sort();
  const frozenRelatedHosts = normalizeSpokeSites(selectedRelatedHosts).sort();
  const relatedTargetMatches = selectedRelatedHosts != null
    && frozenRelatedHosts.length === effectiveRelatedHosts.length
    && frozenRelatedHosts.every((host, index) => host === effectiveRelatedHosts[index]);
  const isRefresh = brief.action_type === 'refresh_existing_page';
  // A supporting-blog run IS a blog target: the affiliate gate builds its
  // product index only for blog targets, so without this every valid
  // <AffiliateLink> parked as UNREGISTERED and the affiliate_review park
  // was unreachable (Codex #3646 r41). The refresh lane overrides it from
  // the live page's source path.
  const targetIsBlog = brief.action_type === 'new_supporting_blog' || brief.page_type === 'supporting-blog';
  // An affiliate pilot brief binds the ONLY products the draft may link
  // (operator_brief.affiliate_products, verbatim from the seed manifest);
  // the affiliate gate enforces product + placement + anchor against it.
  const briefProducts = brief?.voice_constraints?.operator_brief?.affiliate_products;
  const allowedAffiliateProducts = Array.isArray(briefProducts) && briefProducts.length ? briefProducts : null;
  return {
    targetIsBlog,
    allowedAffiliateProducts,
    service: (faqBlockedTopic || specialtyTopic)
      ? [baseService, faqBlockedTopic, specialtyTopic].filter(Boolean)
      : baseService,
    primaryKeyword: brief.target_keyword || null,
    domains: spokeDomains.length ? spokeDomains : null,
    operatorFaqException,
    // Exact brief sources extend the shared government/trusted-source
    // baseline without granting every URL on the same host.
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
    // The network kill switch is evaluated again at publication time. If it
    // changes a frozen spoke brief into a hub publish (or vice versa), the
    // frozen paths stay bound to their FROZEN host set (never the drifted
    // effective one) and relatedPostLinksLive tells internalRouteFinding to
    // quarantine every reference to them — relative or absolute — as denied,
    // rather than dropping their identity: emptying relatedPostLinks let a
    // wrong-host link past the host check entirely if check_existing_content
    // separately re-admitted the same path into the generic allowlist
    // (Codex #4984 r6+ P1).
    relatedPostLinks: relatedPostPaths,
    relatedPostHosts: frozenRelatedHosts,
    relatedPostLinksLive: relatedTargetMatches,
    // The post's resolved publish host(s) — what an ABSOLUTE frontmatter
    // next_steps href must name (content-guardrails nextStepsFrontmatter
    // Finding): the effective spoke, else the hub. Never the whole fleet.
    publishHosts: effectiveRelatedHosts,
    isRefresh,
  };
}

// The operator-authored text of an intercept brief (title/keywords/thesis/
// outline/sourcing), for the comparison gate's operator-authorized-
// competitor exception: a recognized competitor the OPERATOR named there
// (e.g. a detection-only brand an intercept brief names) routes the draft to the approvable
// named-competitor review path instead of a hard UNKNOWN_COMPETITOR block.
// Only operator_intercept opportunities produce text — mined briefs get '',
// so nothing changes for them. Every gate call site (runNext, the approval
// re-check, remediation, and the publisher's owner-list chokepoint) MUST
// derive this identically, or a draft parked as approvable would fail its
// own re-evaluation.
function operatorBriefTextForComparisonGate(opp, brief) {
  if (!opp || opp.bucket !== OPERATOR_INTERCEPT_BUCKET) return '';
  const ob = brief?.voice_constraints?.operator_brief || null;
  if (!ob) return '';
  return [
    ob.working_title,
    ob.primary_kw,
    ob.thesis,
    ...(Array.isArray(ob.secondary_kws) ? ob.secondary_kws : []),
    ...(Array.isArray(ob.outline) ? ob.outline : []),
    // Sourcing fields are operator-authored too: a REQUIRED competitor
    // citation (required_sources URL like https://www.orkin.com/...) or a
    // source note naming the competitor authorizes that name exactly like
    // the title/outline do. Without these, the binding citation URL itself
    // read as an unauthorized mention in the draft and hard-blocked the
    // run at comparison_table_failed instead of the review path the
    // operator's own brief was steering it to.
    ...(Array.isArray(ob.required_sources) ? ob.required_sources : []),
    ...(Array.isArray(ob.source_notes) ? ob.source_notes : []),
  ].filter(Boolean).join('\n');
}

module.exports = { OPERATOR_INTERCEPT_BUCKET, briefForbidsCompetitorPrices, deriveSyncGuardrailOptions, operatorBriefTextForComparisonGate };
