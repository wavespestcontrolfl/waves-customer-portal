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
    // syncConstantsFromDB returns false when the admin-edited config could not
    // be applied (missing table, connection failure); publishing in-code
    // defaults as if they were authoritative would violate the contract, so
    // fail closed with an uncacheable 503 instead.
    const { syncConstantsFromDB } = require('../services/pricing-engine');
    const synced = await syncConstantsFromDB(db);
    if (!synced) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'pricing configuration temporarily unavailable' });
    }
    const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
    const payload = computePublicPricingRanges();
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
