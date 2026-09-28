/**
 * POST /api/public/appointment/:token/photos (GATE_VISIT_PREP_PHOTOS, dark
 * server foundation) + the additive prepPhotos field on the existing GET.
 *
 * Real HTTP server + fetch/FormData (same pattern as
 * tech-dictation-upload.test.js) so the full guard chain — token format,
 * sub-gate, rate limiter, eligibility, cap pre-check, multer, the locked
 * late-recheck, then the service — is exercised in order, not just its
 * pure pieces.
 */

const crypto = require('crypto');

// A tiny "real" JPEG (magic bytes FF D8 FF, padded past the 12-byte sniff
// floor) and a tiny "real" PNG, so the magic-byte sniff has something
// genuine to check against a declared mimetype.
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const HEIC_BYTES = Buffer.concat([
  Buffer.alloc(4, 0), Buffer.from('ftyp', 'ascii'), Buffer.from('heic', 'ascii'), Buffer.alloc(16, 3),
]);
const CONVERTED_HEIC_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(32, 4)]);

const mockConvertHeicToJpeg = jest.fn();
const mockUploadFunnelPhotoToS3 = jest.fn();
const mockDeletePhoto = jest.fn().mockResolvedValue(undefined);
const mockLockStopForRow = jest.fn(async (trx, id) => id);
const mockOpenMembers = jest.fn(async () => []);
const mockBuildServiceLabel = jest.fn(async (id, name) => name || 'service');

jest.mock('../services/heic-to-jpeg', () => ({
  convertHeicToJpeg: (...args) => mockConvertHeicToJpeg(...args),
  MAX_HEIC_BYTES: 5 * 1024 * 1024,
}));
jest.mock('../utils/funnel-photos', () => ({
  uploadFunnelPhotoToS3: (...args) => mockUploadFunnelPhotoToS3(...args),
  storeFunnelPhotos: jest.fn(),
  storeTreeShrubCustomerPhotos: jest.fn(),
}));
jest.mock('../services/photos', () => ({
  deletePhoto: (...args) => mockDeletePhoto(...args),
}));
// sharp stand-in: identity re-encode, so hash expectations below hold. The
// real decode/normalize path is proven in visit-prep-image-decode.test.js.
jest.mock('sharp', () => (input) => {
  const api = {};
  api.rotate = () => api;
  api.resize = () => api;
  api.jpeg = () => api;
  api.toBuffer = async () => Buffer.from(input);
  return api;
});
// Real visit-groups.js's advisory-lock plumbing needs its own DB shape
// (raw SQL + a peek/verify pair) that would bloat this route-level fake for
// no benefit — the lock's own peek->lock->verify->retry contract is proven
// against real Postgres in visit-prep-postgres.test.js and unit-tested in
// visit-prep.test.js. Here it's a controllable stand-in so this file can
// focus on the route's guard chain and response shape.
// openMembers is mocked too (Finding 1): the locked recheck reads live
// membership through it instead of visitServicesFor, on the write's own
// transaction — controllable per test rather than re-deriving the real
// peek/lock/verify plumbing this route-level fake already skips for
// lockStopForRow.
jest.mock('../services/visit-groups', () => ({
  lockStopForRow: (...args) => mockLockStopForRow(...args),
  openMembers: (...args) => mockOpenMembers(...args),
  // Pure connectivity rule the pre-check's membersOneStop applies; a
  // grouped pre-check needs it to answer true to reach the write at all.
  windowedMembersConnected: () => true,
}));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/appointment-reminders', () => ({
  ...jest.requireActual('../services/appointment-reminders'),
  buildServiceLabel: (...args) => mockBuildServiceLabel(...args),
}));

let dbState;

// Minimal knex-chain fake covering exactly what loadByToken, visitServicesFor
// (ungrouped short-circuits without touching the DB at all) and
// services/visit-prep.js need. `dbState.svcRow` is what loadByToken
// resolves to on its FIRST call (the pre-multer read); `dbState.svcRowAfterRecheck`,
// when set, is what the SECOND call (the locked late recheck) resolves to
// instead — modeling the visit changing state between the two reads. Count
// queries read dbState.{submissionCount,photoCount} plus whatever this run
// has inserted.
function chain(table) {
  const api = {};
  let countMode = null;
  let lockRead = false;
  api.where = () => api;
  api.whereIn = () => api;
  api.whereNotIn = () => api;
  api.whereNot = () => api;
  api.orderBy = () => api;
  api.leftJoin = () => api;
  api.join = () => api;
  api.forUpdate = () => { lockRead = true; return api; };
  api.count = () => { countMode = table.indexOf('visit_prep_photos') === 0 ? 'photos' : 'submissions'; return api; };
  api.first = async () => {
    // The locked recheck's FOR UPDATE on the token row (Codex r1 P1) — a
    // lock read, not a loadByToken read, so it never advances the
    // first-vs-second loadByToken accounting below.
    if (lockRead && table.startsWith('scheduled_services')) { dbState.lockReads += 1; return { id: dbState.svcRow?.id }; }
    if (countMode === 'photos') return { count: dbState.photoCount + dbState.inserted.photos.length };
    if (countMode === 'submissions') return { count: dbState.submissionCount + dbState.inserted.submissions.length };
    if (table.startsWith('scheduled_services')) {
      dbState.loadByTokenCalls += 1;
      if (dbState.loadByTokenCalls > 1 && dbState.svcRowAfterRecheck !== undefined) return dbState.svcRowAfterRecheck;
      return dbState.svcRow;
    }
    return null;
  };
  api.select = async () => {
    if (table === 'scheduled_services' && dbState.membersThrow) throw new Error('members lookup failed');
    // visitServicesFor's PRE-CHECK member query only — the locked recheck's
    // member read goes through the separately-mocked openMembers, never
    // this table (Finding 1: the recheck must not call visitServicesFor).
    if (table === 'scheduled_services' && dbState.groupedMembersForPreCheck) return dbState.groupedMembersForPreCheck;
    if (table === 'visit_prep_photos') return dbState.existingHashes.map((h) => ({ image_sha256: h }));
    return [];
  };
  api.insert = (rows) => {
    const arr = Array.isArray(rows) ? rows : [rows];
    if (table === 'visit_prep_submissions') {
      const id = `sub-${dbState.inserted.submissions.length + 1}`;
      dbState.inserted.submissions.push({ id, ...arr[0] });
      return { returning: async () => [{ id }] };
    }
    if (table === 'visit_prep_photos') {
      dbState.inserted.photos.push(...arr);
      return Promise.resolve();
    }
    return Promise.resolve();
  };
  return api;
}

const mockDb = jest.fn((table) => chain(table));
mockDb.transaction = async (fn) => fn(mockDb);
mockDb.raw = (sql) => sql;
jest.mock('../models/db', () => mockDb);

const express = require('express');
let router;

function resetDbState(overrides = {}) {
  dbState = {
    svcRow: {
      id: 'svc-1',
      customer_id: 'cust-1',
      property_id: 'prop-1',
      visit_id: null,
      status: 'confirmed',
      scheduled_date: '2099-01-01',
      window_start: '09:00:00',
      window_end: '11:00:00',
      service_type: 'pest_control',
      is_recurring: true,
      recurring_parent_id: null,
      recurring_pattern: 'quarterly',
      reschedule_token: 'a'.repeat(64),
      source_action: null,
      customer_confirmed: true,
      customer_deleted_at: null,
      customer_active: true,
      technician_id: null,
      tech_name: null,
      tech_photo_url: null,
      tech_photo_s3_key: null,
      latitude: null,
      longitude: null,
    },
    svcRowAfterRecheck: undefined,
    loadByTokenCalls: 0,
    submissionCount: 0,
    photoCount: 0,
    existingHashes: [],
    membersThrow: false,
    lockReads: 0,
    groupedMembersForPreCheck: null,
    inserted: { submissions: [], photos: [] },
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use('/api/public/appointment', router);
  // A GENERIC fallback — mirrors a real production error handler that never
  // echoes a raw error message to an anonymous caller. Tests that need to
  // prove the route itself never leaked a foreign error's message assert
  // against THIS body, not a passthrough of err.message.
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const TOKEN = 'a'.repeat(64);

function postPhotos(baseUrl, { token = TOKEN, files = [], note, topic, locationOnProperty } = {}) {
  const form = new FormData();
  for (const f of files) form.append('photos', new Blob([f.bytes], { type: f.mimetype }), f.name || 'photo.jpg');
  if (note !== undefined) form.append('note', note);
  if (topic !== undefined) form.append('topic', topic);
  if (locationOnProperty !== undefined) form.append('locationOnProperty', locationOnProperty);
  return fetch(`${baseUrl}/api/public/appointment/${token}/photos`, { method: 'POST', body: form });
}

function getAppointment(baseUrl, token = TOKEN) {
  return fetch(`${baseUrl}/api/public/appointment/${token}`);
}

describe('POST /api/public/appointment/:token/photos', () => {
  const prevAppt = process.env.GATE_APPOINTMENT_PAGE;
  const prevPrep = process.env.GATE_VISIT_PREP_PHOTOS;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.GATE_APPOINTMENT_PAGE = 'true';
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    mockUploadFunnelPhotoToS3.mockImplementation(async ({ index }) => `visitprep/svc-1/photo_${index}.jpg`);
    mockConvertHeicToJpeg.mockResolvedValue(CONVERTED_HEIC_JPEG);
    mockLockStopForRow.mockImplementation(async (trx, id) => id);
    resetDbState();
    // Fresh require every test: express-rate-limit's in-memory store lives
    // on the router module instance, and this file's rate-limiter tests
    // depend on each test starting with an unconsumed budget.
    router = require('../routes/appointment-public');
  });
  afterAll(() => {
    if (prevAppt === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = prevAppt;
    if (prevPrep === undefined) delete process.env.GATE_VISIT_PREP_PHOTOS; else process.env.GATE_VISIT_PREP_PHOTOS = prevPrep;
  });

  test('sub-gate off: generic 404, before the route limiter, and multer never runs', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'false';
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
      // A 41st rapid request would trip the 6/min limiter if it were
      // consulted before the gate — it never is: every one of these 404s.
      for (let i = 0; i < 6; i += 1) {
        const again = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
        expect(again.status).toBe(404);
      }
    });
  });

  test('router-level gate (GATE_APPOINTMENT_PAGE) off: the whole router 404s', async () => {
    process.env.GATE_APPOINTMENT_PAGE = 'false';
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(404);
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
    });
  });

  test('route-level: /PHOTOS (Express is case-insensitive) is guarded exactly like /photos — dark gate and malformed token both 404 before any DB read', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'false';
    await withServer(async (baseUrl) => {
      const form = new FormData();
      form.append('photos', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'photo.jpg');
      const dark = await fetch(`${baseUrl}/api/public/appointment/${TOKEN}/PHOTOS`, { method: 'POST', body: form });
      expect(dark.status).toBe(404);
      expect(await dark.json()).toEqual({ error: 'Not found' });
    });
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    await withServer(async (baseUrl) => {
      const form = new FormData();
      form.append('photos', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'photo.jpg');
      const upper = await fetch(`${baseUrl}/api/public/appointment/${TOKEN.toUpperCase()}/Photos`, { method: 'POST', body: form });
      expect(upper.status).toBe(404);
      expect(await upper.json()).toEqual({ error: 'Not found' });
      expect(dbState.loadByTokenCalls).toBe(0);
    });
  });

  test('malformed token: 404 before any DB read', async () => {
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { token: 'not-a-real-token', files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(mockDb).not.toHaveBeenCalled();
    });
  });

  test('unknown token: generic 404', async () => {
    resetDbState({ svcRow: null });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
  });

  test.each([
    ['one-time visit', { is_recurring: false, recurring_parent_id: null, recurring_pattern: null }],
    ['in-progress visit', { status: 'en_route' }],
    ['completed visit', { status: 'completed' }],
    ['inactive customer', { customer_active: false }],
    ['dispatch-owned unreviewed booking', { status: 'pending', source_action: 'ai_call_pipeline_followup', customer_confirmed: false }],
  ])('%s is not eligible: the SAME generic 404 an unknown token gets', async (_label, overrides) => {
    resetDbState({ svcRow: { ...dbStateSvc(), ...overrides } });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
    });
  });

  test('unreadable grouped membership (visitUnknown): generic 404', async () => {
    resetDbState({ svcRow: { ...dbStateSvc(), visit_id: 'visit-1' }, membersThrow: true });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
  });

  test('visit already full + NEW photo: 409 PREP_CAP_REACHED decided under the lock, upload cleaned up', async () => {
    resetDbState({ photoCount: 6 });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PREP_CAP_REACHED');
      expect(dbState.inserted.submissions).toHaveLength(0);
      expect(mockUploadFunnelPhotoToS3).toHaveBeenCalledTimes(1);
      expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
    });
  });

  test('visit already full + a RETRY of photos already stored: still the idempotent 200, never "limit reached"', async () => {
    // A double-tap after the submission that filled the visit: the cap is
    // decided only under the lock, AFTER dedupe, so the retry is recognized
    // as already stored rather than refused (pre-push audit P1).
    resetDbState({ photoCount: 6, existingHashes: [crypto.createHash('sha256').update(JPEG_BYTES).digest('hex')] });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.prepPhotos).toMatchObject({ photoCount: 6, photosRemaining: 0 });
      expect(dbState.inserted.submissions).toHaveLength(0);
      expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
    });
  });

  test('too many files: multer 400, nothing stored', async () => {
    await withServer(async (baseUrl) => {
      const files = Array.from({ length: 4 }, () => ({ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }));
      const res = await postPhotos(baseUrl, { files });
      expect(res.status).toBe(400);
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
    });
  });

  test('oversize file: multer 413', async () => {
    await withServer(async (baseUrl) => {
      const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 9);
      const res = await postPhotos(baseUrl, { files: [{ bytes: huge, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(413);
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
    });
  });

  test('declared mimetype outside the allowlist: 400 PREP_INVALID_PHOTO', async () => {
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/gif' }] });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('PREP_INVALID_PHOTO');
    });
  });

  test('declared mimetype vs magic bytes mismatch: 400 PREP_INVALID_PHOTO', async () => {
    await withServer(async (baseUrl) => {
      // PNG bytes declared as JPEG.
      const res = await postPhotos(baseUrl, { files: [{ bytes: PNG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('PREP_INVALID_PHOTO');
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
    });
  });

  test('invalid topic: 400 PREP_INVALID_FIELD', async () => {
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }], topic: 'not-a-real-topic' });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('PREP_INVALID_FIELD');
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
    });
  });

  test('HEIC is converted to JPEG before storage', async () => {
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: HEIC_BYTES, mimetype: 'image/heic', name: 'photo.heic' }] });
      expect(res.status).toBe(201);
      expect(mockConvertHeicToJpeg).toHaveBeenCalledTimes(1);
      expect(mockUploadFunnelPhotoToS3).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/jpeg' }));
    });
  });

  test('all-duplicate resubmit is idempotent: 200, nothing new stored, and the uploaded duplicate is cleaned up', async () => {
    // Dedupe now happens UNDER THE LOCK (after the late recheck), so the
    // photo IS uploaded first, then recognized as a DB duplicate and its
    // object deleted — never left behind, never double-counted.
    const sha256 = crypto.createHash('sha256').update(JPEG_BYTES).digest('hex');
    resetDbState({ existingHashes: [sha256] });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, prepPhotos: { eligible: true, photoCount: 0, photosRemaining: 6 } });
      expect(mockUploadFunnelPhotoToS3).toHaveBeenCalledTimes(1);
      expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
      expect(dbState.inserted.submissions).toHaveLength(0);
    });
  });

  test('storage failure: 503 PREP_STORAGE_UNAVAILABLE, no rows written', async () => {
    mockUploadFunnelPhotoToS3.mockResolvedValue(null);
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('PREP_STORAGE_UNAVAILABLE');
      expect(dbState.inserted.submissions).toHaveLength(0);
      expect(dbState.inserted.photos).toHaveLength(0);
    });
  });

  test('visit becomes ineligible between the pre-check and the locked write: generic 404, nothing stored, upload cleaned up', async () => {
    // The FIRST loadByToken read (pre-multer guard) sees an eligible visit;
    // the SECOND (the recheck, called under the stop lock at write time)
    // sees it cancelled — modeling a status change that lands between the
    // two reads (e.g. dispatch marks the visit cancelled mid-submission).
    resetDbState({ svcRowAfterRecheck: { ...dbStateSvc(), status: 'cancelled' } });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(dbState.inserted.submissions).toHaveLength(0);
      expect(dbState.inserted.photos).toHaveLength(0);
      // The photo WAS uploaded (upload happens before the lock) and must be
      // cleaned up rather than left orphaned in storage.
      expect(mockUploadFunnelPhotoToS3).toHaveBeenCalledTimes(1);
      expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
    });
  });

  test('grouped stop: a sibling going en_route between the pre-check and the write is refused under the lock, and the locked read uses the write connection only', async () => {
    const members = [
      { id: 'svc-1', service_type: 'pest_control', status: 'confirmed', source_action: null, customer_confirmed: true, scheduled_date: '2099-01-01', window_start: '09:00:00', window_end: '10:00:00', technician_id: 'tech-1' },
      { id: 'svc-2', service_type: 'lawn_care', status: 'confirmed', source_action: null, customer_confirmed: true, scheduled_date: '2099-01-01', window_start: '10:00:00', window_end: '11:00:00', technician_id: 'tech-1' },
    ];
    resetDbState({ svcRow: { ...dbStateSvc(), visit_id: 'visit-1', technician_id: 'tech-1' }, groupedMembersForPreCheck: members });
    // The pre-check (page read) sees a live two-member stop; under the lock
    // the live set shows the sibling already en route.
    mockOpenMembers.mockResolvedValue([members[0], { ...members[1], status: 'en_route' }]);
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(dbState.inserted.submissions).toHaveLength(0);
      expect(dbState.inserted.photos).toHaveLength(0);
      expect(mockUploadFunnelPhotoToS3).toHaveBeenCalledTimes(1);
      expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
      // The locked membership read went through openMembers ON THE WRITE'S
      // OWN CONNECTION (this fake's transaction IS mockDb) ...
      expect(mockOpenMembers).toHaveBeenCalledTimes(1);
      expect(mockOpenMembers).toHaveBeenCalledWith(mockDb, 'visit-1', { forUpdate: true });
      // ... and label resolution (visitServicesFor's global-pool work) ran
      // for the pre-check's two members only — never again for the recheck.
      expect(mockBuildServiceLabel).toHaveBeenCalledTimes(2);
    });
  });

  test('a non-prepError with a statusCode is never echoed to the client', async () => {
    // Simulate a library error surfacing from somewhere deep in the write
    // (here, the lock helper) that happens to carry a `statusCode` — the
    // route must hand this to next(err), never echo its own message.
    const foreignErr = new Error('secret internal detail — connection string leaked');
    foreignErr.statusCode = 418;
    mockLockStopForRow.mockRejectedValueOnce(foreignErr);
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).not.toBe(418);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/secret internal detail|connection string/i);
    });
  });

  test('an ineligible visit and an unknown token answer byte-identical 404s (no bearer-token oracle)', async () => {
    resetDbState({ svcRow: { ...dbStateSvc(), status: 'completed' } });
    let ineligible;
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      ineligible = { status: res.status, body: await res.text() };
    });
    resetDbState({ svcRow: null });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect({ status: res.status, body: await res.text() }).toEqual(ineligible);
    });
  });

  test('HEIC converter saturation: 503 PREP_CONVERTER_BUSY (retryable), nothing stored', async () => {
    mockConvertHeicToJpeg.mockRejectedValue(Object.assign(new Error('HEIC conversion capacity is unavailable'), { code: 'HEIC_CAPACITY' }));
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: HEIC_BYTES, mimetype: 'image/heic', name: 'a.heic' }] });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('PREP_CONVERTER_BUSY');
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
    });
  });

  test('success: 201, the token row was locked FOR UPDATE under the stop lock, and the response carries no keys/urls/note/identity', async () => {
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, {
        files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }],
        note: 'Dog is friendly, gate code 1234',
        topic: 'pest',
        locationOnProperty: 'back_yard',
      });
      expect(res.status).toBe(201);
      expect(dbState.lockReads).toBeGreaterThanOrEqual(1);
      const body = await res.json();
      expect(body).toEqual({ ok: true, prepPhotos: { eligible: true, photoCount: 1, photosRemaining: 5 } });
      expect(JSON.stringify(body)).not.toMatch(/1234|friendly|s3_key|visitprep/i);
      expect(dbState.inserted.submissions).toHaveLength(1);
      expect(dbState.inserted.submissions[0]).toMatchObject({
        scheduled_service_id: 'svc-1', customer_id: 'cust-1', property_id: 'prop-1',
        topic: 'pest', location_on_property: 'back_yard', entry: 'appointment_page',
      });
      expect(dbState.inserted.photos).toHaveLength(1);
    });
  });
});

function dbStateSvc() {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    property_id: 'prop-1',
    visit_id: null,
    status: 'confirmed',
    scheduled_date: '2099-01-01',
    window_start: '09:00:00',
    window_end: '11:00:00',
    service_type: 'pest_control',
    is_recurring: true,
    recurring_parent_id: null,
    recurring_pattern: 'quarterly',
    reschedule_token: 'a'.repeat(64),
    source_action: null,
    customer_confirmed: true,
    customer_deleted_at: null,
    customer_active: true,
    technician_id: null,
    tech_name: null,
    tech_photo_url: null,
    tech_photo_s3_key: null,
    latitude: null,
    longitude: null,
  };
}

describe('GET /api/public/appointment/:token — additive prepPhotos', () => {
  const prevAppt = process.env.GATE_APPOINTMENT_PAGE;
  const prevPrep = process.env.GATE_VISIT_PREP_PHOTOS;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.GATE_APPOINTMENT_PAGE = 'true';
    resetDbState();
    router = require('../routes/appointment-public');
  });
  afterAll(() => {
    if (prevAppt === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = prevAppt;
    if (prevPrep === undefined) delete process.env.GATE_VISIT_PREP_PHOTOS; else process.env.GATE_VISIT_PREP_PHOTOS = prevPrep;
  });

  test('gate off: no prepPhotos key, payload otherwise unaffected', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'false';
    await withServer(async (baseUrl) => {
      const res = await getAppointment(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).not.toHaveProperty('prepPhotos');
      expect(body.state).toBe('upcoming');
    });
  });

  test('gate on: prepPhotos summary present', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    resetDbState({ submissionCount: 1, photoCount: 2 });
    await withServer(async (baseUrl) => {
      const res = await getAppointment(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.prepPhotos).toEqual({ eligible: true, photoCount: 2, photosRemaining: 4 });
    });
  });
});

describe('visitPrepPreParserGuard — mounted by index.js AHEAD of the shared body parsers', () => {
  const prevPrep = process.env.GATE_VISIT_PREP_PHOTOS;
  afterAll(() => { if (prevPrep === undefined) delete process.env.GATE_VISIT_PREP_PHOTOS; else process.env.GATE_VISIT_PREP_PHOTOS = prevPrep; });

  async function withGuardApp(fn) {
    const { visitPrepPreParserGuard } = require('../routes/appointment-public');
    const app = express();
    // The production order (server/index.js): the guard, THEN a shared JSON
    // parser whose own 413 would otherwise answer first.
    app.use('/api/public/appointment', visitPrepPreParserGuard);
    app.use(express.json({ limit: '1kb' }));
    app.post('/api/public/appointment/:token/photos', (_req, res) => res.status(200).json({ reached: true }));
    app.post('/api/public/appointment/:token/confirm', (_req, res) => res.status(200).json({ reached: true }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ parser: err.type || 'error' }));
    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
  }
  const bigJson = JSON.stringify({ pad: 'x'.repeat(4096) });
  const post = (baseUrl, token) => fetch(`${baseUrl}/api/public/appointment/${token}/photos`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: bigJson,
  });

  test('dark gate: an oversized application/json body to the photos path is the generic 404, not the parser 413', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'false';
    await withGuardApp(async (baseUrl) => {
      const res = await post(baseUrl, TOKEN);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
  });

  test('path casing: Express routes are case-insensitive, so /PHOTOS is guarded exactly like /photos', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'false';
    await withGuardApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/public/appointment/${TOKEN}/PHOTOS`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: bigJson,
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
  });

  test('malformed token: generic 404 before the parser, gate on or off', async () => {
    for (const gate of ['true', 'false']) {
      process.env.GATE_VISIT_PREP_PHOTOS = gate;
      await withGuardApp(async (baseUrl) => {
        const res = await post(baseUrl, 'not-a-token');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
      });
    }
  });

  test('gate on + well-formed token: the guard steps aside (the parser answers next — here its 413 proves the ordering)', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    await withGuardApp(async (baseUrl) => {
      const res = await post(baseUrl, TOKEN);
      expect(res.status).toBe(413);
    });
  });

  test('other appointment paths are untouched by the guard', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'false';
    await withGuardApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/public/appointment/${TOKEN}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ reached: true });
    });
  });
});

describe('visit-prep limiter', () => {
  test('is keyed by the shared /64-collapsing unauthenticated key, not the raw IP', () => {
    const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
    expect(require('../routes/appointment-public')._test.VISIT_PREP_LIMITER_OPTIONS.keyGenerator).toBe(unauthenticatedAuthLimitKey);
  });
});
