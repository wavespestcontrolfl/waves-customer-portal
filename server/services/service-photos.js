const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const {
  hashBuffer,
  hashPhotoChainPayload,
  latestPhotoChainEntry,
} = require('./service-report/photo-chain');
const { findBannedCustomerCopy } = require('./service-report/activity-indicators');
const { normalizeTreeShrubPhotoSlot } = require('../config/tree-shrub-photo-slots');

const SERVICE_PHOTO_PREFIX = 'service-photos/';
const STAGED_SERVICE_PHOTO_PREFIX = 'service-photo-staging/';
const MAX_SERVICE_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_COMPLETION_PHOTO_DATA_URL_BYTES = 2 * 1024 * 1024;
const VALID_PHOTO_TYPES = new Set(['before', 'after', 'issue', 'progress']);
const SERVICE_PHOTO_VISIT_COLUMNS = [
  'id', 'customer_id', 'property_id', 'technician_id', 'service_id', 'service_type',
  'scheduled_date', 'status',
];

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

function visitDate(value) {
  if (value == null) return '';
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

function servicePhotoVisitSnapshot(visit) {
  if (!visit) return null;
  const identity = [
    String(visit.id ?? ''),
    String(visit.customer_id ?? ''),
    String(visit.property_id ?? ''),
    String(visit.technician_id ?? ''),
    String(visit.service_id ?? ''),
    String(visit.service_type ?? ''),
    visitDate(visit.scheduled_date),
  ];
  return {
    customerId: visit.customer_id ?? null,
    propertyId: visit.property_id ?? null,
    technicianId: visit.technician_id ?? null,
    catalogServiceId: visit.service_id ?? null,
    serviceType: visit.service_type ?? null,
    scheduledDate: visitDate(visit.scheduled_date),
    status: visit.status ?? null,
    // scheduled_services has no revision column. This opaque digest versions
    // only the fields that decide which visit/property owns the photo;
    // updated_at is intentionally excluded because unrelated visit writes
    // (including photo work) may touch it.
    revision: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24),
  };
}

function parseExpectedServicePhotoVisit(value) {
  if (value == null || value === '') return null;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = null; }
  }
  const keys = [
    'customerId', 'propertyId', 'technicianId', 'catalogServiceId', 'serviceType',
    'scheduledDate', 'status', 'revision',
  ];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || keys.some((key) => !(key in parsed))
    || typeof parsed.revision !== 'string') {
    const err = new Error('expectedVisit must be a complete visit snapshot');
    err.statusCode = 400;
    err.code = 'invalid_expected_visit';
    err.isOperational = true;
    throw err;
  }
  return parsed;
}

const sameVisitValue = (left, right) => String(left ?? '') === String(right ?? '');
const SERVICE_PHOTO_LIVE_STATUSES = new Set([
  'pending', 'confirmed', 'en_route', 'on_site', 'completed',
]);
function servicePhotoVisitChanged(expected, visit) {
  const live = servicePhotoVisitSnapshot(visit);
  // Lifecycle eligibility is authoritative even for older callers that omit
  // the optional identity snapshot.
  if (!SERVICE_PHOTO_LIVE_STATUSES.has(String(live.status || ''))) return true;
  if (!expected) return false;
  if (!sameVisitValue(expected.customerId, live.customerId)
    || !sameVisitValue(expected.propertyId, live.propertyId)
    || !sameVisitValue(expected.technicianId, live.technicianId)
    || !sameVisitValue(expected.catalogServiceId, live.catalogServiceId)
    || !sameVisitValue(expected.serviceType, live.serviceType)
    || visitDate(expected.scheduledDate) !== live.scheduledDate
    || expected.revision !== live.revision) return true;
  // Lifecycle can advance while a selected file is waiting or retrying. The
  // identity fields above still bind the bytes to the same visit; only a
  // cancelled/skipped/rescheduled or an unknown terminal state closes uploads.
  return false;
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

async function cleanupUploadedServicePhotoObjects(photos = [], { verifyAbsentWith = null } = {}) {
  const seen = new Set();
  let deleted = 0;
  for (const photo of photos || []) {
    const key = photo?.s3_key || photo?.storage_key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (verifyAbsentWith) {
      try {
        // One statement means one PostgreSQL snapshot. Two independent reads
        // can straddle a staging-to-gallery promotion and each miss the row,
        // making cleanup delete bytes that the gallery now references.
        const referenced = await verifyAbsentWith.raw(`
          SELECT EXISTS (
            SELECT 1 FROM service_photos WHERE s3_key = ?
            UNION ALL
            SELECT 1 FROM scheduled_service_photo_staging WHERE s3_key = ?
          ) AS referenced
        `, [key, key]);
        if (referenced.rows?.[0]?.referenced === true) continue;
      } catch (err) {
        // Retaining an unreferenced object is recoverable; deleting one whose
        // commit outcome could not be read is not.
        logger.warn(`[service-photos] commit cleanup verification failed key=${key}: ${err.message}`);
        continue;
      }
    }
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
  newlyUploadedObjects,
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
    // Hashed into the chain payload (photo-chain.js), so the hash computed
    // here must see the value the validator will read back.
    'ai_tags',
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
  let reusedExisting = false;

  try {
    await withPhotoDbTransaction(knex, async (trx) => {
      // Lock the completion record even when the photo collection is empty.
      // Promotion takes the same lock, so every chain append is serialized.
      await trx('service_records').where({ id: serviceRecordId }).forUpdate().first('id');
      if (imageHash) {
        row = await trx('service_photos')
          .where({ service_record_id: serviceRecordId, image_sha256: imageHash })
          .select(returning).first();
        if (row) { reusedExisting = true; return; }
      }
      const insert = {
        service_record_id: serviceRecordId,
        photo_type: photoType,
        s3_key: key,
        caption: nullIfEmpty(caption),
        sort_order: parseInt(sortOrder, 10) || 0,
      };
      const optionalValues = {
        storage_key: key, thumbnail_key: nullIfEmpty(thumbnailKey), state_badge: nullIfEmpty(stateBadge),
        zone_id: nullIfEmpty(zoneId), finding_id: nullIfEmpty(findingId),
        gps_lat: numberOrNull(gpsLat), gps_lng: numberOrNull(gpsLng), captured_at: captured,
        device: nullIfEmpty(device), app_version: nullIfEmpty(appVersion), ai_tags: parseJsonOrNull(aiTags),
        annotation: parseJsonOrNull(annotation), image_sha256: imageHash,
      };
      for (const [column, value] of Object.entries(optionalValues)) {
        if (servicePhotoCols[column]) insert[column] = value;
      }

      const canHashChain = servicePhotoCols.hash_sha256
        && servicePhotoCols.prev_hash_sha256
        && servicePhotoCols.captured_at;
      const tail = canHashChain ? await latestPhotoChainEntry(trx, serviceRecordId) : null;
      const prevHash = tail?.hash_sha256 || null;
      if (canHashChain) {
        insert.prev_hash_sha256 = prevHash;
        // A delayed request or camera-roll timestamp must append after the
        // committed tail, matching the chronological chain validator.
        const tailTime = new Date(tail?.captured_at || tail?.created_at || 0).getTime();
        insert.captured_at = new Date(Math.max(captured.getTime(), tailTime + 1));
      }

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

  if (reusedExisting) await deleteUploadedObject(key);
  else if (Array.isArray(newlyUploadedObjects)) newlyUploadedObjects.push({ s3_key: key });
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
  newlyUploadedObjects,
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
    if (Array.isArray(newlyUploadedObjects)) newlyUploadedObjects.push({ s3_key: key });
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

// One commit boundary for field-photo uploads. Locking scheduled_services
// before deciding between staging and service_photos closes both races that
// matter here: completion cannot pass the upload while it is staging, and a
// reassignment/reschedule cannot land after an unlocked ownership check but
// before the photo row is committed.
async function uploadServicePhotoForVisit({
  scheduledServiceId,
  actor,
  expectedVisit,
  expectedServiceRecordId,
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
  const expected = parseExpectedServicePhotoVisit(expectedVisit);
  const newlyUploadedObjects = [];
  return withPhotoDbTransaction(knex, async (trx) => {
    const visit = await trx('scheduled_services')
      .where({ id: scheduledServiceId })
      .forUpdate()
      .first(...SERVICE_PHOTO_VISIT_COLUMNS);
    if (!visit) {
      throw Object.assign(new Error('Service not found'), {
        statusCode: 404, code: 'service_not_found', isOperational: true,
      });
    }
    const { technicianVisitRowInScope } = require('./technician-visit-scope');
    if (!technicianVisitRowInScope(actor, visit)) {
      throw Object.assign(new Error('Not assigned to this service'), {
        statusCode: 403, code: 'not_assigned', isOperational: true,
      });
    }
    if (servicePhotoVisitChanged(expected, visit)) {
      throw Object.assign(new Error('This visit changed since the photo was selected. Reopen it and review the current visit.'), {
        statusCode: 409, code: 'visit_identity_changed', isOperational: true,
      });
    }

    const serviceRecordQuery = trx('service_records').where({
      scheduled_service_id: scheduledServiceId,
      ...(expectedServiceRecordId ? { id: expectedServiceRecordId } : {}),
    });
    if (!expectedServiceRecordId) serviceRecordQuery.orderBy('created_at', 'desc');
    const serviceRecord = await serviceRecordQuery.first('id');
    if (expectedServiceRecordId && !serviceRecord) {
      throw Object.assign(new Error('The completion record changed since photo recovery was saved.'), {
        statusCode: 409, code: 'visit_identity_changed', isOperational: true,
      });
    }
    if (serviceRecord) {
      const photo = await uploadServicePhotoBuffer({
        serviceRecordId: serviceRecord.id,
        buffer,
        originalName,
        mimeType,
        photoType,
        sortOrder,
        caption,
        thumbnailKey,
        stateBadge,
        zoneId,
        findingId,
        gpsLat,
        gpsLng,
        // A recovered attachment must append after the closeout chain.
        capturedAt: undefined,
        device,
        appVersion,
        aiTags,
        annotation,
        newlyUploadedObjects,
        knex: trx,
      });
      return {
        photo,
        staged: false,
        reconcileRequired: true,
        serviceRecordId: serviceRecord.id,
        visit: servicePhotoVisitSnapshot(visit),
      };
    }

    const photo = await uploadStagedServicePhotoBuffer({
      scheduledServiceId,
      technicianId: actor?.technicianId,
      buffer,
      originalName,
      mimeType,
      photoType,
      sortOrder,
      caption,
      gpsLat,
      gpsLng,
      capturedAt,
      newlyUploadedObjects,
      knex: trx,
    });
    return {
      photo,
      staged: true,
      reconcileRequired: false,
      serviceRecordId: null,
      visit: servicePhotoVisitSnapshot(visit),
    };
  }).catch(async (err) => {
    // The inner upload helpers can clean up insert-time failures, but their
    // success still precedes this outer transaction's commit. If that commit
    // rolls back, remove only objects created by this attempt; deduped rows
    // are deliberately absent from this list.
    // A driver can report a failed COMMIT after Postgres accepted it. Verify
    // from a fresh connection before deleting bytes, or that ambiguous result
    // can leave a committed photo row pointing at an object we just removed.
    const cleanupKnex = knex?.isTransaction ? db : knex;
    await cleanupUploadedServicePhotoObjects(newlyUploadedObjects, { verifyAbsentWith: cleanupKnex });
    throw err;
  });
}

async function promoteStagedServicePhotos({ scheduledServiceId, serviceRecordId, knex = db }) {
  if (!scheduledServiceId || !serviceRecordId) return [];
  return withPhotoDbTransaction(knex, async (trx) => {
    await trx('service_records').where({ id: serviceRecordId }).forUpdate().first('id');
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
    const tail = cols.hash_sha256 && cols.prev_hash_sha256
      ? await latestPhotoChainEntry(trx, serviceRecordId)
      : null;
    let prevHash = tail?.hash_sha256 || null;
    const appendingToExistingChain = !!prevHash;
    const promotedAt = Math.max(Date.now(), new Date(tail?.captured_at || tail?.created_at || 0).getTime() + 1);
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
      for (const [column, value] of Object.entries({ storage_key: photo.s3_key, gps_lat: photo.gps_lat, gps_lng: photo.gps_lng, image_sha256: photo.image_sha256, prev_hash_sha256: prevHash })) {
        if (cols[column]) insert[column] = value;
      }
      if (cols.captured_at) {
        // A completion/upload race can promote a true before photo after the
        // completion photos have already formed a chain. Keep late recovery
        // append-only so chronological validation uses the same order as the
        // hashes.
        insert.captured_at = appendingToExistingChain
          ? new Date(promotedAt + index)
          : photo.captured_at;
      }

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
      .whereIn('id', staged.map((photo) => photo.id))
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

// A photo taken before the visit is completed waits in staging; its
// technician (or an admin) can change its description or remove it from the
// notes box until the visit is completed (GATE_NOTE_BOX_PHOTOS, owner "ok go"
// 2026-10-02 on the Fast Complete mockup v8). Completion locks the visit row
// and promotes the staged photos into the record under that lock, so a change
// takes the same lock first: it lands before the completion reads the photo,
// or finds the visit completed and changes nothing.
const STAGED_PHOTO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function lockStagedPhotoForChange(trx, { scheduledServiceId, photoId, actor }) {
  if (!STAGED_PHOTO_ID_RE.test(String(scheduledServiceId)) || !STAGED_PHOTO_ID_RE.test(String(photoId))) {
    return { error: { status: 404, code: 'photo_not_found' } };
  }
  const visit = await trx('scheduled_services').where({ id: scheduledServiceId }).forUpdate().first('id', 'technician_id', 'status', 'scheduled_date');
  if (!visit) return { error: { status: 404, code: 'service_not_found' } };
  // The canonical current-assignment rule (own, not dead, inside the access
  // window), judged as a technician for every non-admin role (#5568 sweep).
  const { technicianVisitRowInScope } = require('./technician-visit-scope');
  if (actor?.techRole !== 'admin' && !technicianVisitRowInScope({ techRole: 'technician', technicianId: actor?.technicianId }, visit)) {
    return { error: { status: 403, code: 'not_assigned' } };
  }
  const record = await trx('service_records').where({ scheduled_service_id: scheduledServiceId }).first('id');
  if (record) return { error: { status: 409, code: 'visit_completed' } };
  const photo = await trx('scheduled_service_photo_staging')
    .where({ id: photoId, scheduled_service_id: scheduledServiceId })
    .forUpdate()
    .first();
  if (!photo) return { error: { status: 404, code: 'photo_not_found' } };
  return { photo };
}

async function updateStagedServicePhotoCaption({ scheduledServiceId, photoId, caption, actor, knex = db }) {
  const clean = sanitizeCustomerFacingPhotoCaption(caption);
  return withPhotoDbTransaction(knex, async (trx) => {
    const locked = await lockStagedPhotoForChange(trx, { scheduledServiceId, photoId, actor });
    if (locked.error) return locked;
    const [photo] = await trx('scheduled_service_photo_staging')
      .where({ id: photoId })
      .update({ caption: clean, updated_at: new Date() })
      .returning('*');
    return { photo };
  });
}

async function deleteStagedServicePhoto({ scheduledServiceId, photoId, actor, knex = db }) {
  const result = await withPhotoDbTransaction(knex, async (trx) => {
    const locked = await lockStagedPhotoForChange(trx, { scheduledServiceId, photoId, actor });
    if (locked.error) return locked;
    await trx('scheduled_service_photo_staging').where({ id: photoId }).del();
    return { photo: locked.photo };
  });
  // The file goes once its row is gone for good: a failed delete leaves an
  // orphaned file (logged), never a photo row pointing at nothing.
  if (result.photo?.s3_key) await deleteUploadedObject(result.photo.s3_key);
  return result;
}

// A Fast Complete slot key rides in ai_tags as { slot }, merged over any
// object tags the caller sent. Only a known key is stored; anything else is
// dropped, and the tags are left exactly as sent.
function withPhotoSlot(aiTags, slot) {
  const known = normalizeTreeShrubPhotoSlot(slot);
  if (!known) return aiTags;
  const parsed = parseJsonOrNull(aiTags);
  const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return { ...base, slot: known };
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
        aiTags: withPhotoSlot(photo.aiTags, photo.slot),
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
  uploadServicePhotoForVisit,
  uploadServicePhotoDataUrls,
  uploadStagedServicePhotoBuffer,
  parseExpectedServicePhotoVisit,
  servicePhotoVisitChanged,
  servicePhotoVisitSnapshot,
  updateStagedServicePhotoCaption,
  deleteStagedServicePhoto,
  promoteStagedServicePhotos,
  promoteStagedPhotosForCompletedVisit,
};
