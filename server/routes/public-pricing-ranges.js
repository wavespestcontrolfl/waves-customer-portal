const express = require('express');
const router = express.Router();
const db = require('../models/db');

// Coalesce concurrent syncs: a burst of requests landing just after the 60s
// interval expires must share ONE in-flight syncConstantsFromDB call instead
// of each launching the full multi-query sync against pricing_config.
let inflightSync = null;
// Failed-sync backoff: a failed sync doesn't advance the bridge's interval,
// so without this every subsequent request would re-hit the already-unhealthy
// database; retry at most once per FAILED_SYNC_BACKOFF_MS.
const FAILED_SYNC_BACKOFF_MS = 30 * 1000;
let lastFailedSyncAt = 0;
function coalescedSync(syncConstantsFromDB) {
  if (!inflightSync) {
    inflightSync = syncConstantsFromDB(db)
      .then((ok) => {
        if (!ok) lastFailedSyncAt = Date.now();
        else lastFailedSyncAt = 0;
        return ok;
      })
      .finally(() => { inflightSync = null; });
  }
  return inflightSync;
}

// Shared producer for the agent-readable public price ranges — used by the
// GET route below and by the public MCP `get_pricing_ranges` tool
// (routes/public-mcp.js), so both surfaces publish the identical payload
// under the identical fail-closed rules.
// Returns { ok: true, payload, cacheable } or { ok: false, error } — a
// non-ok result must be served uncacheable (Cache-Control: no-store).
async function getPublicPricingRangesResult() {
  // Pricing is DB-authoritative — apply the admin-edited config before
  // reading the engine, honoring the bridge's 60s interval via needsSync()
  // (syncConstantsFromDB itself always performs the full read, so calling
  // it unconditionally would let bot traffic hammer pricing_config).
  // Within the interval, constants were synced successfully <60s ago.
  // syncConstantsFromDB returns false when the config could not be applied
  // (missing table, connection failure); publishing in-code defaults as if
  // they were authoritative would violate the contract, so fail closed
  // instead.
  const { needsSync, syncConstantsFromDB } = require('../services/pricing-engine');
  if (needsSync()) {
    if (Date.now() - lastFailedSyncAt < FAILED_SYNC_BACKOFF_MS) {
      return { ok: false, error: 'pricing configuration temporarily unavailable' };
    }
    const synced = await coalescedSync(syncConstantsFromDB);
    if (!synced) {
      return { ok: false, error: 'pricing configuration temporarily unavailable' };
    }
  }
  const { computePublicPricingRanges, lastComputeUnstable } = require('../services/pricing-engine/public-ranges');
  // The payload cache keys itself to db-bridge's last-sync timestamp, so
  // any sync — this route's or an admin pricing-proposal approval —
  // invalidates it; bots can't force per-request sweeps.
  // If a sweep overlapped an in-flight sync, don't serve the possibly
  // mixed payload at all — wait briefly for the sync to settle and
  // recompute; fail closed if it won't.
  let payload = computePublicPricingRanges();
  for (let attempt = 0; attempt < 20 && lastComputeUnstable(); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    payload = computePublicPricingRanges();
  }
  if (lastComputeUnstable()) {
    return { ok: false, error: 'pricing configuration is being updated — retry shortly' };
  }
  // A partial payload is a contract violation, not a degraded success: if
  // any service sweep failed (engine change, bad config), consumers would
  // cache and publish an incomplete price list for an hour. Fail closed.
  if (payload.errors.length > 0) {
    console.error('[pricing-ranges] sweep errors:', JSON.stringify(payload.errors));
    return { ok: false, error: 'pricing ranges temporarily unavailable' };
  }
  // A payload computed while a sync was in flight must not be cached
  // downstream either — it may mix pre/post-edit constants.
  return { ok: true, payload, cacheable: !lastComputeUnstable() };
}

// GET / — Agent-readable public price ranges
// Engine-derived low/high per service; no auth, no PII, no side effects.
// Consumed by the Astro build for /pricing.md and available directly to
// AI agents. Exact per-property quotes stay on POST /api/public/quote.
router.get('/', async (req, res, next) => {
  try {
    const result = await getPublicPricingRangesResult();
    if (!result.ok) {
      res.set('Cache-Control', 'no-store');
      return res.status(503).json({ error: result.error });
    }
    // 5-minute freshness: bounds how long a downstream cache can serve a
    // pre-edit payload after an admin pricing change (the in-process memo
    // invalidates immediately, but a shared cache only revalidates on
    // expiry).
    if (result.cacheable) {
      res.set('Cache-Control', 'public, max-age=300');
    } else {
      res.set('Cache-Control', 'no-store');
    }
    res.json(result.payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.getPublicPricingRangesResult = getPublicPricingRangesResult;
