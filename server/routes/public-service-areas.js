/**
 * Public service-areas route (no auth) — canonical source for SWFL cities.
 *
 * Mounted at /api/public/service-areas. Consumed by:
 *   - Astro build (wavespestcontrol-astro/scripts/sync-service-areas.mjs
 *     fetches this at build time to regenerate src/data/service-areas.json)
 *   - Admin blog creation UI (multi-select tag picker + related-service scoping)
 *   - Any future public surface that needs the city list
 *
 * Sorted by display_order so callers get a stable, business-curated ordering.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');

router.get('/', async (_req, res) => {
  try {
    const rows = await db('service_areas')
      .select('id', 'city', 'slug', 'county', 'phone', 'tel_href', 'domain_key', 'is_primary', 'display_order')
      .where({ active: true })
      .orderBy('display_order', 'asc');

    res.set('Cache-Control', 'public, max-age=300');
    res.json({ serviceAreas: rows });
  } catch (err) {
    logger.error(`[public-service-areas] list failed: ${err.message}`);
    res.status(500).json({ error: 'failed to load service areas' });
  }
});

module.exports = router;
