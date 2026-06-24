// Tech-captured recap media (Pest Report V2 lane). Direct browser→S3 uploads via
// presigned PUT; the friendly customer caption is derived HERE from the tech's
// action `role` (never trusted from the client). getMediaForRecap maps ready rows
// to the composition's media[] slots (presigned GET srcs + beat role + caption).
const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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

// Formats a tech may upload. mp4/webm/jpeg/png/webp render straight into Remotion;
// iPhone-native HEVC/MOV + HEIC/HEIF are accepted too and TRANSCODED to mp4/jpg at
// render time (recap-transcode.ensureRenderable). Anything outside this set is
// rejected at upload. (Transcoding needs ffmpeg + libheif on the render host; if a
// clip can't be transcoded there it's gracefully dropped from that recap.)
const EXT_BY_CONTENT_TYPE = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heic',
};
const ACCEPTED_VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const ACCEPTED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
function extFor(contentType, mediaType) {
  return EXT_BY_CONTENT_TYPE[String(contentType || '').toLowerCase()] || (mediaType === 'image' ? 'jpg' : 'mp4');
}
function isAllowedContentType(contentType, mediaType) {
  const ct = String(contentType || '').toLowerCase();
  return mediaType === 'image' ? ACCEPTED_IMAGE.has(ct) : ACCEPTED_VIDEO.has(ct);
}

function assertConfigured() {
  if (!config.s3?.bucket) throw new Error('S3/R2 bucket not configured');
}

// Create the row + a presigned PUT URL the browser uploads to directly.
async function presignUpload({ scheduledServiceId, role, mediaType = 'video', contentType, capturedBy = null, knex = db } = {}) {
  assertConfigured();
  if (!scheduledServiceId) throw new Error('scheduledServiceId is required');
  const type = mediaType === 'image' ? 'image' : 'video';
  if (!isAllowedContentType(contentType, type)) {
    const err = new Error(type === 'image'
      ? 'Photo must be JPEG, PNG, WebP, or HEIC.'
      : 'Video must be MP4, WebM, or MOV.');
    err.status = 400;
    throw err;
  }
  const safeRole = ROLE_MAP[role] ? role : 'other';
  const info = roleInfo(safeRole);
  const key = `recap-media/${scheduledServiceId}/${crypto.randomBytes(10).toString('hex')}.${extFor(contentType, type)}`;
  const [row] = await knex('service_media').insert({
    scheduled_service_id: scheduledServiceId,
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

const RECAP_MAX_BYTES = 80 * 1024 * 1024; // ~80MB
const RECAP_MAX_DURATION_MS = 20000; // ~20s

// Verifies the uploaded object exists + is within limits using AUTHORITATIVE S3
// size (not the client-reported bytes, which can be spoofed/missing), then marks
// it ready. Oversized/missing objects are dropped (row + S3) and rejected, so they
// can never reach the renderer. Returns { ok, row } | { ok:false, reason }.
async function confirmUpload(mediaId, { scheduledServiceId = null, durationMs = null } = {}, knex = db) {
  const lookup = knex('service_media').where({ id: mediaId });
  if (scheduledServiceId) lookup.andWhere({ scheduled_service_id: scheduledServiceId });
  const row = await lookup.first();
  if (!row) return { ok: false, reason: 'not_found' };

  let realBytes = null;
  if (config.s3?.bucket) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: row.s3_key }));
      realBytes = Number(head.ContentLength) || 0;
    } catch { realBytes = null; }
  }
  if (realBytes == null) { await deleteMedia(mediaId, { scheduledServiceId }, knex); return { ok: false, reason: 'not_uploaded' }; }

  // Video must report a finite, in-range duration — a missing/null duration can't
  // be trusted as "short" (it would let an arbitrarily long clip under the byte cap
  // through to the renderer). Images carry no duration.
  const dur = Number(durationMs);
  const tooBig = realBytes > RECAP_MAX_BYTES;
  const badVideoDuration = row.media_type === 'video'
    && (!Number.isFinite(dur) || dur <= 0 || dur > RECAP_MAX_DURATION_MS);
  if (tooBig || badVideoDuration) {
    await deleteMedia(mediaId, { scheduledServiceId }, knex);
    return { ok: false, reason: (badVideoDuration && !tooBig) ? 'bad_duration' : 'too_large' };
  }

  const [updated] = await knex('service_media').where({ id: row.id }).update({
    status: 'ready', bytes: realBytes, duration_ms: durationMs, updated_at: new Date(),
  }).returning('*');
  return { ok: true, row: updated };
}

async function listMedia(scheduledServiceId, knex = db) {
  return knex('service_media')
    .where({ scheduled_service_id: scheduledServiceId })
    .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'created_at', order: 'asc' }])
    .select('id', 'media_type', 'role', 'caption', 'status', 'duration_ms', 'created_at');
}

async function deleteMedia(mediaId, { scheduledServiceId = null } = {}, knex = db) {
  const lookup = knex('service_media').where({ id: mediaId });
  if (scheduledServiceId) lookup.andWhere({ scheduled_service_id: scheduledServiceId });
  const row = await lookup.first();
  if (!row) return false;
  await knex('service_media').where({ id: row.id }).del();
  if (config.s3?.bucket && row.s3_key) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: row.s3_key })); }
    catch (err) { logger.warn(`[recap-media] S3 delete failed for ${row.s3_key}: ${err.message}`); }
  }
  return true;
}

// Ready media → the composition's media[] (presigned GET srcs, beat role, caption).
// Used by recap-payload at render time. Best-effort: returns [] on a missing table.
async function getMediaForRecap(scheduledServiceId, knex = db) {
  let rows;
  try {
    rows = await knex('service_media')
      .where({ scheduled_service_id: scheduledServiceId, status: 'ready' })
      .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'created_at', order: 'asc' }]);
  } catch (err) {
    if (err?.code === '42P01') return [];
    throw err;
  }
  if (!rows.length || !config.s3?.bucket) return [];
  const { ensureRenderable } = require('./recap-transcode');
  const out = [];
  for (const row of rows) {
    try {
      // iPhone HEVC/MOV + HEIC get transcoded to mp4/jpg here; renderable formats pass
      // through unchanged. A null means transcoding wasn't possible on this host — drop
      // the clip rather than feed Remotion something it can't decode.
      const renderKey = await ensureRenderable({ s3Key: row.s3_key, contentType: row.content_type, mediaType: row.media_type });
      if (!renderKey) continue;
      const src = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: config.s3.bucket, Key: renderKey,
      }), { expiresIn: 2 * 60 * 60 });
      out.push({ type: row.media_type === 'image' ? 'image' : 'video', src, role: roleInfo(row.role).beat, caption: row.caption || roleInfo(row.role).caption });
    } catch (err) {
      logger.warn(`[recap-media] presign GET failed for ${row.s3_key}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { ROLE_MAP, MEDIA_ROLE_IDS, roleInfo, presignUpload, confirmUpload, listMedia, deleteMedia, getMediaForRecap };
