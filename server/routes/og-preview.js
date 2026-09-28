/**
 * Per-link Open Graph preview images — GET /og/:kind/:token.jpg,
 * GET /og/<kind>.jpg (token-free cards) and GET /og/default.jpg. Contract:
 * docs/public-route-contracts.md.
 *
 * Mounted BEFORE the SPA catch-all and OUTSIDE any auth (server/index.js) —
 * this is the endpoint iMessage/SMS/email link-preview crawlers actually
 * fetch. It re-resolves the token server-side through the SAME resolvers
 * link-preview-metadata.js uses for the HTML <head> tags — it never trusts
 * card text passed on the query string, and there is none to trust: this
 * route takes no query params at all.
 *
 * Unknown / suppressed / invalid token → the generic default card, 200,
 * same response shape as a real one. This route must never 404 or leak
 * whether a token exists — that would turn "the image loaded" into a token
 * existence oracle for anyone probing token guesses.
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { fixedCard, resolveCardContent } = require('../services/link-preview-metadata');
const { renderLinkPreviewJpeg } = require('../services/link-preview-card-renderer');

// Token-bearing cards (/og/:kind/:token.jpg) get the privacy headers before
// the limiter, like every other token surface (docs/public-route-contracts.md).
router.use((req, res, next) => {
  if (req.path.split('/').filter(Boolean).length > 1) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.set('Referrer-Policy', 'no-referrer');
  }
  next();
});

// Public and outside the /api limiter, and a token-bearing card costs a DB
// lookup — same per-IP budget as the /l short links. Preview crawlers fetch
// one image per shared link, far under this.
router.use(require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').unauthenticatedAuthLimitKey,
}));

const DEFAULT_CONTENT = {
  eyebrow: 'CUSTOMER PORTAL',
  headline: 'Waves Pest Control',
  subline: 'Your reports, visits, and billing',
};

// Tiny in-memory LRU (per process — this is a rendering cache, not a source
// of truth) so a burst of crawler/preview-bot hits on the same link doesn't
// re-render the same JPEG on every request. Capped at 200 entries; oldest
// (least-recently-used) evicted first.
const CACHE_LIMIT = 200;
const cache = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  // Touch: move to the end (most-recently-used).
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

// Keyed by what the card SHOWS, never by token: a moved or cancelled
// appointment resolves new content and so renders a new image, and two links
// with the same words share one render.
// Identical misses that arrive while a render is running share it, so a
// burst of crawlers on a freshly shared link renders the card once.
const inFlight = new Map();

async function renderCached(content) {
  const cacheKey = JSON.stringify([content.eyebrow, content.headline, content.subline]);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
  const pending = renderLinkPreviewJpeg(content)
    .then((buffer) => {
      cacheSet(cacheKey, buffer);
      return buffer;
    })
    .finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, pending);
  return pending;
}

function sendJpeg(res, buffer) {
  res.set('Content-Type', 'image/jpeg');
  // Token-free cards are plain brand images; token cards keep the no-store
  // the privacy middleware already set.
  if (!res.get('Cache-Control')) res.set('Cache-Control', 'public, max-age=3600');
  return res.send(buffer);
}

async function sendDefault(res) {
  try {
    const buffer = await renderCached(DEFAULT_CONTENT);
    return sendJpeg(res, buffer);
  } catch (err) {
    logger.error(`[og-preview] default card render failed: ${err.code || err.name}`);
    return res.status(500).end();
  }
}

// Routes match the RAW path with regexes whose captures can't hold a '%',
// so Express never URL-decodes a parameter here: a malformed encoding can't
// throw past this router into the JSON error handler.

// /og/default.jpg, and /og/<kind>.jpg for a card whose words are the same
// for every customer (FIXED_CARDS — no token, no lookup; a dark surface's
// card is the default).
router.get(/^\/([a-z-]+)\.jpg$/, async (req, res) => {
  const kind = req.params[0];
  const content = fixedCard(kind);
  if (!content) return sendDefault(res);
  try {
    return sendJpeg(res, await renderCached(content));
  } catch (err) {
    logger.error(`[og-preview] card render failed for kind=${kind}: ${err.code || err.name}`);
    return sendDefault(res);
  }
});

// The one token-bearing card: the service report, 32-hex token.
router.get(/^\/report\/([a-f0-9]{32})\.jpg$/i, async (req, res) => {
  try {
    const content = await resolveCardContent('report', req.params[0]);
    if (!content) return sendDefault(res);
    return sendJpeg(res, await renderCached(content));
  } catch (err) {
    logger.error(`[og-preview] card render failed for kind=report: ${err.code || err.name}`);
    return sendDefault(res);
  }
});

// Anything else under /og — another kind with a token, a bad token, a
// missing .jpg, a malformed encoding — is the default card, never a 404 or
// a distinguishable response.
router.get(/.*/, (req, res) => sendDefault(res));

module.exports = router;
module.exports._internals = { cache, inFlight, DEFAULT_CONTENT };
