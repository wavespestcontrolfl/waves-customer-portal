/**
 * live-provider.js — resolves which provider is LIVE for a cross-provider feature.
 *
 * Absence of a model_provider_modes row = the feature's BASELINE provider (i.e.
 * today's behavior). Promotion (gated IB tool) writes a row to make the candidate
 * live. Read is cached (short TTL) and FAIL-SAFE: any DB error returns the baseline,
 * so a DB blip can never silently route customers to an unintended provider.
 */
const db = require('../models/db');
const logger = require('./logger');
const { FEATURE_BASELINE, evaluatePromotionEligibility } = require('./model-comparison-graduation');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // featureKey → { provider, at }

async function getLiveProvider(featureKey) {
  const baseline = FEATURE_BASELINE[featureKey] || null;
  const hit = cache.get(featureKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.provider;
  try {
    const row = await db('model_provider_modes').where({ feature_key: featureKey }).first();
    const provider = row?.live_provider || baseline;
    cache.set(featureKey, { provider, at: Date.now() });
    return provider;
  } catch (err) {
    logger.warn(`[live-provider] read failed (${featureKey}): ${err.message}; using baseline`);
    return baseline; // fail-safe to current behavior
  }
}

/**
 * Promote (or revert) a feature's live provider. Re-checks readiness server-side
 * unless { force } (revert-to-baseline is always allowed). Writes the row + audits.
 */
async function setLiveProvider({ featureKey, provider, actor = null, reason = null, force = false } = {}) {
  if (!FEATURE_BASELINE[featureKey]) {
    return { ok: false, reason: 'unknown_feature' };
  }
  const isRevertToBaseline = provider === FEATURE_BASELINE[featureKey];
  if (!isRevertToBaseline && !force) {
    const elig = await evaluatePromotionEligibility({ featureKey });
    if (!elig.eligible) return { ok: false, reason: 'not_eligible', blockers: elig.blockers || [] };
  }
  await db('model_provider_modes')
    .insert({ feature_key: featureKey, live_provider: provider, promoted_by: actor, reason, updated_at: new Date() })
    .onConflict('feature_key')
    .merge({ live_provider: provider, promoted_by: actor, reason, updated_at: new Date() });
  cache.delete(featureKey);
  try {
    await db('activity_log').insert({
      action: 'model_provider_promoted',
      description: `${featureKey} live provider → ${provider}`,
      metadata: JSON.stringify({ feature_key: featureKey, provider, actor, reason }),
    });
  } catch (err) {
    logger.warn(`[live-provider] audit insert failed: ${err.message}`);
  }
  return { ok: true, featureKey, provider };
}

function _clearCache() { cache.clear(); } // test helper

module.exports = { getLiveProvider, setLiveProvider, _clearCache };
