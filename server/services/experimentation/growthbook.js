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

// Booking-abandon recovery measured rollout (Phase 2). BOOLEAN feature:
// true  = run the recovery touches (SMS + email — today's behavior),
// false = hold this person back from BOTH touches so GrowthBook can measure
//         whether the recovery program actually causes bookings.
const BOOKING_RECOVERY_EXPERIMENT = 'booking-abandon-recovery';
const BOOKING_RECOVERY_FEATURE = 'booking-abandon-recovery';

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

// True once a feature payload is cached. The public /status probe advertises
// this alongside the gate: while the cache is cold (missing server key, first
// fetch failed) the exposure intake can't validate tracking keys and would
// silently drop every client post — so the client SDK must not start either.
function hasFeatureCache() {
  return !!getFeaturesNonBlocking();
}

// unit_id can be PII (booking-recovery units are phone last-10) — warnings go
// to Railway logs, so never print it raw; a 4-char tail is enough to correlate.
function maskUnit(unitId) {
  const s = String(unitId == null ? '' : unitId);
  return s.length <= 4 ? '****' : `…${s.slice(-4)}`;
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
    logger.warn(`[growthbook] exposure log failed (${experimentKey}/${maskUnit(unitId)}): ${e.message}`);
  }
}

// The persisted exposure row is the source of truth for an already-assigned
// unit: first exposure wins (onConflict-ignore). Replaying it BEFORE evaluating
// GrowthBook makes assignment sticky — it survives feature-cache misses AND
// mid-flight rule changes (coverage/weights/variation order), so we never serve
// a different arm than the one recorded for this unit. Keyed on the canonical
// experimentKey — the same key logExposure writes and the analysis query groups
// on — so log, replay, and GrowthBook analysis always agree.
function replayAssignment(prior) {
  if (prior && prior.metadata && typeof prior.metadata.value !== 'undefined') {
    return { inExperiment: true, value: prior.metadata.value, variationId: prior.variation_id, variationKey: prior.variation_key };
  }
  return null;
}

async function getPriorAssignment(experimentKey, unitId) {
  try {
    return (await db('experiment_exposures')
      .select('variation_id', 'variation_key', 'metadata')
      .where({ experiment_key: experimentKey, unit_id: String(unitId) })
      .first()) || null;
  } catch (e) {
    logger.warn(`[growthbook] prior-assignment lookup failed (${experimentKey}/${maskUnit(unitId)}): ${e.message}`);
    return null;
  }
}

/**
 * Assign a unit to a GrowthBook feature-flag experiment. Assignment is STICKY:
 * an existing exposure row is replayed as-is; only a first-seen unit is
 * evaluated against GrowthBook (a local deterministic hash — no request-path
 * network) and logged. Returns a safe control default on any miss — never throws.
 *
 * @returns {Promise<{ inExperiment: boolean, value: *, variationId: (number|null), variationKey: (string|null) }>}
 */
async function assignExperiment({ experimentKey, featureKey, attributes, unitId, unitType = 'estimate', metadata = null, defaultValue = null }) {
  const control = { inExperiment: false, value: defaultValue, variationId: null, variationKey: null };
  if (!experimentsEnabled()) return control;

  // 1. Sticky replay: a recorded assignment always wins (survives cache misses
  //    AND mid-flight rule changes).
  const replay = replayAssignment(await getPriorAssignment(experimentKey, unitId));
  if (replay) return replay;

  // 2. First exposure needs the feature payload. A cache miss here means the
  //    unit isn't in the experiment for this view (nothing logged); it gets
  //    assigned deterministically once features return.
  const features = getFeaturesNonBlocking();
  if (!features) return control;

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
          // GrowthBook defaults a rule's tracking key to the FEATURE id unless
          // the experiment's trackingKey is set. We always key on the canonical
          // experimentKey (== the required GrowthBook trackingKey) so log,
          // replay, and the analysis query agree; warn on any drift.
          if (experiment && experiment.key && experiment.key !== experimentKey) {
            logger.warn(`[growthbook] tracking-key mismatch: GrowthBook '${experiment.key}' vs expected '${experimentKey}'. Set the experiment's trackingKey to '${experimentKey}'.`);
          }
          exposure = {
            variationId: result.variationId,
            variationKey: result.key,
          };
        }
      },
    });
    const value = gb.getFeatureValue(featureKey, defaultValue);
    if (exposure) {
      // Log under the canonical experimentKey (not experiment.key) and persist
      // the resolved value so a later view can replay this exact arm.
      logExposure({ experimentKey, ...exposure, unitId, unitType, metadata: { ...(metadata || {}), value } });
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

/**
 * Booking-abandon recovery holdback (Phase 2). Unit = the abandoner's phone
 * (last 10 digits) — person-level, matching how the recovery cron dedups
 * sibling intents — so one person is consistently in one arm across intents
 * AND across the SMS + email touches (sticky replay). `value===false` → hold
 * back both touches; anything else (miss, gate off, feature absent) defaults
 * TRUE = send, i.e. today's behavior.
 */
async function assignBookingRecoveryExperiment(phoneLast10, intentId) {
  const ten = String(phoneLast10 || '');
  if (ten.length < 10) {
    // No usable person key (missing/short phone) — stay outside the experiment
    // and keep current behavior.
    return { inExperiment: false, value: true, variationId: null, variationKey: null };
  }
  return assignExperiment({
    experimentKey: BOOKING_RECOVERY_EXPERIMENT,
    featureKey: BOOKING_RECOVERY_FEATURE,
    attributes: { id: ten },
    unitId: ten,
    unitType: 'phone',
    metadata: { intentId: intentId || null },
    defaultValue: true,
  });
}

/**
 * True when `key` is the tracking key of an experiment rule in the CACHED
 * feature payload. Used by the public client-exposure endpoint to accept only
 * experiments that actually exist — unknown keys (or a cold cache, which
 * schedules a refresh) are rejected, so the endpoint can't be used to write
 * arbitrary rows.
 */
function isKnownTrackingKey(key) {
  const features = getFeaturesNonBlocking();
  if (!features) return false;
  for (const [featureId, feature] of Object.entries(features)) {
    for (const rule of (feature && feature.rules) || []) {
      // Experiment rules carry `variations` + a tracking `key` — but
      // GrowthBook DEFAULTS the tracking key to the FEATURE id when the rule
      // doesn't set one, and the SDK reports that defaulted key in
      // trackingCallback. Both spellings must count as live.
      if (rule && Array.isArray(rule.variations) && (rule.key || featureId) === key) return true;
    }
  }
  return false;
}

// Marketing-lead unit ids must satisfy the SAME shape contract as the public
// exposure intake's UNIT_ID_RE (routes/experiments-public.js): the anon_id a
// lead submission carries joins to an experiment_exposures row keyed on that
// exact string, so an id the exposure endpoint would have refused is
// worthless — store null instead so the join never sees junk.
const ANON_UNIT_ID_RE = /^[A-Za-z0-9._-]{8,190}$/;

/**
 * Validate a client-supplied anonymous experiment unit id
 * (`attribution.anon_id` on the public lead-intake routes). Returns the id,
 * or null when absent/malformed — callers persist null rather than rejecting
 * the lead; losing a join beats losing a lead.
 */
function sanitizeAnonUnitId(value) {
  return (typeof value === 'string' && ANON_UNIT_ID_RE.test(value)) ? value : null;
}

// Best-effort cache warm at boot so the first eligible view can participate
// rather than fail open to control.
if (experimentsEnabled()) scheduleRefresh();

module.exports = {
  sanitizeAnonUnitId,
  assignExperiment,
  assignEstimateViewExperiment,
  assignBookingRecoveryExperiment,
  isKnownTrackingKey,
  hasFeatureCache,
  logExposure,
  experimentsEnabled,
  ESTIMATE_VIEW_EXPERIMENT,
  ESTIMATE_VIEW_FEATURE,
  BOOKING_RECOVERY_EXPERIMENT,
  BOOKING_RECOVERY_FEATURE,
};
