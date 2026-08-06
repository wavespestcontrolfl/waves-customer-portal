const express = require('express');
const router = express.Router();
const db = require('../models/db');

// Coalesce concurrent syncs: a burst of requests landing just after the 60s
// interval expires must share ONE in-flight syncConstantsFromDB call instead
// of each launching the full multi-query sync against pricing_config.
let inflightSync = null;
function coalescedSync(syncConstantsFromDB) {
  if (!inflightSync) {
    inflightSync = syncConstantsFromDB(db).finally(() => { inflightSync = null; });
  }
  return inflightSync;
}

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
      const synced = await coalescedSync(syncConstantsFromDB);
      if (!synced) {
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({ error: 'pricing configuration temporarily unavailable' });
      }
    }
    const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
    // The payload cache keys itself to db-bridge's last-sync timestamp, so
    // any sync — this route's or an admin pricing-proposal approval —
    // invalidates it; bots can't force per-request sweeps.
    const payload = computePublicPricingRanges();
    // A partial payload is a contract violation, not a degraded success: if
    // any service sweep failed (engine change, bad config), consumers would
    // cache and publish an incomplete price list for an hour. Fail closed.
    if (payload.errors.length > 0) {
      console.error('[pricing-ranges] sweep errors:', JSON.stringify(payload.errors));
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'pricing ranges temporarily unavailable' });
    }
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
