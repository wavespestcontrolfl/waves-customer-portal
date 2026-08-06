const express = require('express');
const router = express.Router();
const db = require('../models/db');

// GET / — Agent-readable public price ranges
// Engine-derived low/high per service; no auth, no PII, no side effects.
// Consumed by the Astro build for /pricing.md and available directly to
// AI agents. Exact per-property quotes stay on POST /api/public/quote.
router.get('/', async (req, res, next) => {
  try {
    // Pricing is DB-authoritative — sync (60s-cached) before reading the engine.
    const { syncConstantsFromDB } = require('../services/pricing-engine');
    await syncConstantsFromDB(db);
    const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
    const payload = computePublicPricingRanges();
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
