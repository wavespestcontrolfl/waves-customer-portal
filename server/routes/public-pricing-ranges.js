const express = require('express');
const router = express.Router();
const db = require('../models/db');

// GET / — Agent-readable public price ranges
// Engine-derived low/high per service; no auth, no PII, no side effects.
// Consumed by the Astro build for /pricing.md and available directly to
// AI agents. Exact per-property quotes stay on POST /api/public/quote.
router.get('/', async (req, res, next) => {
  try {
    // Pricing is DB-authoritative — apply the admin-edited config before
    // reading the engine, honoring the bridge's 60s interval via needsSync()
    // (syncConstantsFromDB itself always performs the full read, so calling
    // it unconditionally would let bot traffic hammer pricing_config).
    // Within the interval, constants were synced successfully <60s ago.
    // syncConstantsFromDB returns false when the config could not be applied
    // (missing table, connection failure); publishing in-code defaults as if
    // they were authoritative would violate the contract, so fail closed
    // with an uncacheable 503 instead.
    const { needsSync, syncConstantsFromDB } = require('../services/pricing-engine');
    if (needsSync()) {
      const synced = await syncConstantsFromDB(db);
      if (!synced) {
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({ error: 'pricing configuration temporarily unavailable' });
      }
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
