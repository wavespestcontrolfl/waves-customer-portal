/**
 * GET /api/public/map-image/:token — signed satellite image proxy.
 *
 * Customer-facing surfaces (the public lead-form lookup, the customer service
 * report, the customer portal termite-station map) used to carry Google Static
 * Maps URLs with the server's Maps key in them. They now carry a short-lived
 * HMAC-signed path to this route instead (services/signed-map-image.js).
 *
 * The route reads exactly one thing from the request — the signed token in the
 * path. It rebuilds the Static Maps URL only from the token's signed,
 * range-checked values, appends the server key, and streams the image. There is
 * no query parameter, no caller-supplied center/zoom/size, and no other host,
 * so it cannot be steered into an open proxy or an SSRF. Every refusal (bad
 * shape, bad signature, expired, no key configured, upstream failure) answers
 * the same generic 404. Nothing here logs a URL or token.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../services/logger');
const { ipFallbackKey } = require('../middleware/rate-limit-key');
const { fetchStaticMapImage, staticMapsKey } = require('../services/estimate-map-image');
const { verifyMapImageToken, keylessStaticMapUrl } = require('../services/signed-map-image');

const router = express.Router();

// Every response (404 and 429 included) carries these. Cross-Origin-Resource-
// Policy is `cross-origin` because helmet defaults to same-origin, which would
// block the <img> on the marketing site (a different origin from this API) and
// on a SPA built against a separate API origin.
function stampHeaders(res) {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
}

function notFound(res) {
  stampHeaders(res);
  return res.status(404).json({ error: 'Not found' });
}

const mapImageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  // Shared key: collapses an IPv6 client's /64 to one bucket.
  keyGenerator: (req) => ipFallbackKey(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    stampHeaders(res);
    res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  },
});

router.get('/:token', mapImageLimiter, async (req, res, next) => {
  try {
    stampHeaders(res);
    // Ignore any query string: only the signed path token is honoured.
    const params = verifyMapImageToken(req.params.token);
    if (!params) return notFound(res);
    const keylessUrl = keylessStaticMapUrl(params);
    if (!keylessUrl) return notFound(res);
    // No server-side image cache: the provider terms are display-only.
    const image = await fetchStaticMapImage(keylessUrl, { key: staticMapsKey() });
    if (!image) {
      logger.warn('[map-image] image unavailable upstream');
      return notFound(res);
    }
    return res
      .status(200)
      .set('Content-Type', image.contentType)
      .set('Content-Length', String(image.buffer.length))
      .set('Cache-Control', 'private, max-age=900')
      .send(image.buffer);
  } catch (err) { next(err); }
});

module.exports = router;
