/**
 * Visit prep photos — dark server foundation (GATE_VISIT_PREP_PHOTOS).
 *
 * Customers attach photos + a short note to a SPECIFIC upcoming visit from
 * the public tokened appointment page (/appointment/:token) so the
 * technician sees them before the visit. This service owns eligibility,
 * validation, storage and the two tables (visit_prep_submissions,
 * visit_prep_photos) — server/routes/appointment-public.js is the only
 * caller today. Sends nothing to anyone.
 */

const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { visitPrepPhotosLive } = require('../config/feature-gates');
const { MAX_PHOTOS, MAX_PHOTO_BYTES } = require('../utils/request-photo-validation');
const { convertHeicToJpeg } = require('./heic-to-jpeg');
const { hashBuffer } = require('./service-report/photo-chain');
const { uploadFunnelPhotoToS3 } = require('../utils/funnel-photos');
const { isRecurringLineageVisit } = require('../utils/recurring-lineage');
// The same location-chip set the customer portal's service-request form
// uses (server/routes/requests.js) — reused rather than redefined, the same
// route-module-from-a-service pattern already used by several services
// (e.g. call-property-lookup.js, sms-template-renderer.js) so the two
// surfaces can never drift on the allowed set.
const { VALID_LOCATIONS: LOCATIONS } = require('../routes/requests');

const VISIT_PREP_LIMITS = {
  photosPerSubmission: MAX_PHOTOS, // 3 — shared cap with request-photo-validation
  photosPerVisit: 6,
  submissionsPerVisit: 3,
  maxPhotoBytes: MAX_PHOTO_BYTES, // 5MB — shared cap with request-photo-validation
  noteMaxChars: 500,
};

const TOPICS = ['pest', 'lawn', 'tree_shrub', 'other'];

// Strip any HTML-ish characters before storage — the same one-line
// convention every other free-text customer intake in this repo uses
// (routes/requests.js, routes/admin-requests.js, services/admin-cancellation.js).
function stripHtml(s) {
  return String(s || '').replace(/[<>]/g, '');
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// Canonicalize a declared/detected mime to the family it validates against
// (image/jpg == image/jpeg, image/heif == image/heic).
function mimeFamily(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpg') return 'image/jpeg';
  if (m === 'image/heif') return 'image/heic';
  return m;
}

// Magic-byte sniff — no shared helper in the repo covers HEIC (checked
// server/routes/admin-projects.js's unexported detectedImageMime, which
// only covers JPEG/PNG/GIF/WebP), so this is a small standalone function.
// Returns a canonical mime ('image/jpeg' | 'image/png' | 'image/webp' |
// 'image/heic') or null when the bytes don't match a supported format.
function detectedImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'image/png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii').toLowerCase().trim();
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

function isHeicFamily(mime) {
  return mimeFamily(mime) === 'image/heic';
}

function prepError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

// Same best-effort delete-on-rollback pattern as service-photos.js's
// deleteUploadedObject: a cleanup failure is logged, never thrown — the
// caller is already unwinding a failed request.
async function deleteUploadedObject(key) {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  } catch (err) {
    logger.warn(`[visit-prep] S3 cleanup failed key=${key}: ${err.message}`);
  }
}

// Eligible only when every one of these holds. `dispatchOwnedUnreviewed` is
// the caller's own verdict from appointment-public.js's dispatchOwnedUnreviewed(svc)
// — passed in rather than re-derived (or required cross-module, which would
// form a require cycle: that route is this service's only caller) so the
// rule is never duplicated.
function visitPrepEligibility({ svc, state, visitUnknown, dispatchOwnedUnreviewed = false } = {}) {
  if (!visitPrepPhotosLive()) return { eligible: false, reason: 'gate_off' };
  if (visitUnknown) return { eligible: false, reason: 'visit_unknown' };
  if (state !== 'upcoming') return { eligible: false, reason: 'not_upcoming' };
  if (!svc || svc.customer_active !== true) return { eligible: false, reason: 'customer_inactive' };
  if (!isRecurringLineageVisit(svc)) return { eligible: false, reason: 'one_time_visit' };
  if (dispatchOwnedUnreviewed) return { eligible: false, reason: 'dispatch_owned_unreviewed' };
  return { eligible: true, reason: null };
}

// Per-STOP counts: a grouped visit (svc.visit_id set) counts every
// submission/photo recorded against ANY member of that stop; an ungrouped
// row counts only its own scheduled_service_id. `conn` lets a caller pass a
// transaction so the locked cap re-count reads consistent data.
async function visitPrepSummary(svc, conn = db) {
  const scopeColumn = svc?.visit_id ? 'visit_id' : 'scheduled_service_id';
  const scopeValue = svc?.visit_id || svc?.id;

  const [submissionRow, photoRow] = await Promise.all([
    conn('visit_prep_submissions').where(scopeColumn, scopeValue).count('id as count').first(),
    conn('visit_prep_photos as p')
      .join('visit_prep_submissions as s', 'p.submission_id', 's.id')
      .where(`s.${scopeColumn}`, scopeValue)
      .count('p.id as count')
      .first(),
  ]);

  const photoCount = Number(photoRow?.count || 0);
  return {
    photoCount,
    photosRemaining: Math.max(0, VISIT_PREP_LIMITS.photosPerVisit - photoCount),
    submissionCount: Number(submissionRow?.count || 0),
  };
}

// Validate + normalize one multer memory file (magic-byte sniff against the
// declared mimetype, size cap, HEIC/HEIF -> JPEG conversion). Throws a
// prepError on any problem; returns the bytes to store.
async function prepareUploadFile(file) {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw prepError('One of the attached photos could not be read.', 400, 'PREP_INVALID_PHOTO');
  }
  if (buffer.length > VISIT_PREP_LIMITS.maxPhotoBytes) {
    throw prepError('Each photo must be 5 MB or smaller.', 413, 'PREP_PHOTO_TOO_LARGE');
  }
  const declared = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(declared)) {
    throw prepError('Photos must be JPEG, PNG, WebP, HEIC, or HEIF images.', 400, 'PREP_INVALID_PHOTO');
  }
  const detected = detectedImageMime(buffer);
  if (!detected || mimeFamily(declared) !== mimeFamily(detected)) {
    throw prepError('One of the attached photos is not a valid image.', 400, 'PREP_INVALID_PHOTO');
  }

  if (isHeicFamily(declared)) {
    let jpeg;
    try {
      jpeg = await convertHeicToJpeg(buffer);
    } catch {
      throw prepError('One of the attached photos could not be converted.', 400, 'PREP_INVALID_PHOTO');
    }
    return { buffer: jpeg, mimeType: 'image/jpeg' };
  }
  return { buffer, mimeType: mimeFamily(declared) };
}

/**
 * Create one prep submission for `svc` (the token's scheduled_services row,
 * with at least id/customer_id/property_id/visit_id selected).
 *
 * @param {object} opts
 * @param {object} opts.svc
 * @param {Array}  opts.files    multer memory files: [{ buffer, mimetype, size, originalname }]
 * @param {string} [opts.note]
 * @param {string} [opts.topic]
 * @param {string} [opts.locationOnProperty]
 * @param {string} opts.entry
 * @returns {Promise<{ created: boolean, summary: { photoCount, photosRemaining, submissionCount } }>}
 */
async function createVisitPrepSubmission({
  svc, files, note, topic, locationOnProperty, entry,
}) {
  if (!svc || !svc.id) throw prepError('Visit not found.', 404, 'PREP_NOT_FOUND');
  const fileList = Array.isArray(files) ? files : [];
  if (fileList.length < 1) {
    throw prepError('Attach at least one photo.', 400, 'PREP_INVALID_PHOTO');
  }
  if (fileList.length > VISIT_PREP_LIMITS.photosPerSubmission) {
    throw prepError(`Attach no more than ${VISIT_PREP_LIMITS.photosPerSubmission} photos.`, 400, 'PREP_INVALID_PHOTO');
  }
  if (topic != null && topic !== '' && !TOPICS.includes(topic)) {
    throw prepError('Unrecognized topic.', 400, 'PREP_INVALID_PHOTO');
  }
  if (locationOnProperty != null && locationOnProperty !== '' && !LOCATIONS.includes(locationOnProperty)) {
    throw prepError('Unrecognized location.', 400, 'PREP_INVALID_PHOTO');
  }
  const cleanNote = stripHtml(String(note || '').trim()).slice(0, VISIT_PREP_LIMITS.noteMaxChars) || null;

  // Cheap pre-check (unlocked) — the route also runs its own copy before
  // multer parses the body; this one guards a direct service caller too.
  const preSummary = await visitPrepSummary(svc);
  if (preSummary.submissionCount >= VISIT_PREP_LIMITS.submissionsPerVisit
    || preSummary.photoCount >= VISIT_PREP_LIMITS.photosPerVisit) {
    throw prepError("You've reached the photo limit for this visit.", 409, 'PREP_CAP_REACHED');
  }

  // Validate + normalize every file (sniff, size, HEIC convert) BEFORE any
  // upload — a rejected request never touches S3.
  const prepared = [];
  for (const file of fileList) {
    prepared.push(await prepareUploadFile(file));
  }

  // Dedupe against photos already stored for THIS scheduled_service_id, and
  // within this request, on the STORED (post-conversion) bytes.
  const existing = await db('visit_prep_photos').where({ scheduled_service_id: svc.id }).select('image_sha256');
  const existingHashes = new Set(existing.map((r) => r.image_sha256));
  const seen = new Set();
  const toStore = [];
  for (const p of prepared) {
    const sha256 = hashBuffer(p.buffer);
    if (existingHashes.has(sha256) || seen.has(sha256)) continue;
    seen.add(sha256);
    toStore.push({ ...p, sha256 });
  }

  if (toStore.length === 0) {
    // Every photo in the request already exists — idempotent double-submit:
    // write nothing, report the unchanged summary.
    return { created: false, summary: await visitPrepSummary(svc) };
  }

  // Storage MUST succeed for the request to succeed (the response tells the
  // customer the photos are attached) — best-effort is not acceptable here.
  const uploaded = [];
  try {
    for (const item of toStore) {
      const s3Key = await uploadFunnelPhotoToS3({
        rowId: svc.id,
        keyPrefix: 'visitprep',
        index: uploaded.length,
        mimeType: item.mimeType,
        base64: item.buffer.toString('base64'),
      });
      if (!s3Key) throw prepError('Photo storage is unavailable — try again shortly.', 503, 'PREP_STORAGE_UNAVAILABLE');
      uploaded.push({ ...item, s3Key });
    }
  } catch (err) {
    await Promise.all(uploaded.map((u) => deleteUploadedObject(u.s3Key)));
    throw err.statusCode ? err : prepError('Photo storage is unavailable — try again shortly.', 503, 'PREP_STORAGE_UNAVAILABLE');
  }

  try {
    await db.transaction(async (trx) => {
      // Locked re-count: the cheap pre-check above is advisory only.
      await trx('scheduled_services').where({ id: svc.id }).forUpdate().first('id');
      const locked = await visitPrepSummary(svc, trx);
      if (locked.submissionCount >= VISIT_PREP_LIMITS.submissionsPerVisit
        || locked.photoCount + uploaded.length > VISIT_PREP_LIMITS.photosPerVisit) {
        throw prepError("You've reached the photo limit for this visit.", 409, 'PREP_CAP_REACHED');
      }
      const [submission] = await trx('visit_prep_submissions').insert({
        scheduled_service_id: svc.id,
        visit_id: svc.visit_id || null,
        customer_id: svc.customer_id,
        property_id: svc.property_id || null,
        topic: topic || null,
        location_on_property: locationOnProperty || null,
        note: cleanNote,
        entry: String(entry || '').slice(0, 30) || 'appointment_page',
      }).returning('id');
      const submissionId = submission.id || submission;
      await trx('visit_prep_photos').insert(uploaded.map((u, index) => ({
        submission_id: submissionId,
        scheduled_service_id: svc.id,
        s3_key: u.s3Key,
        mime_type: u.mimeType,
        byte_size: u.buffer.length,
        image_sha256: u.sha256,
        photo_index: index,
      })));
    });
  } catch (err) {
    await Promise.all(uploaded.map((u) => deleteUploadedObject(u.s3Key)));
    throw err;
  }

  return { created: true, summary: await visitPrepSummary(svc) };
}

module.exports = {
  VISIT_PREP_LIMITS,
  TOPICS,
  LOCATIONS,
  isRecurringLineageVisit,
  visitPrepEligibility,
  visitPrepSummary,
  createVisitPrepSubmission,
  _internal: { detectedImageMime, mimeFamily, stripHtml, prepareUploadFile, deleteUploadedObject },
};
