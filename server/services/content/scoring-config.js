/**
 * scoring-config.js — single source of truth for opportunity scoring.
 *
 * Step 0 calibration reads these; the production miners (gsc-opportunity-miner,
 * serp-profiler, decision-router, content-quality-gate) read these too. Tuning
 * happens here, not scattered through service files.
 *
 * Edit after reading reports/calibration-*.md.
 */

const WEIGHTS = {
  // Positive signals — sum to ~175 max if every box is checked.
  gscOpportunity: 35,
  serpFit: 25,
  customerDemand: 25,
  localRevenue: 20,
  seasonality: 15,
  contentGap: 15,
  conversionIntent: 15,
  refreshLift: 15,
  // Answer-engine (LLM) visibility gap. Sized like gscOpportunity so an
  // aeo_gap only clears minScoreToAct (75) when the gap is strong — persistent
  // absence on a GSC-demanded city×service where competitors are being cited.
  // Scaled by gap_strength (0.5–1.0) in scoreOpportunity, so weak/no-competitor
  // gaps stay below the floor.
  aeoGap: 35,
  leadQuality: 20,
  closeRate: 15,
  revenueRealization: 20,

  // Facts-readiness boost. Applied ONLY to rewrite opportunities whose
  // city×service is verified-sufficient in the facts bank (see
  // gsc-opportunity-miner). Sized so a genuinely-decent candidate (~62-65)
  // plus verified facts clears minScoreToAct (75 → 76-79), while a weak
  // candidate (~40) stays out even with facts (~54). Self-limiting: keeps the
  // 75 floor intact and only lets well-supported, already-promising pages act.
  factsReady: 14,

  // Penalties — subtracted.
  cannibalizationRisk: 35,
  serpMismatch: 40,
  redundancy: 25,
  privacyRisk: 25,
  weakLocalProof: 20,
};

const THRESHOLDS = {
  // Minimum total score to enter the action queue at all.
  minScoreToAct: 75,

  // Per-action floor for new_supporting_blog. New-content demand signals
  // (seasonal_rising, no_content_yet, aeo_gap with no page) score
  // structurally lower than refresh/rewrite signals — there's no existing
  // page contributing position/CTR/decay weight — so holding blogs to the
  // global 75 floor starves the lane entirely (observed: zero opportunities
  // persisted 2026-06-02 → 2026-06-11 while real 44-49-point blog gaps sat
  // under the cut). Env-tunable via AUTONOMOUS_BLOG_MIN_SCORE; clamped to
  // [20, minScoreToAct] in minScoreToActFor().
  blogMinScoreToAct: 45,

  // GSC bucket cutoffs.
  minImpressionsToScore: 50,
  strikingDistancePositionMin: 4,
  strikingDistancePositionMax: 15,
  ctrRewriteMaxCtr: 0.02,
  ctrRewritePositionMax: 8,
  ctrRewriteMinImpressions: 200,
  decayMinDropPct: 0.25,
  cannibalizationMinUrls: 2,

  // Recency / dedupe.
  recencyBlocklistDays: 60,

  // Uniqueness gate (anti-doorway).
  uniquenessJaccardMax: 0.55,
  uniqueLocalDifferentiatorsMin: 3,

  // Customer cluster.
  customerClusterMinSize: 10,
  customerClusterRecencyDays: 90,

  // Trust-build.
  autoPublishAfterApprovedRuns: 3,
};

const REVENUE_PRIORITY = {
  // Higher = more revenue-weighted. Used by localRevenueScore.
  termite: 1.0,
  rodent: 0.9,
  mosquito: 0.8,
  pest: 0.75,
  lawn: 0.6,
  'tree-shrub': 0.5,
  specialty: 0.4,
};

const CITIES = [
  'Bradenton',
  'Lakewood Ranch',
  'Sarasota',
  'Venice',
  'Parrish',
  'North Port',
  'Palmetto',
  'Port Charlotte',
];

const SERP_SAMPLE_CITIES = ['Bradenton', 'Lakewood Ranch', 'Sarasota', 'Venice', 'Parrish'];

const ACTION_TYPES = [
  'refresh_existing_page',
  'create_or_refresh_city_service_page',
  'create_customer_question_page',
  'rewrite_title_meta',
  'add_internal_links',
  'gbp_post',
  'new_supporting_blog',
  'do_not_publish',
];

const WEEKLY_MIX = {
  refresh_existing_page: 2,
  create_or_refresh_city_service_page: 1,
  create_customer_question_page: 1,
  rewrite_title_meta_or_link_or_gbp: 1,
};

/**
 * Action-aware minimum score: new_supporting_blog uses the lower blog floor
 * (env AUTONOMOUS_BLOG_MIN_SCORE, default THRESHOLDS.blogMinScoreToAct),
 * everything else keeps the global minScoreToAct. The env value is read at
 * call time and clamped to [20, minScoreToAct] so a typo can neither open
 * the queue to junk nor silently raise the blog floor above the global one.
 */
function minScoreToActFor(actionType) {
  if (String(actionType || '') !== 'new_supporting_blog') return THRESHOLDS.minScoreToAct;
  const raw = Number.parseInt(process.env.AUTONOMOUS_BLOG_MIN_SCORE, 10);
  const floor = Number.isFinite(raw) ? raw : THRESHOLDS.blogMinScoreToAct;
  return Math.min(Math.max(floor, 20), THRESHOLDS.minScoreToAct);
}

module.exports = {
  WEIGHTS,
  THRESHOLDS,
  minScoreToActFor,
  REVENUE_PRIORITY,
  CITIES,
  SERP_SAMPLE_CITIES,
  ACTION_TYPES,
  WEEKLY_MIX,
};
