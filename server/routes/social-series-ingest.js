/**
 * Social series ingest — POST /api/social/series/media and /posts (machine auth).
 *
 * The weekly "series" job on the owner's other Mac used to push its numbered
 * Facebook, Instagram and Google Business posts through Zernio, a paid posting
 * API (owner decision 2026-11-01). The portal posts to those three networks
 * for free, so the job now hands them here: /media hosts the picture or video
 * on the social CDN, /posts stores one scheduled social_media_posts row that
 * the existing scheduler publishes (services/social-series-intake.js). TikTok
 * and X stay on Zernio and are refused here.
 *
 * Built like /api/ops/digest (routes/ops-digest-ingest.js): token-only auth,
 * unobservable while dark, body parsed only after auth.
 *   404  SOCIAL_SERIES_INGEST_TOKEN unset — the kill switch; the generic
 *        unknown-route body, any method, OPTIONS included
 *   401  token mismatch
 *   413  body too large / 400 body not JSON (after auth only)
 *   400  { ok:false, reason, detail } on a refused payload
 *   409  scheduled_posts_disabled / platform_disabled — the scheduler would
 *        never post the row (SOCIAL_FLAGS), so nothing is stored; the caller
 *        keeps its Zernio path for that run (dry runs included)
 *   415  /media content type is not jpeg, png, webp or mp4
 *   503  media_hosting_unavailable (the S3/CDN helper returned null)
 *   201  /media { ok, url, kind }; /posts { ok, id, deduped:false, scheduledFor }
 *   200  /posts deduped row, or a dry run
 *
 * Logs carry item ids only, never the token, a caption or a media URL.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../services/logger');
const { safeEqual } = require('../middleware/hermes-auth');
const { notFoundBody } = require('../middleware/errors');
const { noStore } = require('../middleware/no-store');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { validateSeriesPost, insertSeriesPost } = require('../services/social-series-intake');

const router = express.Router();
// Token-route privacy baseline on every outcome: no-store, noindex, no-referrer.
router.use(noStore);

const MEDIA_TYPES = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
};
const MEDIA_LIMIT = '64mb';
const POSTS_LIMIT = '256kb';

const ingestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { ok: false, reason: 'rate_limited' },
  // The bearer is a shared secret, not a JWT: key by client IP (/64).
  keyGenerator: unauthenticatedAuthLimitKey,
  // Off under jest only — staging / PR environments keep the limiter.
  skip: () => process.env.NODE_ENV === 'test',
});

// The SAME body an unknown route gets, never a retyped string.
function genericNotFound(req, res) {
  return res.status(404).json(notFoundBody(req));
}

// Dark-route check FIRST, ahead of the limiter: while the token is unset the
// endpoint is a plain 404 at any request volume (a 429 would reveal the route).
function darkUnlessConfigured(req, res, next) {
  if (!process.env.SOCIAL_SERIES_INGEST_TOKEN) return genericNotFound(req, res);
  return next();
}

function ingestAuth(req, res, next) {
  const expected = process.env.SOCIAL_SERIES_INGEST_TOKEN;
  if (!expected) return genericNotFound(req, res);
  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(provided, expected)) return res.status(401).json({ ok: false, reason: 'invalid_token' });
  return next();
}

function baseContentType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

// Cheap signature check so a mislabeled body is a 400 here, not a vague 503
// from the image converter or ffmpeg.
function matchesSignature(buffer, type) {
  if (type === 'image/jpeg') return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (type === 'image/png') return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP';
  return buffer.length > 12 && buffer.toString('latin1', 4, 8) === 'ftyp';
}

router.post('/media', darkUnlessConfigured, ingestAuth, async (req, res) => {
  const type = baseContentType(req);
  const spec = MEDIA_TYPES[type];
  if (!spec) return res.status(415).json({ ok: false, reason: 'unsupported_media_type', detail: 'Content-Type must be image/jpeg, image/png, image/webp or video/mp4' });
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ ok: false, reason: 'empty_body', detail: 'send the file bytes as the request body' });
  if (!matchesSignature(body, type)) return res.status(400).json({ ok: false, reason: 'content_type_mismatch', detail: `the bytes are not a ${type} file` });

  const filename = `series-${crypto.randomUUID()}.${spec.ext}`;
  let url = null;
  try {
    const social = require('../services/social-media');
    url = spec.kind === 'video'
      ? await social.uploadVideoToS3(body, filename)
      : await social.uploadImageToS3(body.toString('base64'), filename);
  } catch (err) {
    logger.error(`[social-series-ingest] media upload threw: ${err.message}`);
  }
  if (!url) {
    logger.warn(`[social-series-ingest] media not hosted (${filename})`);
    return res.status(503).json({ ok: false, reason: 'media_hosting_unavailable' });
  }
  logger.info(`[social-series-ingest] hosted ${spec.kind} ${filename}`);
  return res.status(201).json({ ok: true, url, kind: spec.kind });
});

// Channel -> its own SOCIAL_FLAGS switch (social-media.js).
const CHANNEL_FLAGS = { facebook: 'facebookEnabled', instagram: 'instagramEnabled', gbp: 'gbpEnabled' };

// Fail closed: a row the scheduler would never post must not be stored (it
// would sit 'scheduled' and look handled). Read at call time. A temporary
// admin pause (isPausedByAdmin) is deliberately NOT checked: the scheduler
// waits a pause out and posts the row afterwards.
function disabledRefusal(channels) {
  const { SOCIAL_FLAGS } = require('../services/social-media');
  if (!SOCIAL_FLAGS.automationEnabled || !SOCIAL_FLAGS.scheduledPosts) return { reason: 'scheduled_posts_disabled' };
  const off = channels.find((channel) => !SOCIAL_FLAGS[CHANNEL_FLAGS[channel]]);
  return off ? { reason: 'platform_disabled', detail: off } : null;
}

router.post('/posts', darkUnlessConfigured, ingestAuth, async (req, res) => {
  const { error, value } = validateSeriesPost(req.body);
  if (error) return res.status(400).json({ ok: false, reason: error.reason, detail: error.detail });
  const disabled = disabledRefusal(value.row.platforms_posted);
  if (disabled) return res.status(409).json({ ok: false, ...disabled });
  const itemId = value.row.source_guid;
  if (value.dryRun) {
    logger.info(`[social-series-ingest] ${itemId}: dry run ok`);
    return res.status(200).json({ ok: true, dryRun: true, row: value.row });
  }
  try {
    const stored = await insertSeriesPost(value.row);
    logger.info(`[social-series-ingest] ${itemId}: ${stored.deduped ? 'already stored' : 'stored'} ${stored.id}`);
    return res.status(stored.deduped ? 200 : 201).json({ ok: true, ...stored });
  } catch (err) {
    logger.error(`[social-series-ingest] ${itemId}: insert failed: ${err.message}`);
    return res.status(503).json({ ok: false, reason: 'store_failed' });
  }
});

// Parser failures after auth: plain JSON, never the HTML default. Only
// reachable once ingestAuth passed (the chain below).
function ingestBodyErrorHandler(err, req, res, next) {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, reason: 'payload_too_large' });
  if (err && err.status === 400) return res.status(400).json({ ok: false, reason: 'invalid_json' });
  return next(err);
}

const mediaParser = express.raw({ type: Object.keys(MEDIA_TYPES), limit: MEDIA_LIMIT });
const postsParser = express.json({ limit: POSTS_LIMIT });
// The chain is mounted on the whole prefix, so each parser runs only on its
// path. Case-insensitive like Express routing, so /MEDIA cannot reach the
// handler without its capped parser.
function pathIs(req, path) {
  return req.path.replace(/\/+$/, '').toLowerCase() === path;
}
function mediaPreParser(req, res, next) {
  return pathIs(req, '/media') ? mediaParser(req, res, next) : next();
}
function postsPreParser(req, res, next) {
  return pathIs(req, '/posts') ? postsParser(req, res, next) : next();
}

// Mounted by server/index.js on /api/social/series AHEAD of the global body
// parsers (the /api/ops/digest pattern): privacy headers → dark 404 → own
// limiter → bearer auth → the path's capped parse → body errors. While the
// token is unset nothing but the generic 404 is observable, and an
// unauthenticated caller gets 401 before any body is parsed. The router
// repeats the dark check + auth as its own first layers; the limiter lives
// ONLY here so a request is counted once.
const ingestPreParsers = [
  noStore, darkUnlessConfigured, ingestLimiter, ingestAuth,
  mediaPreParser, postsPreParser, ingestBodyErrorHandler,
];

module.exports = router;
module.exports.ingestPreParsers = ingestPreParsers;
module.exports._private = {
  ingestAuth, darkUnlessConfigured, ingestBodyErrorHandler, genericNotFound, matchesSignature, MEDIA_TYPES,
};
