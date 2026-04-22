/**
 * Admin debug surface for the customer-facing /available-slots endpoint.
 *
 * GET /api/admin/estimates/:id/slot-debug
 *   Returns the same slot pipeline as the public route, plus:
 *     - every raw slot considered (not just top-3 + expander)
 *     - full insertion anchors (with stop_id + before/after labels) per slot
 *     - cache hit/miss diagnostics
 *     - total compute time in ms
 *     - classification surface: which slots are route-optimal and why
 *
 * Use cases:
 *   - "Sarah says she sees no slots" → check coordsSource, route-optimal
 *     count, proximityDriveMinutes — is she in a low-density area?
 *   - "This slot is flagged route-optimal but looks far on the map" →
 *     check the insertion anchor; it's probably inserting between two
 *     tight stops 15 miles from the estimate, which IS cheap detour.
 *   - "Geocoding is expensive" → cacheSnapshot.geocodeEntries + per-request
 *     miss count tells us how effective the 24h cache is.
 *
 * Lives beside admin-estimates.js for domain-colocation. Separate file
 * because admin-estimates.js is already crowded and debug routes
 * shouldn't pollute the create/send/cancel surface.
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { getSlotDebug } = require('../services/estimate-slot-availability');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/estimates/:id/slot-debug
router.get('/:id/slot-debug', async (req, res) => {
  try {
    const windowDays = Number.parseInt(req.query.windowDays, 10);
    const proximityDriveMinutes = Number.parseInt(req.query.proximityDriveMinutes, 10);
    const opts = {};
    if (Number.isFinite(windowDays) && windowDays > 0 && windowDays <= 30) {
      opts.windowDays = windowDays;
    }
    if (Number.isFinite(proximityDriveMinutes) && proximityDriveMinutes > 0 && proximityDriveMinutes <= 120) {
      opts.proximityDriveMinutes = proximityDriveMinutes;
    }

    const debug = await getSlotDebug(req.params.id, opts);
    return res.json(debug);
  } catch (err) {
    if (err.code === 'ESTIMATE_NOT_FOUND') {
      return res.status(404).json({ error: 'Estimate not found' });
    }
    logger.error(`[admin-estimate-slots] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
