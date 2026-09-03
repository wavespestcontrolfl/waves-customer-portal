/**
 * Signup evidence storage — uploads a Playwright submission screenshot to S3
 * (reusing the service-photos bucket + a backlink-evidence/ prefix) and returns a
 * durable object KEY for the seo_signup_attempts ledger; getEvidenceUrl() presigns
 * it on demand for the admin viewer. Fail-soft: no bucket / upload error → null
 * (the runner still records the attempt, just without evidence).
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../../config');
const logger = require('../logger');

const PREFIX = process.env.BACKLINK_EVIDENCE_PREFIX || 'backlink-evidence/';
let _s3 = null;

function client() {
  if (!config.s3 || !config.s3.bucket) return null;
  if (!_s3) {
    _s3 = new S3Client({
      region: config.s3.region,
      credentials: config.s3.accessKeyId ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } : undefined,
    });
  }
  return _s3;
}

function safeName(s) {
  return String(s || 'site').toLowerCase().replace(/[^a-z0-9.-]/g, '_').slice(0, 60);
}

async function uploadEvidence(buffer, domain, { ts = Date.now(), s3 = client() } = {}) {
  if (!s3 || !buffer || !buffer.length) return null;
  const key = `${PREFIX}${safeName(domain)}_${ts}.png`;
  try {
    await s3.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: buffer, ContentType: 'image/png' }));
    return key;
  } catch (err) {
    logger.warn(`[signup-evidence] upload failed for ${domain}: ${err.message}`);
    return null;
  }
}

async function getEvidenceUrl(key, { expiresIn = 604800, s3 = client() } = {}) {
  if (!s3 || !key) return null;
  try { return await getSignedUrl(s3, new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }), { expiresIn }); }
  catch { return null; }
}

module.exports = { uploadEvidence, getEvidenceUrl };
module.exports._internals = { safeName, PREFIX };
