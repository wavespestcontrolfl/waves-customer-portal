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
 *   GET /api/public/pest-forecast/nearest                 → visitor's nearest FL city
 *
 * Responses are cached upstream (per-location, until the forecast's
 * freshUntil) and carry CDN-friendly Cache-Control capped at the same instant
 * so a popular embed costs almost nothing to serve.
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { getForecastWithFreshness } = require('../services/pest-forecast/forecast');
const { listLocations, nearestFloridaLocation } = require('../services/pest-forecast/locations');

// CORS (Access-Control-Allow-Origin: * + OPTIONS preflight) is handled at the
// app level in server/index.js, mounted ABOVE the global credentialed cors()
// allowlist so third-party-embed preflights aren't terminated before they reach
// here. This router only owns routing + cache headers.

router.get('/locations', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ locations: listLocations() });
});

// A first-time blog visitor's nearest forecast city, from Cloudflare's
// visitor-location request headers (an IP-based estimate; zone Managed
// Transform "Add visitor location headers"). Florida visitors get a curated
// slug, everyone else null — the widget then keeps its Bradenton default.
// Only the slug leaves: the location values are never logged or stored.
// Differs per visitor, so it is never cached anywhere.
router.get('/nearest', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const nearest = nearestFloridaLocation({
    country: req.get('cf-ipcountry'),
    regionCode: req.get('cf-region-code'),
    latitude: req.get('cf-iplatitude'),
    longitude: req.get('cf-iplongitude'),
  });
  res.json({ location: nearest ? nearest.slug : null });
});

router.get('/', async (req, res) => {
  try {
    const location = typeof req.query.location === 'string' ? req.query.location.trim() : undefined;
    const zip = typeof req.query.zip === 'string' ? req.query.zip.trim() : undefined;

    const { forecast, freshUntil } = await getForecastWithFreshness({ location, zip });

    // 1h browser / 3h shared-cache; lets the CDN absorb embed traffic while
    // the per-location server cache handles the underlying weather calls.
    // Both are capped at the forecast's own freshUntil, measured at send time
    // — so a result computed before ET midnight but sent after it gets 0,
    // never the next day's lifetime.
    const freshFor = Number.isFinite(freshUntil) ? Math.max(0, Math.floor((freshUntil - Date.now()) / 1000)) : 0;
    res.set('Cache-Control', `public, max-age=${Math.min(3600, freshFor)}, s-maxage=${Math.min(10800, freshFor)}`);
    res.json(forecast);
  } catch (err) {
    logger.error(`[public-pest-forecast] failed: ${err.message}`);
    res.status(500).json({ error: 'forecast_unavailable' });
  }
});

module.exports = router;
