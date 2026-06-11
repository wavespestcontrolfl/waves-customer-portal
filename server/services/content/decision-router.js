/**
 * decision-router.js — pure function that picks the final action for
 * an opportunity once SERP profile + customer signal + conversion
 * feedback are joined to it.
 *
 * Takes the raw opportunity emitted by gsc-opportunity-miner and
 * upgrades / downgrades it based on:
 *   - what the SERP actually wants (intent + dominant page type)
 *   - whether real customer demand exists for the topic (cluster size)
 *   - how this {city, service} pair converts ($/lead, close rate)
 *   - what risks the engine would take on (cannibalization, mismatch,
 *     redundancy, weak local proof)
 *
 * Per v3.1 plan rules:
 *   - SERP intent of 'public-health' / 'navigational' → do_not_publish
 *   - SERP page-type mismatch with proposed action → re-route or block
 *   - Cannibalization / page_type_mismatch buckets → always human review
 *   - First N publishes per action_type → human review (handled
 *     elsewhere by the runner; this module just exposes
 *     human_review_required when other gates flag it)
 *
 * Pure function — no DB, no logger, no I/O. Easily testable.
 */

const { WEIGHTS, THRESHOLDS, REVENUE_PRIORITY, isTransactionalQuery } = require('./scoring-config');

// ── action priorities (which actions are "safer" defaults) ──────────

const ACTION_RISK = {
  rewrite_title_meta: 1,
  add_internal_links: 1,
  gbp_post: 1,
  refresh_existing_page: 2,
  create_customer_question_page: 3,
  new_supporting_blog: 3,
  create_or_refresh_city_service_page: 4,
  do_not_publish: 0,
};

// Page-type expectations the action implies — used to validate the
// proposed action against what the SERP actually rewards.
const ACTION_EXPECTS_PAGE_TYPE = {
  create_or_refresh_city_service_page: 'city-service',
  create_customer_question_page: ['faq', 'blog', 'mixed'],
  new_supporting_blog: ['blog', 'mixed'],
  refresh_existing_page: null,        // matches whatever already exists
  rewrite_title_meta: null,
  add_internal_links: null,
  gbp_post: null,
};

// ── main entry ──────────────────────────────────────────────────────

/**
 * route(opportunity, signals)
 *
 * opportunity: row from opportunity_queue (parsed; signal_metadata is
 *   an object).
 * signals: {
 *   serp_profile?: from serp-profiler — may be null (no profile yet),
 *   customer_signal?: from customer-insights-miner cluster — may be null,
 *   conversion_feedback?: from conversion-feedback-miner — may be null,
 *   existing_brief_versions?: int (for dedupe; opportunity already had a brief?)
 * }
 *
 * Returns {
 *   action_type: string,
 *   page_type: string,
 *   final_score: int,
 *   score_breakdown: { ...positive adds, ...negative penalties, base },
 *   human_review_required: bool,
 *   human_review_reason: string | null,
 *   router_notes: string,
 * }
 */
function route(opportunity, signals = {}) {
  if (!opportunity) throw new Error('decision-router: opportunity required');
  const { serp_profile, customer_signal, conversion_feedback, existing_brief_versions = 0 } = signals;

  const notes = [];
  const breakdown = { base: opportunity.score || 0 };
  let action = opportunity.action_type;
  let humanReview = false;
  let humanReason = null;

  // ── SERP-driven overrides ─────────────────────────────────────────
  if (serp_profile) {
    const intent = serp_profile.dominant_intent;
    const dominantPage = serp_profile.dominant_page_type;
    const recommended = serp_profile.recommended_asset_type;

    if (intent === 'public-health') {
      action = 'do_not_publish';
      humanReview = true;
      humanReason = 'SERP dominated by public-health resources; Waves cannot displace .gov';
      breakdown.serpMismatch = -WEIGHTS.serpMismatch;
      notes.push('blocked: public-health SERP');
    } else if (intent === 'navigational') {
      action = 'do_not_publish';
      humanReview = true;
      humanReason = 'navigational intent (brand match) — no content opportunity';
      notes.push('blocked: navigational intent');
    } else if (recommended === 'do_not_publish') {
      action = 'do_not_publish';
      humanReview = true;
      humanReason = 'SERP profiler explicit do_not_publish';
      notes.push('blocked: profiler do_not_publish');
    } else {
      // If profiler's recommended action differs from miner's, defer
      // to the profiler — it has the live SERP data.
      if (recommended && recommended !== action && action !== 'rewrite_title_meta') {
        notes.push(`router upgraded action: ${action} → ${recommended} (per SERP profile)`);
        action = recommended;
      }

      // Mismatch penalty: action expects a page type the SERP isn't
      // showing.
      const expected = ACTION_EXPECTS_PAGE_TYPE[action];
      if (expected) {
        const acceptable = Array.isArray(expected) ? expected : [expected];
        if (dominantPage && !acceptable.includes(dominantPage)) {
          breakdown.serpMismatch = -Math.round(WEIGHTS.serpMismatch * 0.5);
          notes.push(`partial mismatch: action expects ${acceptable.join('/')}, SERP shows ${dominantPage}`);
        }
      }

      // Directory-saturated SERP — branded landing page has uplift.
      if (serp_profile.directory_saturation >= 0.5) {
        breakdown.serpFit = WEIGHTS.serpFit;
        notes.push('serp_fit bonus: directory-saturated SERP');
      }

      // AI Overview present — informational answers may pull traffic
      // away even if we rank. Slight penalty for informational actions.
      if (serp_profile.ai_overview_present && (action === 'new_supporting_blog' || action === 'create_customer_question_page')) {
        breakdown.serpMismatch = (breakdown.serpMismatch || 0) - Math.round(WEIGHTS.serpMismatch * 0.2);
        notes.push('ai_overview present — informational uplift reduced');
      }
    }
  } else {
    notes.push('no SERP profile available — using miner action as-is');
  }

  // ── customer-demand uplift ────────────────────────────────────────
  if (customer_signal && action !== 'do_not_publish') {
    const total = customer_signal.total_count || 0;
    if (total >= THRESHOLDS.customerClusterMinSize) {
      breakdown.customerDemand = WEIGHTS.customerDemand;
      notes.push(`customer_demand bonus: ${total} clustered mentions`);
      // If we have strong customer demand and no city-service page
      // route yet, prefer customer_question_page.
      if (action === 'new_supporting_blog' && customer_signal.funnel_stage === 'pre-sale') {
        notes.push('routed to customer_question_page: pre-sale FAQ demand');
        action = 'create_customer_question_page';
      }
    } else if (total > 0) {
      breakdown.customerDemand = Math.round(WEIGHTS.customerDemand * (total / THRESHOLDS.customerClusterMinSize));
      notes.push(`customer_demand partial: ${total}/${THRESHOLDS.customerClusterMinSize} threshold`);
    }
  }

  // ── conversion-driven scoring ─────────────────────────────────────
  if (conversion_feedback && action !== 'do_not_publish') {
    if (conversion_feedback.lead_quality_score) {
      breakdown.leadQuality = conversion_feedback.lead_quality_score;
    }
    if (conversion_feedback.close_rate_score) {
      breakdown.closeRate = conversion_feedback.close_rate_score;
    }
    if (conversion_feedback.revenue_realization_score) {
      breakdown.revenueRealization = conversion_feedback.revenue_realization_score;
    }
  }

  // ── redundancy: this opportunity already has a brief ─────────────
  if (existing_brief_versions > 0 && action !== 'do_not_publish') {
    breakdown.redundancy = -Math.round(WEIGHTS.redundancy * Math.min(1, existing_brief_versions / 3));
    notes.push(`redundancy penalty: ${existing_brief_versions} prior brief version(s)`);
    if (existing_brief_versions >= 3) {
      humanReview = true;
      humanReason = humanReason || `${existing_brief_versions} prior brief versions — likely loop`;
    }
  }

  // ── bucket-specific always-human-review rules ─────────────────────
  if (opportunity.bucket === 'cannibalization' || opportunity.bucket === 'page_type_mismatch') {
    humanReview = true;
    humanReason = humanReason || `${opportunity.bucket} bucket requires human triage`;
  }

  // ── terminal near-me guard (operator directive 2026-06-11) ────────
  // Runs LAST so no upstream branch can reverse it: the SERP-profile
  // upgrade above defers to live SERPs, and "exterminator near me" SERPs
  // profile as mixed/blog-dominant — which would resurrect the blog action
  // the miner already demoted. Transactional queries are service-page
  // intent, never blog material; park for human review instead.
  if (action === 'new_supporting_blog' && isTransactionalQuery(opportunity.query)) {
    action = 'do_not_publish';
    humanReview = true;
    humanReason = 'transactional/near-me query — never blog material (operator directive)';
    notes.push('blocked: transactional query routed away from blog lane');
  }

  // ── final score + page_type ───────────────────────────────────────
  const finalScore = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const pageType = derivePageType(action, serp_profile);

  return {
    action_type: action,
    page_type: pageType,
    final_score: finalScore,
    score_breakdown: breakdown,
    human_review_required: humanReview,
    human_review_reason: humanReason,
    router_notes: notes.join(' | '),
  };
}

// SERP page-type → brief template key. SERP profiler emits values
// like 'blog' / 'faq' / 'service' / 'city-service' / 'directory' /
// 'home' / 'page'. brief templates are keyed as 'city-service',
// 'customer-question', 'supporting-blog', 'refresh', 'metadata'. The
// raw values must be normalized or _composeBrief falls back to empty
// required_sections / schema_types and the refresh draft loses its
// structural guidance.
const REFRESH_PAGE_TYPE_BY_SERP = {
  blog: 'supporting-blog',
  faq: 'customer-question',
  'city-service': 'city-service',
  service: 'city-service', // closest brief template for a service page
  // directory / home / page / unknown → keep the generic 'refresh' template
};

function derivePageType(action, serp_profile) {
  if (action === 'create_or_refresh_city_service_page') return 'city-service';
  if (action === 'create_customer_question_page') return 'customer-question';
  if (action === 'new_supporting_blog') return 'supporting-blog';
  if (action === 'refresh_existing_page') {
    const raw = serp_profile?.dominant_page_type;
    return REFRESH_PAGE_TYPE_BY_SERP[raw] || 'refresh';
  }
  if (action === 'rewrite_title_meta') return 'metadata';
  if (action === 'add_internal_links') return 'links';
  if (action === 'gbp_post') return 'gbp';
  return 'none';
}

module.exports = { route, derivePageType };
module.exports._internals = {
  ACTION_RISK,
  ACTION_EXPECTS_PAGE_TYPE,
};
