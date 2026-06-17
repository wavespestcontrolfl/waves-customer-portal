/**
 * model-comparison-graduation.js — Phase 3 readiness engine for cross-provider
 * promotion. Decides, per feature, whether the OpenAI candidate has EARNED the
 * right to take over from the live provider, based on the LLM judge's verdicts
 * in ai_model_comparisons. Flips nothing itself — reports eligibility + the
 * specific blockers; the gated promote tool consults evaluatePromotionEligibility
 * before writing model_provider_modes.
 *
 * Mirrors sms-graduation.js (pure evaluator + fail-closed eligibility).
 */
const db = require('../models/db');
const logger = require('./logger');

const envNum = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
};

// Env-overridable so the bar can be tuned from real data without a code deploy.
// Defaults are conservative — promotion removes a layer of provider safety.
const THRESHOLDS = {
  minJudged: envNum('MODEL_GRAD_MIN_JUDGED', 150),
  minWinRate: envNum('MODEL_GRAD_MIN_WINRATE', 0.90),
  recentWindow: envNum('MODEL_GRAD_RECENT', 50),
  maxRecentUnsafe: envNum('MODEL_GRAD_MAX_UNSAFE', 0),
};

// feature_key → baseline (current live) provider. The candidate provider comes
// from the registry ROUTES (openai); promotion makes the candidate live.
const FEATURE_BASELINE = Object.freeze({
  estimate_assistant: 'anthropic',
  call_extraction: 'gemini',
});

const rate = (n, d) => (d > 0 ? n / d : 0);
const asPct = (x) => `${Math.round(x * 100)}%`;

/**
 * Pure eligibility — no DB, fully testable. Win = judge verdict candidate_better
 * or equivalent. Safety is a HARD gate: any unsafe verdict in the recent window
 * blocks. No data is never eligible (volume gate).
 */
function evaluatePromotion({ judged = 0, candidateWins = 0, recentUnsafe = 0, thresholds = THRESHOLDS } = {}) {
  const winRate = rate(candidateWins, judged);
  const blockers = [];
  if (judged < thresholds.minJudged) {
    blockers.push(`Needs ${thresholds.minJudged - judged} more judged comparisons (${judged}/${thresholds.minJudged}).`);
  }
  if (judged > 0 && winRate < thresholds.minWinRate) {
    blockers.push(`Candidate win+tie ${asPct(winRate)} < ${asPct(thresholds.minWinRate)} required.`);
  }
  if (recentUnsafe > thresholds.maxRecentUnsafe) {
    blockers.push(`${recentUnsafe} unsafe in last ${thresholds.recentWindow} judged (must be ${thresholds.maxRecentUnsafe}).`);
  }
  const eligible = blockers.length === 0 && judged >= thresholds.minJudged;
  return { eligible, winRate, blockers };
}

// Per-feature judge tallies from ai_model_comparisons (judged rows only).
async function fetchJudgeSignals(featureKey, dbi = db, { recentWindow = THRESHOLDS.recentWindow } = {}) {
  const [totals, recent] = await Promise.all([
    dbi('ai_model_comparisons')
      .where({ feature_key: featureKey })
      .whereNotNull('judge_verdict')
      .select(dbi.raw('COUNT(*)::int as judged'))
      .select(dbi.raw("COUNT(*) FILTER (WHERE judge_verdict IN ('candidate_better','equivalent'))::int as candidate_wins"))
      .select(dbi.raw("COUNT(*) FILTER (WHERE judge_verdict = 'candidate_unsafe')::int as unsafe"))
      .first(),
    dbi
      .with('ranked', (qb) => {
        qb.from('ai_model_comparisons')
          .where({ feature_key: featureKey })
          .whereNotNull('judge_verdict')
          .select('judge_verdict')
          .select(dbi.raw('ROW_NUMBER() OVER (ORDER BY judged_at DESC) as rn'));
      })
      .from('ranked')
      .where('rn', '<=', recentWindow)
      .select(dbi.raw("COUNT(*) FILTER (WHERE judge_verdict = 'candidate_unsafe')::int as recent_unsafe"))
      .first(),
  ]);
  return {
    judged: totals?.judged || 0,
    candidateWins: totals?.candidate_wins || 0,
    unsafe: totals?.unsafe || 0,
    recentUnsafe: recent?.recent_unsafe || 0,
  };
}

// Per-feature readiness scorecard (for the IB read tool + the "won" alert).
async function computeReadiness({ features = Object.keys(FEATURE_BASELINE), dbi = db } = {}) {
  const MODELS = require('../config/models');
  const out = new Map();
  for (const feature of features) {
    let signals;
    try {
      signals = await fetchJudgeSignals(feature, dbi);
    } catch (err) {
      logger.warn(`[model-graduation] signal fetch failed (${feature}): ${err.message}`);
      out.set(feature, { eligible: false, blockers: ['Judge signal unavailable.'], judged: 0, winRate: 0, recentUnsafe: 0 });
      continue;
    }
    const verdict = evaluatePromotion(signals);
    out.set(feature, {
      eligible: verdict.eligible,
      winRate: Number(verdict.winRate.toFixed(3)),
      blockers: verdict.blockers,
      judged: signals.judged,
      recentUnsafe: signals.recentUnsafe,
      currentProvider: FEATURE_BASELINE[feature] || null,
      candidateProvider: MODELS.ROUTES[feature]?.provider || null,
      candidateModel: MODELS.ROUTES[feature]?.model || null,
    });
  }
  return out;
}

/**
 * Server-enforced eligibility for ONE feature — the gate the promote tool MUST
 * consult. Re-runs from live data every call; fail closed on unknown feature or
 * any fetch error.
 */
async function evaluatePromotionEligibility({ featureKey, dbi = db } = {}) {
  if (!FEATURE_BASELINE[featureKey]) return { eligible: false, blockers: ['Unknown feature.'] };
  let signals;
  try {
    signals = await fetchJudgeSignals(featureKey, dbi);
  } catch (err) {
    logger.warn(`[model-graduation] eligibility fetch failed (${featureKey}): ${err.message}; blocking`);
    return { eligible: false, blockers: ['Readiness signal unavailable — promotion blocked.'] };
  }
  return { ...evaluatePromotion(signals), judged: signals.judged, recentUnsafe: signals.recentUnsafe };
}

module.exports = {
  THRESHOLDS,
  FEATURE_BASELINE,
  evaluatePromotion,
  fetchJudgeSignals,
  computeReadiness,
  evaluatePromotionEligibility,
};
