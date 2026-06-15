/**
 * Public Pest Pressure Forecast API (no auth) — powers the free embeddable
 * widget that other Florida sites can drop onto their pages.
 *
 * Mounted at /api/public/pest-forecast. Because the widget runs on third-party
 * domains, this route sets an explicit `Access-Control-Allow-Origin: *` rather
 * than relying on the app-wide credentialed CORS allowlist (config/cors-origins).
 * It is a read-only GET with no cookies/credentials, so a wildcard is safe.
 *
 *   GET /api/public/pest-forecast?location=bradenton-fl   → forecast payload
 *   GET /api/public/pest-forecast?zip=34205               → forecast (zip resolve)
 *   GET /api/public/pest-forecast/locations               → curated location list
 *
 * Responses are cached upstream (per-location, 3h) and carry CDN-friendly
 * Cache-Control so a popular embed costs almost nothing to serve.
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { getForecast } = require('../services/pest-forecast/forecast');
const { listLocations } = require('../services/pest-forecast/locations');

// CORS (Access-Control-Allow-Origin: * + OPTIONS preflight) is handled at the
// app level in server/index.js, mounted ABOVE the global credentialed cors()
// allowlist so third-party-embed preflights aren't terminated before they reach
// here. This router only owns routing + cache headers.

router.get('/locations', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ locations: listLocations() });
});

router.get('/', async (req, res) => {
  try {
    const location = typeof req.query.location === 'string' ? req.query.location.trim() : undefined;
    const zip = typeof req.query.zip === 'string' ? req.query.zip.trim() : undefined;

    const forecast = await getForecast({ location, zip });

    // 1h browser / 3h shared-cache; lets the CDN absorb embed traffic while
    // the per-location server cache (3h) handles the underlying weather calls.
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=10800');
    res.json(forecast);
  } catch (err) {
    logger.error(`[public-pest-forecast] failed: ${err.message}`);
    res.status(500).json({ error: 'forecast_unavailable' });
  }
});

module.exports = router;
