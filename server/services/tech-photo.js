/**
 * Tech profile photo resolver. Single source of presign-on-read
 * logic for technicians.photo_s3_key.
 *
 * Pattern: a route that already authenticates its caller (admin,
 * track-token holder, etc.) calls resolveTechPhotoUrl(s3Key,
 * fallbackUrl) at response-build time. Returns:
 *   - a fresh presigned S3 URL when the tech has photo_s3_key (the
 *     canonical S3-managed reference set by
 *     POST /api/admin/timetracking/technicians/:id/photo)
 *   - the raw fallbackUrl when the tech doesn't have an S3-managed
 *     photo (e.g., legacy techs with photo_url pointing at Google
 *     Business or another external host)
 *   - null when neither exists
 *
 * Why no public unauthenticated proxy: PR #344 (Codex P0). Tech IDs
 * are not secrets — booking responses expose them — so a UUID-keyed
 * public endpoint would let anyone harvest IDs and pull every
 * tech's photo. Each consumer instead presigns inside its own
 * trusted-context boundary.
 *
 * TTL default 15 min: long enough for a single page render to fetch
 * the image, short enough that the URL doesn't linger usefully in
 * a tab's network log. Callers with longer-lived display contexts
 * (e.g., SMS-linked review pages with hours of dwell time) can pass
 * a larger ttlSeconds — but max it at 7 days (S3's signature limit).
 */
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const logger = require('./logger');

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

const DEFAULT_TTL_SECONDS = 15 * 60;

async function resolveTechPhotoUrl(s3Key, fallbackUrl, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!s3Key) return fallbackUrl || null;
  if (!config.s3?.bucket) return fallbackUrl || null;
  try {
    return await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
    }), { expiresIn: ttlSeconds });
  } catch (err) {
    logger.warn(`[tech-photo] presign failed for ${s3Key}: ${err.message}`);
    return fallbackUrl || null;
  }
}

module.exports = { resolveTechPhotoUrl };
