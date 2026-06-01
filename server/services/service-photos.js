const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const {
  hashBuffer,
  hashPhotoChainPayload,
  latestPhotoHash,
} = require('./service-report/photo-chain');

const SERVICE_PHOTO_PREFIX = 'service-photos/';
const MAX_SERVICE_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_COMPLETION_PHOTO_DATA_URL_BYTES = 2 * 1024 * 1024;
const VALID_PHOTO_TYPES = new Set(['before', 'after', 'issue', 'progress']);

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function nullIfEmpty(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJsonOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function dateOrNow(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function safePhotoName(value, fallback = 'service-photo.jpg') {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || fallback;
}

function decodeDataUrlPhoto(dataUrl, { maxBytes = MAX_SERVICE_PHOTO_BYTES } = {}) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    const err = new Error('Invalid photo data');
    err.statusCode = 400;
    throw err;
  }
  const mimeType = match[1] || 'image/jpeg';
  if (!String(mimeType).toLowerCase().startsWith('image/')) {
    const err = new Error('Photo must be an image');
    err.statusCode = 400;
    throw err;
  }
  const buffer = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  if (!buffer.length) {
    const err = new Error('Photo is empty');
    err.statusCode = 400;
    throw err;
  }
  if (buffer.length > maxBytes) {
    const err = new Error(`Photo exceeds ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
    err.statusCode = 413;
    throw err;
  }
  return { buffer, mimeType };
}

async function deleteUploadedObject(key) {
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
    }));
  } catch (err) {
    logger.warn(`[service-photos] S3 cleanup failed key=${key}: ${err.message}`);
  }
}

async function withPhotoDbTransaction(knex, handler) {
  if (knex?.isTransaction) return handler(knex);
  return knex.transaction(handler);
}

async function uploadServicePhotoBuffer({
  serviceRecordId,
  buffer,
  originalName,
  mimeType,
  photoType = 'progress',
  sortOrder = 0,
  caption,
  thumbnailKey,
  stateBadge,
  zoneId,
  findingId,
  gpsLat,
  gpsLng,
  capturedAt,
  device,
  appVersion,
  aiTags,
  annotation,
  knex = db,
}) {
  if (!serviceRecordId) {
    const err = new Error('serviceRecordId is required');
    err.statusCode = 400;
    throw err;
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error('Photo buffer is required');
    err.statusCode = 400;
    throw err;
  }
  if (buffer.length > MAX_SERVICE_PHOTO_BYTES) {
    const err = new Error('Photo exceeds 15MB limit');
    err.statusCode = 413;
    throw err;
  }
  if (!config.s3?.bucket) {
    const err = new Error('S3 not configured');
    err.statusCode = 500;
    throw err;
  }
  if (!VALID_PHOTO_TYPES.has(photoType)) {
    const err = new Error(`Invalid photoType - must be one of: ${[...VALID_PHOTO_TYPES].join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const servicePhotoCols = await knex('service_photos').columnInfo().catch(() => ({}));
  const captured = dateOrNow(capturedAt);
  const imageHash = servicePhotoCols.image_sha256 ? hashBuffer(buffer) : null;
  const returning = [
    'id',
    'service_record_id',
    'photo_type',
    's3_key',
    'storage_key',
    'caption',
    'sort_order',
    'state_badge',
    'zone_id',
    'captured_at',
    'image_sha256',
    'hash_sha256',
    'prev_hash_sha256',
    'created_at',
  ].filter((column) => column === 'id' || servicePhotoCols[column]);
  if (imageHash) {
    const existing = await knex('service_photos')
      .where({ service_record_id: serviceRecordId, image_sha256: imageHash })
      .select(returning)
      .first()
      .catch(() => null);
    if (existing) return existing;
  }

  const filename = safePhotoName(originalName);
  const key = `${SERVICE_PHOTO_PREFIX}${serviceRecordId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'image/jpeg',
  }));

  let row;

  try {
    await withPhotoDbTransaction(knex, async (trx) => {
      const insert = {
        service_record_id: serviceRecordId,
        photo_type: photoType,
        s3_key: key,
        caption: nullIfEmpty(caption),
        sort_order: parseInt(sortOrder, 10) || 0,
      };
      if (servicePhotoCols.storage_key) insert.storage_key = key;
      if (servicePhotoCols.thumbnail_key) insert.thumbnail_key = nullIfEmpty(thumbnailKey);
      if (servicePhotoCols.state_badge) insert.state_badge = nullIfEmpty(stateBadge);
      if (servicePhotoCols.zone_id) insert.zone_id = nullIfEmpty(zoneId);
      if (servicePhotoCols.finding_id) insert.finding_id = nullIfEmpty(findingId);
      if (servicePhotoCols.gps_lat) insert.gps_lat = numberOrNull(gpsLat);
      if (servicePhotoCols.gps_lng) insert.gps_lng = numberOrNull(gpsLng);
      if (servicePhotoCols.captured_at) insert.captured_at = captured;
      if (servicePhotoCols.device) insert.device = nullIfEmpty(device);
      if (servicePhotoCols.app_version) insert.app_version = nullIfEmpty(appVersion);
      if (servicePhotoCols.ai_tags) insert.ai_tags = parseJsonOrNull(aiTags);
      if (servicePhotoCols.annotation) insert.annotation = parseJsonOrNull(annotation);
      if (servicePhotoCols.image_sha256) insert.image_sha256 = imageHash;

      const canHashChain = servicePhotoCols.hash_sha256
        && servicePhotoCols.prev_hash_sha256
        && servicePhotoCols.captured_at;
      const prevHash = canHashChain ? await latestPhotoHash(trx, serviceRecordId) : null;
      if (canHashChain) insert.prev_hash_sha256 = prevHash;

      [row] = await trx('service_photos').insert(insert).returning(returning);
      if (canHashChain) {
        const hash = hashPhotoChainPayload(row, prevHash);
        await trx('service_photos').where({ id: row.id }).update({ hash_sha256: hash });
        row.hash_sha256 = hash;
      }
    });
  } catch (err) {
    await deleteUploadedObject(key);
    throw err;
  }

  return row;
}

async function uploadServicePhotoDataUrls({
  serviceRecordId,
  photos = [],
  photoType = 'after',
  maxBytes = MAX_COMPLETION_PHOTO_DATA_URL_BYTES,
  knex = db,
}) {
  const rows = [];
  const errors = [];
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index] || {};
    try {
      const decoded = decodeDataUrlPhoto(photo.data, { maxBytes });
      const row = await uploadServicePhotoBuffer({
        serviceRecordId,
        buffer: decoded.buffer,
        originalName: photo.name || `service-photo-${index + 1}.jpg`,
        mimeType: decoded.mimeType,
        photoType: photo.photoType || photoType,
        sortOrder: photo.sortOrder ?? index,
        caption: photo.caption,
        stateBadge: photo.stateBadge,
        zoneId: photo.zoneId,
        findingId: photo.findingId,
        capturedAt: photo.capturedAt,
        device: photo.device,
        appVersion: photo.appVersion,
        aiTags: photo.aiTags,
        annotation: photo.annotation,
        knex,
      });
      rows.push(row);
    } catch (err) {
      errors.push({
        index,
        message: err.message || 'Photo upload failed',
        statusCode: err.statusCode || null,
        code: err.code || null,
      });
    }
  }
  return {
    uploaded: rows.length,
    failed: errors.length,
    errors,
    photos: rows,
  };
}

module.exports = {
  MAX_SERVICE_PHOTO_BYTES,
  MAX_COMPLETION_PHOTO_DATA_URL_BYTES,
  SERVICE_PHOTO_PREFIX,
  VALID_PHOTO_TYPES,
  decodeDataUrlPhoto,
  safePhotoName,
  uploadServicePhotoBuffer,
  uploadServicePhotoDataUrls,
};
