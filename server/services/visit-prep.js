/**
 * Visit prep photos — dark server foundation (GATE_VISIT_PREP_PHOTOS).
 *
 * Customers attach photos + a short note to a SPECIFIC upcoming visit from
 * the public tokened appointment page (/appointment/:token) so the
 * technician sees them before the visit. This service owns eligibility,
 * validation, storage and the two tables (visit_prep_submissions,
 * visit_prep_photos) — server/routes/appointment-public.js is the only
 * caller today. Sends nothing to anyone.
 *
 * Two invariants from a pre-push audit of the first cut:
 * - The late `recheck` (persistLocked, below) runs on the WRITE's own
 *   transaction, never the global pool — the caller already holds a
 *   connection plus the stop's advisory lock, and a second global-pool
 *   query from inside that hold is how concurrent uploads exhaust the pool.
 * - Per-stop counts (visitPrepSummary/stopMemberIds) resolve CURRENT
 *   scheduled_services membership at read time. `visit_prep_submissions
 *   .visit_id` is written as a point-in-time record only — visit-groups can
 *   attach/detach/regroup rows after the fact, so it is NEVER read back for
 *   counting.
 */

const db = require('../models/db');
const logger = require('./logger');
const PhotoService = require('./photos');
const { visitPrepPhotosLive } = require('../config/feature-gates');
const { MAX_PHOTOS, MAX_PHOTO_BYTES } = require('../utils/request-photo-validation');
const sharp = require('sharp');
const { convertHeicToJpeg } = require('./heic-to-jpeg');
const { hashBuffer } = require('./service-report/photo-chain');
const { uploadFunnelPhotoToS3 } = require('../utils/funnel-photos');
const { isRecurringLineageVisit } = require('../utils/recurring-lineage');
const { TERMINAL_ROW_STATUSES } = require('./visit-context/statuses');
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

// Every accepted image is DECODED and re-encoded as JPEG through sharp
// (Codex r1 P2): a header sniff alone admits a truncated or pathological
// payload that the technician's browser then cannot render. Decoding also
// applies the EXIF orientation, drops the metadata (GPS included), and
// bounds the stored size. 25 MP matches the HEIC worker's own ceiling.
const MAX_INPUT_PIXELS = 25_000_000;
const MAX_STORED_EDGE_PX = 2560;
const STORED_JPEG_QUALITY = 85;

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

// Every error this module throws is marked `visitPrep: true` so the route's
// final handler can tell "our own, customer-safe message" apart from any
// other error that happens to carry a statusCode (which would otherwise
// leak an unrelated library message to an anonymous caller).
function prepError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.visitPrep = true;
  return err;
}

// Reuses the existing photo-delete authority (server/services/photos.js)
// instead of a second S3 client — wrapped so a cleanup failure is logged,
// never thrown: the caller is already unwinding a failed/duplicate request.
async function deleteUploadedObject(key) {
  if (!key) return;
  try {
    await PhotoService.deletePhoto(key);
  } catch (err) {
    logger.warn(`[visit-prep] S3 cleanup failed key=${key}: ${err.message}`);
  }
}

// Eligible only when every one of these holds. `dispatchOwnedUnreviewed` is
// the caller's own verdict from appointment-public.js's dispatchOwnedUnreviewed(svc)
// — passed in rather than re-derived (or required cross-module, which would
// form a require cycle: that route is this service's only caller) so the
// rule is never duplicated.
// `reserviceCallback`: the caller (reservice-public.js only) has already
// proved the row is this customer's pest/lawn re-service callback. A
// re-service is a standalone visit, so it is exempt from the recurring-plan
// rule below; every other condition still applies.
function visitPrepEligibility({
  svc, state, visitUnknown, dispatchOwnedUnreviewed = false, reserviceCallback = false,
} = {}) {
  if (!visitPrepPhotosLive()) return { eligible: false, reason: 'gate_off' };
  if (visitUnknown) return { eligible: false, reason: 'visit_unknown' };
  if (state !== 'upcoming') return { eligible: false, reason: 'not_upcoming' };
  if (!svc || svc.customer_active !== true) return { eligible: false, reason: 'customer_inactive' };
  if (reserviceCallback !== true && !isRecurringLineageVisit(svc)) return { eligible: false, reason: 'one_time_visit' };
  // `one_time` is the explicit not-a-series sentinel (the seeder, the
  // recurring-schedule audit and admin-schedule's plan alerts all refuse
  // it), but the shared lineage predicate reads any non-empty pattern as
  // recurring — so it is refused here, whatever else the row carries
  // (Codex #5176 r3 P0). Not folded into utils/recurring-lineage.js:
  // estimate-card-holds.js shares that predicate for card holds.
  if (reserviceCallback !== true && svc.recurring_pattern === 'one_time') return { eligible: false, reason: 'one_time_visit' };
  if (dispatchOwnedUnreviewed) return { eligible: false, reason: 'dispatch_owned_unreviewed' };
  return { eligible: true, reason: null };
}

// The ONE cap rule, applied only under the stop lock with the real number
// of NEW (post-dedupe) photos about to be inserted. Deliberately not
// pre-checked before the body is parsed: a retry of an already-stored
// submission on a visit that is now full must still resolve to the
// idempotent duplicate-only answer, which needs the photos in hand.
function capReached(summary, adding = 1) {
  return summary.submissionCount >= VISIT_PREP_LIMITS.submissionsPerVisit
    || summary.photoCount + adding > VISIT_PREP_LIMITS.photosPerVisit;
}

// The stop's CURRENT member scheduled_service_ids (Finding 2, pre-push
// audit): resolved fresh from scheduled_services on every call, never from
// visit_prep_submissions.visit_id — visit-groups can attach, detach, or
// regroup rows without touching old submissions, so reading the SNAPSHOTTED
// visit_id back would let photos silently drop off (or stay charged to) a
// stop that has since changed. A grouped visit (svc.visit_id set) counts
// every scheduled_services row CURRENTLY sharing that visit_id, in ANY
// status — deliberately not narrowed to live/open rows, so the cap stays
// conservative even for a member that just went en_route or terminal —
// always including svc.id itself (it may not have committed its own
// visit_id yet in a caller's in-memory copy); ungrouped, just [svc.id].
async function stopMemberIds(svc, conn) {
  if (!svc?.visit_id) return svc?.id ? [svc.id] : [];
  const rows = await conn('scheduled_services').where({ visit_id: svc.visit_id }).select('id');
  const ids = rows.map((r) => r.id);
  if (svc.id && !ids.includes(svc.id)) ids.push(svc.id);
  return ids;
}

// Per-STOP counts over the CURRENT member set (see stopMemberIds).
// `visit_prep_photos.scheduled_service_id` is denormalized specifically so
// this needs no join back through submissions. `conn` lets a caller pass a
// transaction so the locked cap re-count reads consistent data.
async function visitPrepSummary(svc, conn = db) {
  const ids = await stopMemberIds(svc, conn);
  if (ids.length === 0) {
    return { photoCount: 0, photosRemaining: VISIT_PREP_LIMITS.photosPerVisit, submissionCount: 0 };
  }

  const [submissionRow, photoRow] = await Promise.all([
    conn('visit_prep_submissions').whereIn('scheduled_service_id', ids).count('id as count').first(),
    conn('visit_prep_photos').whereIn('scheduled_service_id', ids).count('id as count').first(),
  ]);

  const photoCount = Number(photoRow?.count || 0);
  return {
    photoCount,
    photosRemaining: Math.max(0, VISIT_PREP_LIMITS.photosPerVisit - photoCount),
    submissionCount: Number(submissionRow?.count || 0),
  };
}

// Stage 1 — field normalization. topic/location failures are their own
// code (PREP_INVALID_FIELD), distinct from a bad photo.
function normalizeSubmissionFields({ topic, locationOnProperty, note }) {
  if (topic != null && topic !== '' && !TOPICS.includes(topic)) {
    throw prepError('Unrecognized topic.', 400, 'PREP_INVALID_FIELD');
  }
  if (locationOnProperty != null && locationOnProperty !== '' && !LOCATIONS.includes(locationOnProperty)) {
    throw prepError('Unrecognized location.', 400, 'PREP_INVALID_FIELD');
  }
  return {
    topic: topic || null,
    locationOnProperty: locationOnProperty || null,
    note: stripHtml(String(note || '').trim()).slice(0, VISIT_PREP_LIMITS.noteMaxChars) || null,
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

  let source = buffer;
  if (isHeicFamily(declared)) {
    try {
      source = await convertHeicToJpeg(buffer);
    } catch (err) {
      // Converter saturation is transient (Codex r1 P2): a valid photo must
      // come back retryable, never "invalid".
      if (err && err.code === 'HEIC_CAPACITY') {
        throw prepError('Our photo converter is busy — please try again in a moment.', 503, 'PREP_CONVERTER_BUSY');
      }
      throw prepError('One of the attached photos could not be converted.', 400, 'PREP_INVALID_PHOTO');
    }
  }
  return { buffer: await normalizeToJpeg(source), mimeType: 'image/jpeg' };
}

// Full decode + JPEG re-encode (see MAX_INPUT_PIXELS). Anything sharp
// cannot decode end to end — truncated data, an unsupported variant, more
// pixels than the ceiling — is refused as an invalid photo.
async function normalizeToJpeg(buffer) {
  try {
    return await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_STORED_EDGE_PX, height: MAX_STORED_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: STORED_JPEG_QUALITY })
      .toBuffer();
  } catch {
    throw prepError('One of the attached photos is not a valid image.', 400, 'PREP_INVALID_PHOTO');
  }
}

// Stage 2 — file preparation: count bounds, per-file validate/convert, hash
// (on the STORED, post-conversion bytes), and within-request dedupe (a
// customer picking the same photo twice in one submission folds to one).
// Pure/no I/O besides the per-file HEIC conversion — no DB, no S3.
async function prepareFiles(files) {
  const fileList = Array.isArray(files) ? files : [];
  if (fileList.length < 1) {
    throw prepError('Attach at least one photo.', 400, 'PREP_INVALID_PHOTO');
  }
  if (fileList.length > VISIT_PREP_LIMITS.photosPerSubmission) {
    throw prepError(`Attach no more than ${VISIT_PREP_LIMITS.photosPerSubmission} photos.`, 400, 'PREP_INVALID_PHOTO');
  }
  const prepared = [];
  const seen = new Set();
  for (const file of fileList) {
    const item = await prepareUploadFile(file);
    const sha256 = hashBuffer(item.buffer);
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    prepared.push({ ...item, sha256 });
  }
  return prepared;
}

// Stage 3 — upload all-or-clean-up. Storage MUST succeed for the request to
// succeed (the response tells the customer the photos are attached) — a
// failure deletes whatever this call already uploaded and throws.
async function uploadAll(scheduledServiceId, prepared) {
  const uploaded = [];
  try {
    for (const item of prepared) {
      const s3Key = await uploadFunnelPhotoToS3({
        rowId: scheduledServiceId,
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
    throw err.visitPrep ? err : prepError('Photo storage is unavailable — try again shortly.', 503, 'PREP_STORAGE_UNAVAILABLE');
  }
  return uploaded;
}

// Stage 4 — the locked persist, run as the callback under the canonical
// stop lock (withStopLock below). Rechecks eligibility on FRESH state,
// dedupes against the DB under the lock, re-checks the cap under the lock,
// then inserts. `dropped` (DB-duplicate photos found under the lock) is
// returned so the caller can delete their already-uploaded objects.
async function persistLocked(trx, {
  uploaded, recheck, topic, locationOnProperty, note, entry,
}) {
  // Called with OUR OWN transaction (Finding 1, pre-push audit) — recheck
  // must do every read on this connection, never the global pool, or two
  // concurrent locked writers can exhaust the pool waiting on each other's
  // recheck while each already holds a connection plus the stop lock.
  const current = await recheck(trx);
  // Same generic 404 an unknown token gets (Codex r1 P0): an ineligible
  // visit is never distinguishable from no visit at all on this route.
  if (!current) throw prepError('Not found', 404, 'PREP_NOT_FOUND');

  const existing = await trx('visit_prep_photos').where({ scheduled_service_id: current.id }).select('image_sha256');
  const existingHashes = new Set(existing.map((r) => r.image_sha256));
  const toStore = uploaded.filter((u) => !existingHashes.has(u.sha256));
  const dropped = uploaded.filter((u) => existingHashes.has(u.sha256));

  if (toStore.length === 0) {
    await preserveResubmittedFields(trx, current, dropped[0], { topic, locationOnProperty, note });
    return { created: false, stored: 0, dropped, current, summary: await visitPrepSummary(current, trx) };
  }

  const locked = await visitPrepSummary(current, trx);
  if (capReached(locked, toStore.length)) {
    throw prepError("You've reached the photo limit for this visit.", 409, 'PREP_CAP_REACHED');
  }

  const [submission] = await trx('visit_prep_submissions').insert({
    scheduled_service_id: current.id,
    // Recorded as a snapshot of the stop at submission time ONLY — never
    // read back for counting (Finding 2, pre-push audit; see
    // visitPrepSummary/stopMemberIds above, which resolve current
    // membership from scheduled_services instead).
    visit_id: current.visit_id || null,
    customer_id: current.customer_id,
    property_id: current.property_id || null,
    topic,
    location_on_property: locationOnProperty,
    note,
    entry: String(entry || '').slice(0, 30) || 'appointment_page',
  }).returning('id');
  const submissionId = submission.id || submission;
  await trx('visit_prep_photos').insert(toStore.map((u, index) => ({
    submission_id: submissionId,
    scheduled_service_id: current.id,
    s3_key: u.s3Key,
    mime_type: u.mimeType,
    byte_size: u.buffer.length,
    image_sha256: u.sha256,
    photo_index: index,
  })));

  // Counts come from THIS transaction (Codex r1 P2): a post-commit read
  // that failed would 500 a request whose photos were already durably
  // stored and invite a retry of a write that had succeeded.
  // `submissionId` + `photos` (S3 key/mime only, never the buffers) ride
  // out so the caller can trigger PR 5's fire-and-forget pest read AFTER
  // this transaction commits — never from in here (see the file header:
  // no I/O from inside the stop lock beyond this write's own).
  return {
    created: true,
    stored: toStore.length,
    dropped,
    current,
    summary: await visitPrepSummary(current, trx),
    submissionId,
    photos: toStore.map((u) => ({ s3Key: u.s3Key, mimeType: u.mimeType })),
  };
}

// A resubmit of already-stored photos carrying a corrected or newly added
// note/topic/location (Codex r1 P2): there is no separate note endpoint, so
// the submitted fields ride the submission that owns the first duplicate
// photo. Non-empty submitted values overwrite; empty ones leave the record
// alone.
async function preserveResubmittedFields(trx, current, duplicate, { topic, locationOnProperty, note }) {
  const patch = {};
  if (note) patch.note = note;
  if (topic) patch.topic = topic;
  if (locationOnProperty) patch.location_on_property = locationOnProperty;
  if (!Object.keys(patch).length || !duplicate) return;
  const owner = await trx('visit_prep_photos')
    .where({ scheduled_service_id: current.id, image_sha256: duplicate.sha256 })
    .first('submission_id');
  if (!owner) return;
  await trx('visit_prep_submissions').where({ id: owner.submission_id }).update(patch);
}

// Runs `fn(trx)` under the CANONICAL stop lock (visit-groups.js's
// lockStopForRow — the same advisory lock every other stop writer takes),
// retrying its peek->lock->verify VISIT_STOP_MOVED race up to 2 times, the
// same retry shape as appointment-public.js's own underStopLock. Not
// shared directly: that route requires this service, so importing its
// helper back would form a require cycle — this is a deliberately minimal
// local copy of just the retry loop, not the route's other logic.
// Customer row BEFORE the stop lock: createOrJoinVisit takes the customer
// (FOR NO KEY UPDATE) and then the stop advisory lock, so taking them the
// other way round here could deadlock a booking against an upload (Codex
// #5306 r2 P2). FOR SHARE keeps a deactivation or delete waiting until the
// submission commits; the caller's recheck re-reads the row under it.
async function withStopLock(svcId, fn, { customerId = null } = {}) {
  const { lockStopForRow } = require('./visit-groups');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (trx) => {
        if (customerId) await trx('customers').where({ id: customerId }).forShare().first('id');
        const locked = await lockStopForRow(trx, svcId);
        if (locked === null) throw prepError('Not found', 404, 'PREP_NOT_FOUND');
        return fn(trx);
      });
    } catch (err) {
      if (err && err.code === 'VISIT_STOP_MOVED') {
        if (attempt < 2) continue;
        throw prepError('Not found', 404, 'PREP_NOT_FOUND');
      }
      throw err;
    }
  }
}

/**
 * Create one prep submission for `svc` (the token's scheduled_services row
 * as read BEFORE the lock — used only to seed the upload's S3 folder and
 * the unlocked stages; every DB write uses `recheck`'s fresh row instead).
 *
 * @param {object} opts
 * @param {object} opts.svc
 * @param {Array}  opts.files    multer memory files: [{ buffer, mimetype, size, originalname }]
 * @param {string} [opts.note]
 * @param {string} [opts.topic]
 * @param {string} [opts.locationOnProperty]
 * @param {string} opts.entry
 * @param {(trx: object) => Promise<object|null>} opts.recheck  called under
 *   the stop lock WITH THAT TRANSACTION (never the global pool — see the
 *   file header); must return the CURRENT eligible visit row (same shape as
 *   `svc`, at least id/customer_id/property_id/visit_id) or null when the
 *   visit is no longer eligible. REQUIRED — the caller (appointment-public.js)
 *   owns the eligibility rule and must not let this service go stale.
 * @returns {Promise<{ created: boolean, stored: number, summary: { photoCount, photosRemaining, submissionCount }, svc: object }>}
 *   `stored` = NEW photos this request stored (0 for an all-duplicate resubmit).
 *   `svc` is the RECHECKED row (`recheck`'s own return value, read fresh
 *   under the stop lock) — additive, for callers (the office feed item)
 *   that must not build off the stale pre-lock row a caller passed in: the
 *   visit can be rescheduled between the pre-lock read and the locked
 *   write, and the pre-lock `svc` argument is never mutated to match.
 */
async function createVisitPrepSubmission({
  svc, files, note, topic, locationOnProperty, entry, recheck,
}) {
  if (!svc || !svc.id) throw prepError('Visit not found.', 404, 'PREP_NOT_FOUND');
  if (typeof recheck !== 'function') throw new Error('createVisitPrepSubmission requires a recheck function');

  const fields = normalizeSubmissionFields({ topic, locationOnProperty, note });
  const prepared = await prepareFiles(files);

  const uploaded = await uploadAll(svc.id, prepared);

  let result;
  try {
    result = await withStopLock(svc.id, (trx) => persistLocked(trx, { uploaded, recheck, ...fields, entry }), {
      customerId: svc.customer_id || null,
    });
  } catch (err) {
    await Promise.all(uploaded.map((u) => deleteUploadedObject(u.s3Key)));
    throw err;
  }
  // Duplicates discovered under the lock were never persisted either way —
  // their already-uploaded objects are cleaned up regardless of outcome.
  await Promise.all(result.dropped.map((u) => deleteUploadedObject(u.s3Key)));

  // Tech card + push (PR 6, scope doc §5.4 item 4) — post-commit,
  // fire-and-forget, never awaited: the module owns its own gate and
  // swallows every error itself, so this can never block or fail the
  // customer's request. Only for a submission that stored something new
  // (never a duplicate-only resubmit).
  if (result.created) {
    try {
      require('./visit-prep-tech-alert').notifyTechVisitPrepPhotos({
        scheduledServiceId: result.current.id,
      }).catch((err) => logger.error(`[visit-prep] tech alert failed for ${result.current.id}: ${err.message}`));
    } catch (err) {
      logger.error(`[visit-prep] tech alert could not start for ${result.current.id}: ${err.message}`);
    }
  }

  // PR 5 — automatic photo read (GATE_VISIT_PREP_PEST_READ,
  // GATE_VISIT_PREP_PLANT_READ). ONE dispatch (visit-prep-read-dispatch.js)
  // picks the single engine for the stop, so the photos are downloaded once
  // (Codex #5320 r9). This is THE
  // single place a submission is created (both today's public
  // appointment-page POST and the upcoming customer-auth app route call
  // through here), so hooking it here — rather than in either route —
  // means every entry point inherits it with no extra wiring. Fired
  // AFTER `result` above (withStopLock's db.transaction has already
  // resolved, so the submission is durably committed), fire-and-forget:
  // never awaited, so a slow or failing vision call can never add latency
  // to, or fail, the customer's own upload response. Only for a NEW
  // submission (`result.created`) — an all-duplicate resubmit stored
  // nothing new to read. A lazy require keeps the v2 engines (and the
  // catalogs they load) out of every caller of this module that
  // never actually creates a submission.
  // Gate first, and the engine module (catalog + validators, built at load)
  // is required only on the next tick, never on this response path
  // (Codex #5305 r3 P2). The upload is already committed: a failure to load
  // or start the read is logged, never a 500 to the customer.
  const gatesNow = require('../config/feature-gates');
  if (result.created && (gatesNow.visitPrepPestReadLive() || gatesNow.visitPrepPlantReadLive())) {
    const readArgs = { submissionId: result.submissionId, svc: result.current, photos: result.photos };
    setImmediate(() => {
      try {
        require('./visit-prep-read-dispatch').dispatchVisitPrepRead(readArgs)
          .catch((err) => logger.error(`[visit-prep] read dispatch failed for submission ${readArgs.submissionId}: ${err.message}`));
      } catch (err) {
        logger.error(`[visit-prep] read could not start for submission ${readArgs.submissionId}: ${err.message}`);
      }
    });
  }

  return { created: result.created, stored: result.stored, summary: result.summary, svc: result.current };
}

// ── Technician Visit Brief surface (PR 3a) ──────────────────────────────────
// Two new, self-contained reads consumed by previsit-brief.js's
// deterministicVisitFacts (facts.customerFlagged) and by
// admin-schedule.js's GET /:id/visit-prep-photos. Neither touches any of
// the write path above; both resolve the stop from CURRENT scheduled_services
// rows through techStopMemberIds (below) — NEVER a submission's own
// snapshotted visit_id (see the file header).

// The stop AS IT STANDS for whoever holds `svc`: the member set for the
// two tech-facing reads below. A frozen visit keeps visit_id on a member
// dispatch reassigned or moved (handleChildStopChanged preserves
// membership), so `stopMemberIds` can include rows that are now someone
// else's stop or a second physical stop. The caller authorized `svc` only,
// so a member counts only while:
// - it is on svc's CURRENT technician (Codex #5239 r1 P1); and
// - it is still at the visit's physical stop by the canonical grouping rule,
//   `visit-groups.js` `rowStillAtVisitStop` (same date, customer and property,
//   and a window that overlaps the live members still at the stop; Codex
//   #5239 r4 P2: a member moved to a non-overlapping window on the same day
//   is a second stop).
// The requested row is re-read by id (Codex #5239 r3 P2), so a row detached
// or regrouped mid-request resolves its CURRENT stop, and a requested row no
// longer at its visit's stop resolves to itself. Status does not matter for
// a candidate: a cancelled service at the same technician's same stop is the
// same customer's visit and nobody else sees it. `stopMemberIds` keeps its
// wider set for the customer-side cap counts, which are about the visit, not
// access.
async function techStopMemberIds(svc, conn) {
  if (!svc?.id) return [];
  const cols = ['id', 'visit_id', 'technician_id', 'customer_id', 'property_id',
    'scheduled_date', 'window_start', 'window_end', 'status'];
  const anchor = await conn('scheduled_services').where({ id: svc.id }).first(...cols);
  if (!anchor) return [];
  if (!anchor.visit_id) return [anchor.id];
  const [visit, rows] = await Promise.all([
    conn('service_visits').where({ id: anchor.visit_id })
      .first('id', 'customer_id', 'property_id', 'scheduled_date', 'window_start', 'window_end'),
    conn('scheduled_services').where({ visit_id: anchor.visit_id }).select(...cols),
  ]);
  if (!visit) return [anchor.id];
  const { rowStillAtVisitStop } = require('./visit-groups');
  // Same inputs the grouping code uses: the row against the visit, anchored
  // on the OTHER members that are still live.
  const atStop = (row) => rowStillAtVisitStop(row, visit, rows.filter((m) => String(m.id) !== String(row.id)
    && !TERMINAL_ROW_STATUSES.includes(m.status)));
  if (!atStop(anchor)) return [anchor.id];
  const techKey = anchor.technician_id == null ? null : String(anchor.technician_id);
  const others = rows.filter((r) => String(r.id) !== String(anchor.id)
    && (r.technician_id == null ? null : String(r.technician_id)) === techKey
    && atStop(r));
  return [anchor.id, ...others.map((r) => r.id)];
}

// Re-resolves the stop AFTER the read/signing work and returns the member
// ids still on it (Codex #5239 r2 P1). A sibling reassigned or moved while
// the notes were read or the URLs signed drops out here, so neither read
// returns data from a row that left this technician's stop mid-request;
// the routes then recheck the requested row itself, as before.
async function stillOnTechStop(svc, conn) {
  return new Set((await techStopMemberIds(svc, conn)).map(String));
}

// Short-lived signed VIEW urls for every photo on the stop's CURRENT
// membership — same TTL as the technician's own service photos
// (GET /api/tech/services/:id/photos, tech-track.js: getSignedUrl(...,
// { expiresIn: 3600 })), not the 24h PhotoService.CUSTOMER_DWELL_TTL_SECONDS
// (that TTL is for a customer-facing tokenized page's in-page dwell, not a
// staff-authenticated one-shot fetch). Authorization is entirely the
// caller's job — admin-schedule.js's GET /:id/visit-prep-photos mirrors
// GET /:id/visit-brief's own ownership scoping + reassignment recheck
// before and after calling this; this function trusts `svc` as already
// authorized for the read.
const TECH_PHOTO_VIEW_TTL_SECONDS = 3600;

async function stopPhotoViewUrls(svc, conn = db) {
  const ids = await techStopMemberIds(svc, conn);
  if (ids.length === 0) return [];
  const photos = await conn('visit_prep_photos')
    .whereIn('scheduled_service_id', ids)
    .orderBy('submission_id', 'asc')
    .orderBy('photo_index', 'asc')
    .select('id', 'submission_id', 'scheduled_service_id', 's3_key');
  const signed = await Promise.all(photos.map(async (p) => ({
    scheduledServiceId: p.scheduled_service_id,
    id: p.id,
    submissionId: p.submission_id,
    url: await PhotoService.getViewUrl(p.s3_key, TECH_PHOTO_VIEW_TTL_SECONDS),
  })));
  const current = await stillOnTechStop(svc, conn);
  return signed
    .filter((p) => current.has(String(p.scheduledServiceId)))
    .map(({ scheduledServiceId, ...photo }) => photo);
}

function parseJsonMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// The `read` object attached to each facts.customerFlagged entry (PR 5,
// GATE_VISIT_PREP_PEST_READ) — built ONLY from FIXED engine fields, never
// free model prose: the wording tier (a fixed enum:
// pretty_sure/likely/group_only/unknown), an APPROVED catalog common name
// (photo-id-v2/pest-engine.js's buildEntryBlock only ever sets `entry` to
// an approved, reviewed species — see its `entryLevelAnswer` gate), the
// matched/still-needed trait strings the catalog itself authored
// (v2.evidence.matches/still_need), a referral kind, and the fixed boolean
// hazard flags (`safety.{stinging,venomous,disease_vector,
// structural_threat}` — the SAME v1SafetyFallback shape pest-engine.js's
// mapToV1 already computes for every named/generic/legacy answer). No
// product or rate guidance rides here — that stays out of this lane
// entirely (protocols.json, the tree & shrub field guide). `contract` is
// the stored pest_identifications.report_contract (v1 shape + embedded
// `v2`), the SAME JSON shape the customer Photo ID route stores.
// A read runs in-process after the submission commits; a redeploy or
// crash mid-read would otherwise leave 'pending' on the row forever. A
// read still pending this long after it was CLAIMED (read_claimed_at; the
// submission time for rows claimed before that column) is shown as failed
// (quiet) instead of "Photo read pending" — timed from the claim so a read
// the recovery sweep starts long after the photos arrived stays pending
// while it runs (Codex #5320 r10 P2).
const READ_PENDING_STALE_MS = 15 * 60 * 1000;

function effectiveReadStatus(status, createdAt, now = Date.now(), claimedAt = null) {
  if (status !== 'pending') return status;
  const from = claimedAt || createdAt;
  const at = from instanceof Date ? from.getTime() : new Date(from).getTime();
  return Number.isFinite(at) && now - at > READ_PENDING_STALE_MS ? 'failed' : status;
}

// How the engine's answer is named, most specific first: an approved
// species (entry), else its catalog group label (pest-engine.js
// groupBlockFor), else for a category-level climb the engine's fixed
// headline template ("Looks like <generic>", climbedOrDisagreedAnswer).
// Never model text.
function answerName(v2) {
  if (v2.entry) return { commonName: v2.entry.common_name || null, groupLabel: null, groupHeadline: null };
  const groupLabel = v2.group?.label || null;
  const groupHeadline = !groupLabel && v2.answer?.wording === 'group_only' ? (v2.answer.headline || null) : null;
  return { commonName: null, groupLabel, groupHeadline };
}

const asList = (value) => (Array.isArray(value) ? value : []);

// The plant sibling of readFactsFromContract, for a DONE row produced by
// GATE_VISIT_PREP_PLANT_READ (visit-prep-plant-read.js) — built ONLY from
// fixed engine/catalog fields, the same discipline: a wording tier (a fixed
// enum), APPROVED catalog common names (the identified turf/plant species,
// and the named condition when the workup names one), the catalog's own
// `fits`/`not_yet` strings for the top possibility (plant-engine.js
// visibleStringsFor/notYetFor — catalog-authored text, not model prose),
// a fixed next-step template, a referral kind, and the catalog's own
// `safety_line`/boolean safety flags. No product or rate guidance.
// `resultRow` is the parsed `read_result` jsonb ({ v2, internal,
// subject_type }) — the SAME split (v2 customer/tech-safe, internal
// admin-only) the pest read keeps, just stored together since nothing else
// ever reads this column back. Carries `kind: 'plant'` so the tech UI can
// tell it apart from a pest read's shape — an ADDITIVE field, never added
// to readFactsFromContract's own pest shape (an existing, tested contract).
// The top possibility and the workup's identified plant — both optional,
// normalized to plain objects once here so the fields below read them with
// ordinary dot access instead of a repeated chain of `?.`s (kept complexity
// low; split out of plantReadFactsFromResult for the same reason
// answerName() is split out of readFactsFromContract above).
// Which engine made a claimed read: the plant and combo reads keep an engine
// marker in read_result from their claim on; a claimed row without one is the
// pest read's. Unclaimed rows (none / unsupported) have no origin.
function readOrigin(readStatus, plantResult) {
  if (!['pending', 'done', 'failed'].includes(readStatus)) return null;
  if (plantResult && plantResult.engine === 'combo') return 'combo';
  return plantResult && (plantResult.engine === 'plant' || plantResult.v2) ? 'plant' : 'pest';
}

// Every catalog safety line the read carries (the identified plant, each
// named weed, each condition possibility), deduplicated, so a warning on
// the plant is never dropped for one on the top condition (Codex #5320 r1).
function plantSafetyLines(v2) {
  const plant = (v2.subject && v2.subject.plant) || {};
  const weeds = asList(v2.subject && v2.subject.weeds);
  const lines = [plant.safety_line, ...weeds.map((w) => w && w.safety_line), ...asList(v2.possibilities).map((p) => p && p.safety_line)];
  return [...new Set(lines.filter(Boolean))];
}

function plantTopFields(v2) {
  const top = (Array.isArray(v2.possibilities) && v2.possibilities[0]) || {};
  const plant = (v2.subject && v2.subject.plant) || {};
  const answerLevel = (v2.answer || {}).level;
  return {
    conditionName: answerLevel === 'entry' ? (top.common_name || null) : null,
    fits: asList(top.fits),
    notYet: asList(top.not_yet),
    plantCommonName: plant.common_name || null,
    // The approved weeds the engine named (at most two; plant-engine.js
    // workupSubjectFor): a weed-focused photo whose headline is only "Weeds
    // in the lawn" still tells the tech which ones.
    weedNames: [...new Set(asList(v2.subject && v2.subject.weeds).map((w) => w && w.common_name).filter(Boolean))],
    safetyLines: plantSafetyLines(v2),
    hazards: top.safety || plant.safety || null,
  };
}

function plantReadFactsFromResult(status, resultRow) {
  if (status === 'done' && !resultRow) return { status: 'failed' };
  if (status !== 'done') return { status };
  const v2 = resultRow.v2 || {};
  const answer = v2.answer || {};
  const nextStep = v2.next_step_hint || {};
  const referral = v2.referral || {};
  return {
    status,
    kind: 'plant',
    subjectType: resultRow.subject_type || v2.subject_type || null,
    wordingTier: answer.wording || null,
    headline: answer.headline || null,
    nextStepText: nextStep.text || null,
    referralKind: referral.kind || null,
    ...plantTopFields(v2),
  };
}

function readFactsFromContract(status, contract) {
  // A 'done' row whose stored result is gone or unreadable (a purge, the
  // FK's ON DELETE SET NULL) is shown as failed, never as an empty "done"
  // the tech would read as "the AI looked and named nothing".
  if (status === 'done' && !contract) return { status: 'failed' };
  if (status !== 'done') return { status };
  const v2 = contract.v2 || {};
  return {
    status,
    wordingTier: v2.answer?.wording || null,
    ...answerName(v2),
    // v2.evidence is picked from the approved catalog entry's own traits
    // (pest-engine.js evidenceFor), never model prose.
    matches: asList(v2.evidence?.matches),
    stillNeed: asList(v2.evidence?.still_need),
    referralKind: v2.referral?.kind || null,
    hazards: contract.safety || null,
  };
}

// Deterministic-facts entry point for `facts.customerFlagged`
// (previsit-brief.js's deterministicVisitFacts) — called ONLY when
// visitPrepPhotosLive() (the caller's job, not re-checked here so this
// stays a plain read). Returns null (never an empty array) when the
// stop's CURRENT membership has no submissions, so the caller can omit
// the key entirely rather than serve an empty customerFlagged: [] — gate
// off or no submissions must both read as "key absent," not "empty list."
// Never returns S3 keys or URLs — photoIds only; the thumbnails endpoint
// above signs those on its own authorized read.
const FINAL_CHECK_SNAPSHOT = { isolationLevel: 'repeatable read', readOnly: true };

// The stop's final member set and, when asked, whether it is still a pest
// stop and/or still a lawn/tree & shrub stop, from one consistent snapshot.
// A conn without transactions (unit-test fakes) runs the same reads
// directly.
async function finalStopSnapshot(svc, conn, needPest, needPlant) {
  const run = async (c) => {
    const current = await stillOnTechStop(svc, c);
    const stillPest = needPest
      ? await require('./visit-prep-pest-applicability').membersArePest([...current], c)
      : true;
    // Sibling of stillPest for GATE_VISIT_PREP_PLANT_READ — 'lawn' |
    // 'tree_shrub' | null, so a stop reclassified away from a plant subject
    // never shows a stale plant read (Codex-#5305-r16/r17-style freshness,
    // applied to the plant sibling). A pest part does NOT hide the plant
    // subject: a combined Lawn & Pest stop (owner ruling 2026-09-30) shows
    // both notes.
    const plantSubject = needPlant
      ? await require('./visit-prep-plant-applicability').subjectForMembers([...current], c)
      : null;
    return { current, stillPest, plantSubject };
  };
  // Inside a caller's transaction (or a test fake) the reads already share
  // that connection; only a pool-level conn opens the snapshot.
  if (typeof conn.transaction !== 'function' || conn.isTransaction) return run(conn);
  return conn.transaction((trx) => run(trx), FINAL_CHECK_SNAPSHOT);
}

// The read line one submission gets, or null when neither read feature is
// live. Each engine's kill switch hides its stored reads too (Codex #5305 r1
// P1). A claimed read (pending/done/failed) is shown only by the engine that
// made it, and only while the stop still suits that engine and, for a plant
// read, that subject; a combined Lawn & Pest read shows each of its two notes
// under the same rule (lawn vs tree_shrub; Codex #5320 r1/r3). An unclaimed
// row on a stop a live engine suits hasn't been read YET, so an
// 'unsupported' written by the other engine is served as 'none' and the
// panel keeps polling (Codex #5320 r3 P2). Otherwise 'unsupported'.
function servedRead(s, ctx) {
  const read = servedReadLine(s, ctx);
  // An unread row the recovery sweep may still pick up today: the panel
  // keeps re-reading the brief for it, so a recovered read reaches a brief
  // that is already open (Codex #5320 r10 P2). Nothing extra is shown.
  if (read?.status === 'none' && ctx.recoveryLive && new Date(s.created_at) >= ctx.todayStart) {
    return { ...read, awaiting: true };
  }
  return read;
}

// The combined (Lawn & Pest) read's brief entry: BOTH notes, each shown only
// while its own gate is live and the stop still has that part, each only if
// that part produced a result (a partial combo shows the part that worked and
// stays quiet on the other). `read.kind` is 'combo'; `pest` / `plant` are the
// same fixed-field shapes a pest-only / plant-only read carries, or null.
const doneFacts = (facts) => (facts && facts.status === 'done' ? facts : null);

function comboPestNote(s, ctx, result) {
  if (!(ctx.readsLive && ctx.stillPest) || result?.pest?.status !== 'done' || !s.read_ref) return null;
  return doneFacts(readFactsFromContract('done', ctx.contractsByRef.get(s.read_ref)));
}

function comboPlantNote(ctx, result) {
  const plantOk = ctx.plantReadsLive && ctx.plantSubject && (!result?.subject_type || result.subject_type === ctx.plantSubject);
  if (!plantOk || result?.plant?.status !== 'done' || !result.plant.v2) return null;
  return doneFacts(plantReadFactsFromResult('done', { v2: result.plant.v2, subject_type: result.subject_type }));
}

function comboReadFacts(s, ctx, shownStatus, result) {
  const pestOk = ctx.readsLive && ctx.stillPest;
  const plantOk = ctx.plantReadsLive && ctx.plantSubject && (!result?.subject_type || result.subject_type === ctx.plantSubject);
  if (!pestOk && !plantOk) return { status: 'unsupported' };
  if (shownStatus !== 'done') return { status: shownStatus };
  const pest = comboPestNote(s, ctx, result);
  const plant = comboPlantNote(ctx, result);
  if (!pest && !plant) return { status: 'failed' };
  return { status: 'done', kind: 'combo', pest, plant };
}

function servedReadLine(s, ctx) {
  const status = effectiveReadStatus(s.read_status || 'none', s.created_at, Date.now(), s.read_claimed_at);
  const plantResult = s.read_result ? parseJsonMaybe(s.read_result) : null;
  const origin = readOrigin(s.read_status, plantResult);
  const shownStatus = !origin && status === 'unsupported' ? 'none' : status;
  if (origin === 'combo') return comboReadFacts(s, ctx, shownStatus, plantResult);
  if (ctx.readsLive && ctx.stillPest && origin !== 'plant') {
    return readFactsFromContract(shownStatus, s.read_ref ? ctx.contractsByRef.get(s.read_ref) : null);
  }
  const subjectMatches = !plantResult?.subject_type || plantResult.subject_type === ctx.plantSubject;
  if (ctx.plantReadsLive && ctx.plantSubject && origin !== 'pest' && subjectMatches) {
    return plantReadFactsFromResult(shownStatus, plantResult);
  }
  return ctx.readsLive || ctx.plantReadsLive ? { status: 'unsupported' } : null;
}

async function customerFlaggedFacts(svc, conn = db) {
  const ids = await techStopMemberIds(svc, conn);
  if (ids.length === 0) return null;
  const submissions = await conn('visit_prep_submissions')
    .whereIn('scheduled_service_id', ids)
    .orderBy('created_at', 'asc')
    .select('id', 'scheduled_service_id', 'created_at', 'topic', 'location_on_property', 'note', 'read_status', 'read_ref', 'read_result', 'read_claimed_at');
  if (submissions.length === 0) return null;
  const photos = await conn('visit_prep_photos')
    .whereIn('submission_id', submissions.map((s) => s.id))
    .orderBy('photo_index', 'asc')
    .select('id', 'submission_id');
  const photoIdsBySubmission = new Map();
  for (const p of photos) {
    if (!photoIdsBySubmission.has(p.submission_id)) photoIdsBySubmission.set(p.submission_id, []);
    photoIdsBySubmission.get(p.submission_id).push(p.id);
  }
  // Batch-fetch the stored contract for every DONE read on this stop —
  // one query regardless of how many submissions carry a result. A
  // submission whose read_ref points at a row that no longer exists (a
  // purge, or the FK's ON DELETE SET NULL racing this read) just falls
  // back to `{ status }` with no fixed fields — never a thrown error over
  // an otherwise-informative section. Fetched BEFORE the membership
  // recheck below, so every read this function does is covered by it
  // (Codex #5305 r7 P1).
  // The read line is optional enrichment: if it can't be loaded, the
  // customer's note and photos are still served, just without a read
  // (Codex #5305 r14 P2).
  let readsLive = require('../config/feature-gates').visitPrepPestReadLive();
  let plantReadsLive = require('../config/feature-gates').visitPrepPlantReadLive();
  const contractsByRef = new Map();
  if (readsLive) {
    try {
      const readRefs = [...new Set(submissions.filter((s) => s.read_status === 'done' && s.read_ref).map((s) => s.read_ref))];
      if (readRefs.length) {
        const rows = await conn('pest_identifications').whereIn('id', readRefs).select('id', 'report_contract');
        for (const row of rows) contractsByRef.set(row.id, parseJsonMaybe(row.report_contract));
      }
    } catch (err) {
      logger.warn(`[visit-prep] read enrichment failed for ${svc.id}: ${err.message}`);
      readsLive = false;
    }
  }

  // Membership and pest-ness/plant-ness are read in ONE repeatable-read
  // snapshot (the FINAL_CHECK_SNAPSHOT pattern of
  // estimate-consultation-offer.js), so the member set that filters what is
  // served and the member set judged pest/plant are the same rows at the
  // same instant (Codex #5305 r16/r17 P1, applied to the plant sibling
  // too). Checked for running reads too, so "Photo read pending" never
  // outlives a reclassification (r13). The applicability modules never
  // load a vision engine here.
  // Applicability is resolved for every row whenever an engine is live, so
  // an unclaimed row ('none', or 'unsupported' written by the engine that
  // doesn't apply) on a stop a live engine suits stays pollable instead of
  // reading 'unsupported' (Codex #5320 r2/r3 P2).
  const needPest = readsLive;
  const needPlant = plantReadsLive;
  let snapshot;
  try {
    snapshot = await finalStopSnapshot(svc, conn, needPest, needPlant);
  } catch (err) {
    if (!needPest && !needPlant) throw err;
    logger.warn(`[visit-prep] read applicability failed for ${svc.id}: ${err.message}`);
    readsLive = false;
    plantReadsLive = false;
    snapshot = { current: await stillOnTechStop(svc, conn), stillPest: true, plantSubject: null };
  }
  const { current, stillPest, plantSubject } = snapshot;
  const kept = submissions.filter((s) => current.has(String(s.scheduled_service_id)));
  if (kept.length === 0) return null;

  const recoveryLive = require('../config/feature-gates').visitPrepReadSweepLive();
  const todayStart = require('./visit-prep-read-claim').etDayStart();
  return kept.map((s) => {
    const entry = {
      id: s.id,
      sentAt: s.created_at instanceof Date ? s.created_at.toISOString() : new Date(s.created_at).toISOString(),
      topic: s.topic || null,
      locationOnProperty: s.location_on_property || null,
      note: s.note || null,
      photoIds: photoIdsBySubmission.get(s.id) || [],
    };
    const read = servedRead(s, {
      readsLive, plantReadsLive, stillPest, plantSubject, contractsByRef, recoveryLive, todayStart,
    });
    if (read) entry.read = read;
    return entry;
  });
}

module.exports = {
  VISIT_PREP_LIMITS,
  TOPICS,
  LOCATIONS,
  isRecurringLineageVisit,
  visitPrepEligibility,
  capReached,
  visitPrepSummary,
  createVisitPrepSubmission,
  TECH_PHOTO_VIEW_TTL_SECONDS,
  stopPhotoViewUrls,
  customerFlaggedFacts,
  techStopMemberIds,
  _internal: {
    detectedImageMime, mimeFamily, stripHtml, prepareUploadFile, prepareFiles, normalizeSubmissionFields, deleteUploadedObject, stopMemberIds, normalizeToJpeg, readFactsFromContract, plantReadFactsFromResult, effectiveReadStatus,
  },
};
