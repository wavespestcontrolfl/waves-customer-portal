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
const { FIXED_CARDS, resolveCardContent } = require('../services/link-preview-metadata');
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
const linkPreviewLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').unauthenticatedAuthLimitKey,
});
router.use(linkPreviewLimiter);

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
async function renderCached(content) {
  const cacheKey = JSON.stringify([content.eyebrow, content.headline, content.subline]);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const buffer = await renderLinkPreviewJpeg(content);
  cacheSet(cacheKey, buffer);
  return buffer;
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
    logger.error(`[og-preview] default card render failed: ${err.message}`);
    return res.status(500).end();
  }
}

// /og/default.jpg, and /og/<kind>.jpg for a card whose words are the same
// for every customer (FIXED_CARDS — no token, no lookup). Anything else in
// this shape gets the default card.
router.get('/:file', async (req, res) => {
  const match = /^([a-z-]+)\.jpg$/.exec(String(req.params.file || ''));
  const kind = match && Object.prototype.hasOwnProperty.call(FIXED_CARDS, match[1]) ? match[1] : null;
  if (!kind) return sendDefault(res);
  try {
    return sendJpeg(res, await renderCached(FIXED_CARDS[kind]));
  } catch (err) {
    logger.error(`[og-preview] card render failed for kind=${kind}: ${err.message}`);
    return sendDefault(res);
  }
});

// One route for every kind — :tokenFile carries the token AND the .jpg
// extension (Express route params don't span a literal dot cleanly), split
// in the handler. A kind or token that fails validation (including a
// missing .jpg) falls back to the default card exactly like an unknown
// token — never a 404, never a distinguishable response.
router.get('/:kind/:tokenFile', async (req, res) => {
  const { kind } = req.params;
  const tokenFile = String(req.params.tokenFile || '');
  const match = /^(.+)\.jpg$/i.exec(tokenFile);
  if (!match) return sendDefault(res);
  const token = match[1];

  try {
    const content = await resolveCardContent(kind, token);
    if (!content) return sendDefault(res);
    const buffer = await renderCached(content);
    return sendJpeg(res, buffer);
  } catch (err) {
    logger.error(`[og-preview] card render failed for kind=${kind}: ${err.code || err.name}`);
    return sendDefault(res);
  }
});

module.exports = router;
// The same budget guards the customer HTML pages whose <head> looks a token
// up for its preview tags (server/index.js).
module.exports.linkPreviewLimiter = linkPreviewLimiter;
module.exports._internals = { cache, DEFAULT_CONTENT };
