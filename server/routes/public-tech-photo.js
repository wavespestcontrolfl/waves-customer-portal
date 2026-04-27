/**
 * Public tech photo proxy. Mounted at /api/public/tech-photo.
 *
 * GET /:technicianId — looks up technicians.photo_s3_key, generates
 * a fresh presigned S3 URL, and 302-redirects there. The browser
 * follows the redirect and renders the image; the redirect target
 * URL changes per request so it never goes stale, while the
 * advertised /:technicianId URL stays stable.
 *
 * Why a proxy at all: the customer tracker (track-public.js) reads
 * technicians.photo_url verbatim and renders <img src={photo_url}>.
 * A presigned S3 URL stored directly on the row would expire and
 * break the rendered image. Storing the bucket+key plus generating
 * the URL on every read is cleaner — the bucket stays private, the
 * served URL is always fresh, and the customer tracker doesn't need
 * to know about S3 at all.
 *
 * No auth: tech profile photos are already shown publicly via the
 * customer tracker (anyone with a /track/:token URL sees the assigned
 * tech's photo). De facto public; gating this proxy by an admin
 * token would break the customer tracker. The proxy URL is keyed by
 * technician_id (a UUID), so guessing valid IDs is computationally
 * infeasible.
 *
 * 404 cases:
 *   - tech_id doesn't match any row
 *   - the row exists but photo_s3_key is null (no photo set)
 *
 * 500 cases:
 *   - S3 not configured (bucket env var missing) — surfaces clearly
 *     instead of returning a broken image.
 */
const express = require('express');
const router = express.Router();
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('../models/db');
const config = require('../config');
const logger = require('../services/logger');

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

// 5-minute presigned URL is enough for the browser to follow the
// redirect and load the image. We don't want the URL to live too
// long in a tab's network log.
const PRESIGN_TTL_SECONDS = 300;

router.get('/:technicianId', async (req, res, next) => {
  try {
    const tech = await db('technicians')
      .where({ id: req.params.technicianId })
      .first('id', 'photo_s3_key');
    if (!tech || !tech.photo_s3_key) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    if (!config.s3?.bucket) {
      return res.status(500).json({ error: 'S3 not configured' });
    }
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: tech.photo_s3_key,
    }), { expiresIn: PRESIGN_TTL_SECONDS });
    return res.redirect(302, url);
  } catch (err) {
    logger.error(`[public-tech-photo] failed for ${req.params.technicianId}: ${err.message}`);
    next(err);
  }
});

module.exports = router;
