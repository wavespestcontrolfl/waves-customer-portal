/**
 * Public UI flags (no auth) — release switches the client shell needs before
 * any authenticated payload exists (the portal SPA and login page have no
 * per-page token payload to carry them, unlike estimates/reports).
 *
 * Mounted at /api/public/ui-flags.
 *
 *   GET /api/public/ui-flags → { portalGlass: boolean }
 *
 * No-store: a gate flip on Railway must reach clients on their next load,
 * not after a CDN TTL. The response is a couple of bytes; caching would buy
 * nothing and cost release latency.
 */

const express = require('express');
const router = express.Router();
const featureGates = require('../config/feature-gates');

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    portalGlass: featureGates.isEnabled('portalGlassTheme'),
  });
});

module.exports = router;
