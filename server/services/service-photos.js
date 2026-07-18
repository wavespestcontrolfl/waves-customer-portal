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
const { findBannedCustomerCopy } = require('./service-report/activity-indicators');

const SERVICE_PHOTO_PREFIX = 'service-photos/';
const STAGED_SERVICE_PHOTO_PREFIX = 'service-photo-staging/';
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

function sanitizeCustomerFacingPhotoCaption(value) {
  const caption = nullIfEmpty(value)?.slice(0, 200) || null;
  const violations = [...new Set(findBannedCustomerCopy(caption))];
  if (violations.length) {
    const err = new Error(
      `Photo caption contains wording we can't put on a customer report (${violations.join(', ')}).`
    );
    err.statusCode = 422;
    err.code = 'photo_caption_banned_copy';
    err.isOperational = true;
    err.violations = violations;
    throw err;
  }
  return caption;
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

async function cleanupUploadedServicePhotoObjects(photos = []) {
  const seen = new Set();
  let deleted = 0;
  for (const photo of photos || []) {
    const key = photo?.s3_key || photo?.storage_key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    await deleteUploadedObject(key);
    deleted += 1;
  }
  return { deleted };
}

function uniqueServicePhotoCount(photos = []) {
  const seen = new Set();
  for (const photo of photos || []) {
    const key = photo?.id || photo?.s3_key || photo?.storage_key;
    if (key) seen.add(String(key));
  }
  return seen.size;
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

async function uploadStagedServicePhotoBuffer({
  scheduledServiceId,
  technicianId,
  buffer,
  originalName,
  mimeType,
  photoType = 'progress',
  sortOrder = 0,
  caption,
  gpsLat,
  gpsLng,
  capturedAt,
  knex = db,
}) {
  if (!scheduledServiceId || !technicianId) {
    const err = new Error('scheduledServiceId and technicianId are required');
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
  if (!VALID_PHOTO_TYPES.has(photoType)) {
    const err = new Error(`Invalid photoType - must be one of: ${[...VALID_PHOTO_TYPES].join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  if (!config.s3?.bucket) {
    const err = new Error('S3 not configured');
    err.statusCode = 500;
    throw err;
  }

  const imageHash = hashBuffer(buffer);
  const existing = await knex('scheduled_service_photo_staging')
    .where({ scheduled_service_id: scheduledServiceId, image_sha256: imageHash })
    .first();
  if (existing) return existing;

  const filename = safePhotoName(originalName);
  const key = `${STAGED_SERVICE_PHOTO_PREFIX}${scheduledServiceId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'image/jpeg',
  }));

  try {
    const [row] = await knex('scheduled_service_photo_staging').insert({
      scheduled_service_id: scheduledServiceId,
      technician_id: technicianId,
      photo_type: photoType,
      s3_key: key,
      caption: nullIfEmpty(caption),
      sort_order: parseInt(sortOrder, 10) || 0,
      gps_lat: numberOrNull(gpsLat),
      gps_lng: numberOrNull(gpsLng),
      captured_at: dateOrNow(capturedAt),
      image_sha256: imageHash,
    }).returning('*');
    return row;
  } catch (err) {
    await deleteUploadedObject(key);
    if (err?.code === '23505') {
      return knex('scheduled_service_photo_staging')
        .where({ scheduled_service_id: scheduledServiceId, image_sha256: imageHash })
        .first();
    }
    throw err;
  }
}

async function promoteStagedServicePhotos({ scheduledServiceId, serviceRecordId, knex = db }) {
  if (!scheduledServiceId || !serviceRecordId) return [];
  return withPhotoDbTransaction(knex, async (trx) => {
    const staged = await trx('scheduled_service_photo_staging')
      .where({ scheduled_service_id: scheduledServiceId })
      .orderBy('captured_at', 'asc')
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .forUpdate();
    if (!staged.length) return [];

    const cols = await trx('service_photos').columnInfo();
    const returning = [
      'id', 'service_record_id', 'photo_type', 's3_key', 'storage_key',
      'caption', 'sort_order', 'gps_lat', 'gps_lng', 'captured_at',
      'image_sha256', 'hash_sha256', 'prev_hash_sha256', 'created_at',
    ].filter((column) => column === 'id' || cols[column]);
    let prevHash = cols.hash_sha256 && cols.prev_hash_sha256
      ? await latestPhotoHash(trx, serviceRecordId)
      : null;
    const appendingToExistingChain = !!prevHash;
    const promotedAt = Date.now();
    const promoted = [];

    for (let index = 0; index < staged.length; index += 1) {
      const photo = staged[index];
      const insert = {
        service_record_id: serviceRecordId,
        photo_type: photo.photo_type,
        s3_key: photo.s3_key,
        caption: sanitizeCustomerFacingPhotoCaption(photo.caption),
        sort_order: photo.sort_order || 0,
      };
      if (cols.storage_key) insert.storage_key = photo.s3_key;
      if (cols.gps_lat) insert.gps_lat = photo.gps_lat;
      if (cols.gps_lng) insert.gps_lng = photo.gps_lng;
      if (cols.captured_at) {
        // A completion/upload race can promote a true before photo after the
        // completion photos have already formed a chain. Keep late recovery
        // append-only so chronological validation uses the same order as the
        // hashes.
        insert.captured_at = appendingToExistingChain
          ? new Date(promotedAt + index)
          : photo.captured_at;
      }
      if (cols.image_sha256) insert.image_sha256 = photo.image_sha256;
      if (cols.prev_hash_sha256) insert.prev_hash_sha256 = prevHash;

      const [row] = await trx('service_photos').insert(insert).returning(returning);
      if (cols.hash_sha256 && cols.prev_hash_sha256) {
        const hash = hashPhotoChainPayload(row, prevHash);
        await trx('service_photos').where({ id: row.id }).update({ hash_sha256: hash });
        row.hash_sha256 = hash;
        prevHash = hash;
      }
      promoted.push(row);
    }

    await trx('scheduled_service_photo_staging')
      .where({ scheduled_service_id: scheduledServiceId })
      .del();
    return promoted;
  });
}

async function promoteStagedPhotosForCompletedVisit({ scheduledServiceId, knex = db }) {
  if (!scheduledServiceId) return null;
  const serviceRecord = await knex('service_records')
    .where({ scheduled_service_id: scheduledServiceId })
    .orderBy('created_at', 'desc')
    .first('id');
  if (!serviceRecord) return null;
  const photos = await promoteStagedServicePhotos({
    scheduledServiceId,
    serviceRecordId: serviceRecord.id,
    knex,
  });
  return { serviceRecordId: serviceRecord.id, photos };
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
  const uniqueUploaded = uniqueServicePhotoCount(rows);
  return {
    uploaded: rows.length,
    uniqueUploaded,
    failed: errors.length,
    errors,
    photos: rows,
  };
}

module.exports = {
  MAX_SERVICE_PHOTO_BYTES,
  MAX_COMPLETION_PHOTO_DATA_URL_BYTES,
  SERVICE_PHOTO_PREFIX,
  STAGED_SERVICE_PHOTO_PREFIX,
  VALID_PHOTO_TYPES,
  cleanupUploadedServicePhotoObjects,
  decodeDataUrlPhoto,
  sanitizeCustomerFacingPhotoCaption,
  safePhotoName,
  uniqueServicePhotoCount,
  uploadServicePhotoBuffer,
  uploadServicePhotoDataUrls,
  uploadStagedServicePhotoBuffer,
  promoteStagedServicePhotos,
  promoteStagedPhotosForCompletedVisit,
};
