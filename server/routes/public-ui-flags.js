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

// Glass is the unconditional portal theme now — the GATE_PORTAL_GLASS release
// switch was retired. Current client bundles no longer fetch this endpoint;
// it is kept (always affirming) so any still-cached Capacitor app bundle that
// polls it stays on glass rather than reverting.
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    portalGlass: true,
  });
});

module.exports = router;
