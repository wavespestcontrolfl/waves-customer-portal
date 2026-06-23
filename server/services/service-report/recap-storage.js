// S3 storage for per-visit recap MP4s — mirrors pdf-storage.js (same client +
// config.s3). The video is streamed to the client through an authed endpoint
// (reusing getRecapVideo), never served from a public URL.
const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const fs = require('node:fs');
const config = require('../../config');
const logger = require('../logger');

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function assertConfigured() {
  if (!config.s3?.bucket) throw new Error('S3/R2 bucket not configured');
}

function recapStorageKey(serviceRecordId) {
  if (!serviceRecordId) throw new Error('serviceRecordId is required');
  return `recaps/${serviceRecordId}/visit-recap-v1.mp4`;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Upload an MP4 (from a local path produced by the renderer) and return its key.
async function putRecapFromFile(serviceRecordId, filePath) {
  assertConfigured();
  const key = recapStorageKey(serviceRecordId);
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: 'video/mp4',
    CacheControl: 'private, max-age=0, no-cache',
  }));
  return key;
}

async function headRecap(key) {
  if (!key) return null;
  assertConfigured();
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return { size: head.ContentLength || 0, contentType: head.ContentType || null, lastModified: head.LastModified || null };
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// Returns the S3 object body as a readable stream (for piping to the client) or null.
async function getRecapStream(key) {
  if (!key) return null;
  assertConfigured();
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return { body: object.Body, size: object.ContentLength || 0, contentType: object.ContentType || 'video/mp4' };
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    logger.warn(`[recap-storage] read failed for ${key}: ${err.message}`);
    return null;
  }
}

module.exports = { recapStorageKey, putRecapFromFile, headRecap, getRecapStream, streamToBuffer };
