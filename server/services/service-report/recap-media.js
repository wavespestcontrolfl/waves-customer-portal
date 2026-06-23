// Tech-captured recap media (Pest Report V2 lane). Direct browser→S3 uploads via
// presigned PUT; the friendly customer caption is derived HERE from the tech's
// action `role` (never trusted from the client). getMediaForRecap maps ready rows
// to the composition's media[] slots (presigned GET srcs + beat role + caption).
const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('../../models/db');
const config = require('../../config');
const logger = require('../logger');

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

// role (tech chip) → { caption (friendly, customer-facing), beat (composition slot) }.
// beat ∈ treating | pest | area | before | after. The composition slots treating/area
// into "what we did", pest into "what we found" (before/after reserved for a future
// progress beat — captured now, unused in the video until then).
const ROLE_MAP = {
  perimeter: { caption: 'Sealing your perimeter barrier', beat: 'treating' },
  eaves: { caption: 'Clearing the eaves up top', beat: 'treating' },
  entry: { caption: 'Protecting your doors & windows', beat: 'treating' },
  deweb: { caption: 'Knocking down webs up top', beat: 'treating' },
  sweep: { caption: 'Sweeping down your pool cage', beat: 'treating' },
  bait: { caption: 'Placing bait at the hot spots', beat: 'treating' },
  granule: { caption: 'Spreading granules across the yard', beat: 'treating' },
  inside: { caption: 'Treating along your baseboards', beat: 'treating' },
  foundation: { caption: 'Sealing the foundation & weep holes', beat: 'treating' },
  garage: { caption: 'Treating the garage', beat: 'treating' },
  shrubs: { caption: 'Treating the beds where pests hide', beat: 'treating' },
  dust: { caption: 'Getting into the cracks & crevices', beat: 'treating' },
  wasp: { caption: 'Removing a wasp nest', beat: 'treating' },
  acpad: { caption: 'Treating around the AC unit', beat: 'treating' },
  pest: { caption: 'Caught on camera at your home', beat: 'pest' },
  before: { caption: 'Before', beat: 'before' },
  after: { caption: 'After', beat: 'after' },
  other: { caption: 'On-site at your home', beat: 'area' },
};
const MEDIA_ROLE_IDS = Object.keys(ROLE_MAP);
const roleInfo = (role) => ROLE_MAP[role] || ROLE_MAP.other;

const EXT_BY_CONTENT_TYPE = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp',
};
function extFor(contentType, mediaType) {
  return EXT_BY_CONTENT_TYPE[String(contentType || '').toLowerCase()] || (mediaType === 'image' ? 'jpg' : 'mp4');
}
function isAllowedContentType(contentType, mediaType) {
  const ct = String(contentType || '').toLowerCase();
  return mediaType === 'image' ? ct.startsWith('image/') : ct.startsWith('video/');
}

function assertConfigured() {
  if (!config.s3?.bucket) throw new Error('S3/R2 bucket not configured');
}

// Create the row + a presigned PUT URL the browser uploads to directly.
async function presignUpload({ serviceRecordId, role, mediaType = 'video', contentType, capturedBy = null, knex = db } = {}) {
  assertConfigured();
  if (!serviceRecordId) throw new Error('serviceRecordId is required');
  const type = mediaType === 'image' ? 'image' : 'video';
  if (!isAllowedContentType(contentType, type)) {
    const err = new Error(`unsupported content type for ${type}`);
    err.status = 400;
    throw err;
  }
  const safeRole = ROLE_MAP[role] ? role : 'other';
  const info = roleInfo(safeRole);
  const key = `recap-media/${serviceRecordId}/${crypto.randomBytes(10).toString('hex')}.${extFor(contentType, type)}`;
  const [row] = await knex('service_media').insert({
    service_record_id: serviceRecordId,
    media_type: type,
    role: safeRole,
    caption: info.caption,
    s3_key: key,
    content_type: contentType || null,
    status: 'uploading',
    captured_by: capturedBy,
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('*');
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    ContentType: contentType || (type === 'image' ? 'image/jpeg' : 'video/mp4'),
  }), { expiresIn: 900 });
  return { mediaId: row.id, key, uploadUrl };
}

async function confirmUpload(mediaId, { bytes = null, durationMs = null } = {}, knex = db) {
  const [row] = await knex('service_media').where({ id: mediaId }).update({
    status: 'ready', bytes, duration_ms: durationMs, updated_at: new Date(),
  }).returning('*');
  return row || null;
}

async function listMedia(serviceRecordId, knex = db) {
  return knex('service_media')
    .where({ service_record_id: serviceRecordId })
    .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'created_at', order: 'asc' }])
    .select('id', 'media_type', 'role', 'caption', 'status', 'duration_ms', 'created_at');
}

async function deleteMedia(mediaId, knex = db) {
  const row = await knex('service_media').where({ id: mediaId }).first();
  if (!row) return false;
  await knex('service_media').where({ id: mediaId }).del();
  if (config.s3?.bucket && row.s3_key) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: row.s3_key })); }
    catch (err) { logger.warn(`[recap-media] S3 delete failed for ${row.s3_key}: ${err.message}`); }
  }
  return true;
}

// Ready media → the composition's media[] (presigned GET srcs, beat role, caption).
// Used by recap-payload at render time. Best-effort: returns [] on a missing table.
async function getMediaForRecap(serviceRecordId, knex = db) {
  let rows;
  try {
    rows = await knex('service_media')
      .where({ service_record_id: serviceRecordId, status: 'ready' })
      .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'created_at', order: 'asc' }]);
  } catch (err) {
    if (err?.code === '42P01') return [];
    throw err;
  }
  if (!rows.length || !config.s3?.bucket) return [];
  const out = [];
  for (const row of rows) {
    try {
      const src = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: config.s3.bucket, Key: row.s3_key,
      }), { expiresIn: 2 * 60 * 60 });
      out.push({ type: row.media_type === 'image' ? 'image' : 'video', src, role: roleInfo(row.role).beat, caption: row.caption || roleInfo(row.role).caption });
    } catch (err) {
      logger.warn(`[recap-media] presign GET failed for ${row.s3_key}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { ROLE_MAP, MEDIA_ROLE_IDS, roleInfo, presignUpload, confirmUpload, listMedia, deleteMedia, getMediaForRecap };
