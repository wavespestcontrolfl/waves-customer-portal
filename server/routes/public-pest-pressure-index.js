/**
 * Public Pest Pressure Index API (no auth) — county averages of the
 * technician's on-site pest-activity rating (owner 2026-11-02, backlink plan
 * step 5, "Pest Pressure Index").
 *
 *   GET /api/public/pest-pressure-index               → JSON
 *   GET /api/public/pest-pressure-index?format=csv    → text/csv, published groups only
 *
 * Contract: docs/public-route-contracts.md. Read-only: one aggregate database
 * query, no PII leaves the server (county x service line averages only, a group
 * published at 20 or more visits), no paid AI, nothing sent to anyone. The
 * grouping, rounding and suppression are in
 * services/public-pest-pressure-index.js; this router only owns the
 * rate limit, status codes and cache headers.
 *
 * CORS: other sites cite and embed the figures, so server/index.js gives this
 * path the same `Access-Control-Allow-Origin: *` + OPTIONS handler as
 * /api/public/pest-forecast, mounted above the credentialed cors() allowlist.
 * GET only, no credentials, so a wildcard is safe.
 *
 * Caching: the computed result is held in memory for 1 hour; responses carry
 * `Cache-Control: public, max-age=3600`. A database failure answers a bare 503
 * JSON error (no stack, no SQL) and is never cached.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const { getPublicPestPressureIndex } = require('../services/public-pest-pressure-index');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'rate_limited', message: 'Too many requests from this connection. Please try again in a few minutes.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

router.get('/', limiter, async (req, res) => {
  const format = req.query.format;
  if (format !== undefined && format !== 'csv' && format !== 'json') {
    res.set('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'invalid_format', message: 'format must be csv or json.' });
  }

  // getPublicPestPressureIndex never throws: it answers { status: 'unavailable' }.
  const result = await getPublicPestPressureIndex();
  if (result.status !== 'ok') {
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'pest_pressure_index_unavailable' });
  }

  res.set('Cache-Control', 'public, max-age=3600');
  if (format === 'csv') {
    res.set('Content-Disposition', 'inline; filename="pest-pressure-index.csv"');
    res.type('text/csv; charset=utf-8');
    return res.send(result.csv);
  }
  return res.json(result.body);
});

module.exports = router;
