/**
 * GrowthBook server-side experiment assignment (experimentation initiative, Phase 0/1).
 *
 * GrowthBook is warehouse-native — it does NOT store events. This module only
 * (a) evaluates feature-flag experiments locally (a deterministic hash, no
 * network in the request path) and (b) writes one exposure row per participant
 * to `experiment_exposures`. GrowthBook later computes lift by querying that
 * table joined to the existing conversion tables. See
 * docs/experimentation/growthbook-setup.md.
 *
 * Safety contract (this touches the customer-facing estimate page):
 *  - Master-gated by GATE_GROWTHBOOK (feature-gates: growthbookExperiments).
 *    Off  → nothing here runs and callers keep their pre-experiment behavior.
 *  - Fails OPEN: no client key, unreachable/empty feature payload, unknown
 *    feature, not-in-experiment, or ANY error → a safe control default. Never
 *    throws into the request path.
 *  - Zero added request latency: feature definitions are fetched in the
 *    BACKGROUND and cached; evaluation runs against the cached payload (stale is
 *    fine; a cold/empty cache simply yields control).
 *
 * Runtime config (Railway env):
 *  - GROWTHBOOK_CLIENT_KEY  an SDK Connection Client Key (sdk-…). NOT the
 *                           secret_admin_… management key, and NOT for the
 *                           browser here — this is server-side eval. Use an
 *                           UNENCRYPTED SDK Connection so /api/features returns
 *                           plaintext definitions.
 *  - GROWTHBOOK_API_HOST    default https://cdn.growthbook.io (GrowthBook Cloud).
 */

const { GrowthBook } = require('@growthbook/growthbook');
const db = require('../../models/db');
const logger = require('../logger');
const featureGates = require('../../config/feature-gates');

const API_HOST = (process.env.GROWTHBOOK_API_HOST || 'https://cdn.growthbook.io').replace(/\/+$/, '');
const CLIENT_KEY = process.env.GROWTHBOOK_CLIENT_KEY || '';
const FEATURES_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

// Estimate-view holdback (Phase 1). The GrowthBook feature is a BOOLEAN:
// true  = React v2 "glass" renderer, false = legacy server-HTML v1.
const ESTIMATE_VIEW_EXPERIMENT = 'estimate-view';
const ESTIMATE_VIEW_FEATURE = 'estimate-view-v2';

let cachedFeatures = null;
let cachedAt = 0;
let refreshing = null;

function experimentsEnabled() {
  return featureGates.isEnabled('growthbookExperiments') && CLIENT_KEY.length > 0;
}

async function fetchFeatures() {
  if (typeof fetch !== 'function') return null;
  const url = `${API_HOST}/api/features/${CLIENT_KEY}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body && body.features) return body.features;
    if (body && body.encryptedFeatures) {
      logger.warn('[growthbook] SDK Connection is ENCRYPTED — server-side eval needs an UNENCRYPTED connection; assignment fails open to control');
      return null;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Kick a background refresh when the cache is cold/stale. NEVER awaited from the
// request path — the hot estimate page evaluates against whatever is cached, so
// no network latency is added per request.
function scheduleRefresh() {
  if (refreshing) return;
  refreshing = fetchFeatures()
    .then((f) => { if (f) { cachedFeatures = f; cachedAt = Date.now(); } })
    .catch((e) => { logger.warn(`[growthbook] feature refresh failed: ${e.message}`); })
    .finally(() => { refreshing = null; });
}

function getFeaturesNonBlocking() {
  if (!cachedFeatures || Date.now() - cachedAt >= FEATURES_TTL_MS) scheduleRefresh();
  return cachedFeatures; // may be stale or null; null → caller gets control
}

async function logExposure({ experimentKey, variationId, variationKey, unitId, unitType, metadata }) {
  try {
    await db('experiment_exposures')
      .insert({
        experiment_key: experimentKey,
        variation_id: variationId,
        variation_key: variationKey || null,
        unit_id: String(unitId),
        unit_type: unitType || 'estimate',
        metadata: metadata ? JSON.stringify(metadata) : null,
      })
      // First exposure per (experiment, unit) wins — GrowthBook analysis takes
      // the first assignment; repeat views are no-ops.
      .onConflict(['experiment_key', 'unit_id'])
      .ignore();
  } catch (e) {
    logger.warn(`[growthbook] exposure log failed (${experimentKey}/${unitId}): ${e.message}`);
  }
}

// The persisted exposure row is the source of truth for an already-assigned
// unit. On a cold/failed feature cache we replay it instead of guessing, so we
// never serve a different arm than GrowthBook has recorded.
async function getPriorAssignment(experimentKey, unitId) {
  try {
    return (await db('experiment_exposures')
      .select('variation_id', 'variation_key', 'metadata')
      .where({ experiment_key: experimentKey, unit_id: String(unitId) })
      .first()) || null;
  } catch (e) {
    logger.warn(`[growthbook] prior-assignment lookup failed (${experimentKey}/${unitId}): ${e.message}`);
    return null;
  }
}

/**
 * Assign a unit to a GrowthBook feature-flag experiment. Happy path: a local
 * deterministic hash (no request-path network); the exposure insert is
 * fire-and-forget. Cache miss: replays any persisted assignment rather than
 * guessing. Returns a safe control default on any miss — never throws.
 *
 * @returns {Promise<{ inExperiment: boolean, value: *, variationId: (number|null), variationKey: (string|null) }>}
 */
async function assignExperiment({ experimentKey, featureKey, attributes, unitId, unitType = 'estimate', metadata = null, defaultValue = null }) {
  const control = { inExperiment: false, value: defaultValue, variationId: null, variationKey: null };
  if (!experimentsEnabled()) return control;

  const features = getFeaturesNonBlocking();
  if (!features) {
    // Cache miss (cold start / fetch failure): honor a prior assignment so we
    // never serve a different arm than the one already recorded for this unit.
    // No prior row → stay on the default and log nothing (the unit is simply not
    // in the experiment for this view; it gets assigned once features return).
    const prior = await getPriorAssignment(experimentKey, unitId);
    if (prior && prior.metadata && typeof prior.metadata.value !== 'undefined') {
      return { inExperiment: true, value: prior.metadata.value, variationId: prior.variation_id, variationKey: prior.variation_key };
    }
    return control;
  }

  let exposure = null;
  let gb;
  try {
    gb = new GrowthBook({
      attributes: attributes || {},
      features,
      trackingCallback: (experiment, result) => {
        // Only a genuine experiment assignment (not a forced value or a
        // percentage rollout) counts as an exposure.
        if (result && result.inExperiment) {
          exposure = {
            experimentKey: (experiment && experiment.key) || experimentKey,
            variationId: result.variationId,
            variationKey: result.key,
          };
        }
      },
    });
    const value = gb.getFeatureValue(featureKey, defaultValue);
    if (exposure) {
      // Persist the resolved value alongside the assignment so a later
      // cache-miss view can replay this exact arm (see getPriorAssignment).
      logExposure({ ...exposure, unitId, unitType, metadata: { ...(metadata || {}), value } });
      return { inExperiment: true, value, variationId: exposure.variationId, variationKey: exposure.variationKey };
    }
    return { inExperiment: false, value, variationId: null, variationKey: null };
  } catch (e) {
    logger.warn(`[growthbook] assign failed (${experimentKey}): ${e.message}`);
    return control;
  } finally {
    if (gb && typeof gb.destroy === 'function') gb.destroy();
  }
}

/**
 * Estimate-view v1/v2 holdback (Phase 1). Hashes on the estimate id (default
 * `id` attribute) so a given estimate is consistently assigned across repeat
 * opens. `value===true` → serve React v2; `false` → serve legacy server-HTML.
 * Callers apply the override ONLY when `inExperiment` is true.
 */
async function assignEstimateViewExperiment(estimate) {
  return assignExperiment({
    experimentKey: ESTIMATE_VIEW_EXPERIMENT,
    featureKey: ESTIMATE_VIEW_FEATURE,
    attributes: { id: String(estimate.id), estimateId: estimate.id },
    unitId: estimate.id,
    unitType: 'estimate',
    metadata: { status: estimate.status },
    defaultValue: null,
  });
}

// Best-effort cache warm at boot so the first eligible view can participate
// rather than fail open to control.
if (experimentsEnabled()) scheduleRefresh();

module.exports = {
  assignExperiment,
  assignEstimateViewExperiment,
  logExposure,
  experimentsEnabled,
  ESTIMATE_VIEW_EXPERIMENT,
  ESTIMATE_VIEW_FEATURE,
};
