/**
 * Public lawn watering plan API (no auth) — powers the free embeddable
 * watering calculator (owner 2026-10-31, backlink tools plan step 2,
 * "ok go, approved").
 *
 *   GET /api/public/watering-plan?location=bradenton-fl   → this week's plan
 *   GET /api/public/watering-plan?zip=34205&grass=bahia&head=spray&minutes=20&sensor=1
 *
 * Contract: docs/public-route-contracts.md. Read-only: no customer row, no
 * database access, no paid AI, nothing sent to anyone. The decision, the legal
 * ceiling (which fails closed) and the copy are built in
 * services/public-watering-plan.js; this router only owns the gate, the rate
 * limit, status codes and cache headers.
 *
 * Gate: GATE_PUBLIC_WATERING_PLAN (dark by default). Off = the whole surface
 * answers the generic 404, first in server/index.js ahead of the wildcard CORS
 * handler and the global /api/ limiter, and again here ahead of this router's
 * limiter, so a probe never sees a 204 or a 429.
 *
 * CORS: third-party sites embed the calculator, so server/index.js gives this
 * path the same `Access-Control-Allow-Origin: *` + OPTIONS handler as
 * /api/public/pest-forecast, mounted above the credentialed cors() allowlist.
 * GET only, no credentials, so a wildcard is safe.
 *
 * Caching: weather inputs are cached per location until the earlier of 3 hours
 * or the next ET midnight (shorter while an input is missing). The HTTP lifetimes
 * are capped at that same instant, measured when the response is sent.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const logger = require('../services/logger');
const { publicWateringPlanLive } = require('../config/feature-gates');
const { getPublicWateringPlan } = require('../services/public-watering-plan');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');

// Mirrors the index.js pre-limiter guard; dark answers the generic 404 before
// the limiter can answer a revealing 429.
const requireGate = (req, res, next) => {
  if (!publicWateringPlanLive()) return res.status(404).json({ error: 'Not found' });
  return next();
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'rate_limited', message: 'Too many requests from this connection. Please try again in a few minutes.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

router.get('/', requireGate, limiter, async (req, res) => {
  try {
    const result = await getPublicWateringPlan(req.query);

    if (result.status === 'invalid') {
      res.set('Cache-Control', 'no-store');
      return res.status(400).json({ error: result.error, message: result.message });
    }
    if (result.status === 'unavailable') {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'watering_plan_unavailable' });
    }

    // 1h browser / 3h shared cache, both capped at the weather's own freshUntil
    // measured at send time, so an answer computed before ET midnight but sent
    // after it gets 0, never the next day's lifetime (same rule as pest-forecast).
    const freshFor = Number.isFinite(result.freshUntil) ? Math.max(0, Math.floor((result.freshUntil - Date.now()) / 1000)) : 0;
    res.set('Cache-Control', `public, max-age=${Math.min(3600, freshFor)}, s-maxage=${Math.min(10800, freshFor)}`);
    return res.json(result.body);
  } catch (err) {
    logger.error(`[public-watering-plan] failed: ${err.message}`);
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'watering_plan_unavailable' });
  }
});

module.exports = router;
