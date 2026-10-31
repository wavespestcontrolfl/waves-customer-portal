/**
 * Public bug identifier for the Waves "Bug Identifier" Chrome extension
 * (owner 2026-10-31: "Let's do the insect identification" — a new endpoint,
 * 100 identifications a day).
 *
 *   POST /api/public/bug-id-extension/identify — 1–3 photos → the v2 answer
 *
 * Contract: docs/public-route-contracts.md. Chrome Web Store installs are
 * anonymous and worldwide, so unlike the wavespestcontrol.com funnel
 * (public-pest-identifier.js) this is NOT a lead magnet: no contact capture,
 * no pricing, no DB row, no stored photo — the photos live only for the
 * length of the request. The answer is the v2 species-catalog engine's
 * customer object (identifyPestV2 on the Gemini-only ladder, exactly as the
 * customer app calls it), where every string is catalog copy or a fixed
 * template; the engine's `internal` block (which models answered) and its
 * `v1` column mapping never leave the server.
 *
 * Spend guards. There is no Turnstile — Cloudflare's widget cannot render on
 * a chrome-extension:// page — so instead:
 *   - GATE_BUG_ID_EXTENSION (dark by default): off = the whole surface 404s,
 *     first in index.js ahead of the global limiter and the 50 MB photo
 *     parser, and again here ahead of this router's limiters;
 *   - per IP (IPv6 collapsed to its /64): 6 an hour and 15 a day, in memory;
 *   - one worldwide daily cap with its own `bug-id-extension` bucket
 *     (BUG_ID_EXTENSION_CAP, default 100), counted in Postgres whatever
 *     GATE_PUBLIC_LLM_SHARED_CAP says and failing CLOSED on a counter error.
 *     The website funnels' `photo-assessment` budget is never touched.
 * No CORS headers: the extension's host permission is what lets it read the
 * response, so an ordinary web page cannot call this from a visitor's
 * browser. Sends nothing to anyone.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const logger = require('../services/logger');
const { bugIdExtensionLive } = require('../config/feature-gates');
const { identifyPestV2 } = require('../services/photo-id-v2/pest-engine');
const { consumeSharedDailyCap, BUG_ID_EXTENSION_CAP } = require('../middleware/public-llm-shared-cap');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { setPublicPrivacyHeaders } = require('../utils/public-report-egress');

const MAX_PHOTOS = 3;
// Same per-photo ceiling as the website funnels (~4.5 MB of image); the
// extension sends one resized JPEG of a few hundred KB.
const MAX_PHOTO_CHARS = 6_000_000;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// The ONE shape check: the handler 400s/413s anything it fails, and the
// per-IP limiters skip it, so junk never spends a real caller's allowance.
function photoProblem(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid';
  const photos = body.photos;
  if (!Array.isArray(photos) || photos.length === 0) return 'invalid';
  if (photos.length > MAX_PHOTOS) return 'too_many';
  for (const photo of photos) {
    if (!photo || typeof photo !== 'object' || typeof photo.data !== 'string' || !photo.data) return 'invalid';
    if (!ALLOWED_MIME_TYPES.has(photo.mimeType)) return 'invalid';
    if (photo.data.length > MAX_PHOTO_CHARS) return 'too_large';
    if (!BASE64_RE.test(photo.data)) return 'invalid';
  }
  return null;
}

const skipLimiter = (req) => process.env.NODE_ENV !== 'production' || photoProblem(req.body) !== null;

const hourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'Too many identifications from this connection. Please try again in an hour.' },
  skip: skipLimiter,
});

const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'Daily limit reached for this connection. Please try again tomorrow.' },
  skip: skipLimiter,
});

// Mirrors the index.js pre-parser guard; dark answers the generic 404 before
// any limiter can answer a revealing 429.
const requireGate = (req, res, next) => {
  if (!bugIdExtensionLive()) return res.status(404).json({ error: 'Not found' });
  return next();
};

const PROBLEM_RESPONSES = {
  invalid: [400, { error: 'Add a JPEG, PNG or WebP photo of the bug.' }],
  too_many: [400, { error: `At most ${MAX_PHOTOS} photos can be identified at once.` }],
  too_large: [413, { error: 'That photo is too large. Please try a smaller one.' }],
};

// POST /api/public/bug-id-extension/identify
router.post('/identify', requireGate, hourlyLimiter, dailyLimiter, async (req, res, next) => {
  try {
    setPublicPrivacyHeaders(res);

    const problem = photoProblem(req.body);
    if (problem) {
      const [status, body] = PROBLEM_RESPONSES[problem];
      return res.status(status).json(body);
    }

    // Worldwide daily ceiling, counted once, after every rejection above and
    // right before the paid vision call.
    const cap = await consumeSharedDailyCap(BUG_ID_EXTENSION_CAP);
    if (!cap.allowed) {
      return res.status(429).json({ error: "Today's free identifications are used up. Please try again tomorrow." });
    }

    const photos = req.body.photos.map((photo) => ({ data: photo.data, mimeType: photo.mimeType }));
    const result = await identifyPestV2(photos, { ladder: 'gemini_only' });
    if (!result.ok) {
      return res.status(503).json({ error: 'Bug identification is briefly unavailable. Please try again in a few minutes.' });
    }

    const { v2 } = result;
    logger.info(`[public-bug-id-extension] answered: tier=${v2.tier} wording=${v2.answer && v2.answer.wording} species=${(v2.entry && v2.entry.slug) || '-'} photos=${photos.length}`);
    return res.status(200).json({ success: true, result: v2 });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports._test = { photoProblem, MAX_PHOTOS, MAX_PHOTO_CHARS };
