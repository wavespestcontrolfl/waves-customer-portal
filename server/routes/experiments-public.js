/**
 * Public experiment-exposure intake — POST /api/public/experiments/exposure.
 *
 * The client-side GrowthBook SDK (client/src/lib/growthbook.js) evaluates
 * feature experiments in the browser and reports each assignment here so it
 * lands in `experiment_exposures` — the same warehouse table GrowthBook's
 * analysis reads — keeping Postgres the single source of truth for exposures
 * (no separate event store).
 *
 * No auth (anonymous visitors are the point). Abuse posture:
 *  - Gate off (GATE_GROWTHBOOK) → 404, same dark-surface contract as other
 *    gated public routes.
 *  - Per-route rate limit on top of the global /api limiter.
 *  - The experiment key must be a CURRENTLY-LIVE tracking key in the cached
 *    GrowthBook payload (isKnownTrackingKey) — arbitrary keys can't create
 *    rows. Unknown keys are dropped with the same 204 as accepted ones, so
 *    the response never confirms which experiments exist.
 *  - SERVER-owned experiment keys are always refused: sticky replay
 *    (services/experimentation/growthbook.js) trusts experiment_exposures
 *    keyed on (experiment_key, unit_id), so accepting e.g. `estimate-view`
 *    from the public internet would let an attacker pre-assign a real
 *    estimate's arm. Client exposures are also hard-stamped unit_type='anon'
 *    + metadata.source='client' — the client never chooses either.
 *  - First-exposure-wins unique constraint dedups repeat posts.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const featureGates = require('../config/feature-gates');
const Experiments = require('../services/experimentation/growthbook');

const router = express.Router();

// Tracking keys evaluated + logged by the SERVER — never accepted from the
// browser (see abuse posture above).
const SERVER_OWNED_KEYS = new Set([
  Experiments.ESTIMATE_VIEW_EXPERIMENT,
  Experiments.BOOKING_RECOVERY_EXPERIMENT,
]);

const EXPERIMENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const UNIT_ID_RE = /^[A-Za-z0-9._-]{8,190}$/;
const VARIATION_KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;

// A page load evaluates each live client experiment at most once, so real
// traffic is a handful of posts per visitor. Tight cap; the unique constraint
// makes anything past the first post per (experiment, unit) a no-op anyway.
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
}));

router.post('/exposure', (req, res) => {
  if (!featureGates.isEnabled('growthbookExperiments')) {
    return res.status(404).json({ error: 'Not found' });
  }

  const body = req.body || {};
  const experimentKey = typeof body.experimentKey === 'string' ? body.experimentKey : '';
  const unitId = typeof body.unitId === 'string' ? body.unitId : '';
  const variationId = Number.isInteger(body.variationId) ? body.variationId : null;
  const variationKey = typeof body.variationKey === 'string' ? body.variationKey : null;

  if (!EXPERIMENT_KEY_RE.test(experimentKey)
    || !UNIT_ID_RE.test(unitId)
    || variationId === null || variationId < 0 || variationId > 999
    || (variationKey !== null && !VARIATION_KEY_RE.test(variationKey))) {
    return res.status(400).json({ error: 'Invalid exposure payload' });
  }

  // value is analysis metadata only (client replay never reads it) — accept
  // scalars, cap string length, drop anything else.
  let value = body.value;
  if (typeof value === 'string') value = value.slice(0, 100);
  else if (typeof value !== 'boolean' && typeof value !== 'number') value = null;

  // Same 204 whether stored or dropped — no experiment-enumeration oracle.
  if (!SERVER_OWNED_KEYS.has(experimentKey) && Experiments.isKnownTrackingKey(experimentKey)) {
    // Fire-and-forget like the server-side assignment path; logExposure
    // swallows + warn-logs its own failures.
    Experiments.logExposure({
      experimentKey,
      variationId,
      variationKey,
      unitId,
      unitType: 'anon',
      metadata: { value, source: 'client' },
    });
  }
  return res.status(204).end();
});

module.exports = router;
