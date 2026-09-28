/**
 * POST /api/public/appointment/:token/photos (GATE_VISIT_PREP_PHOTOS, dark
 * server foundation) + the additive prepPhotos field on the existing GET.
 *
 * Real HTTP server + fetch/FormData (same pattern as
 * tech-dictation-upload.test.js) so the full guard chain — token format,
 * sub-gate, rate limiter, eligibility, cap pre-check, multer, then the
 * service — is exercised in order, not just its pure pieces.
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

jest.mock('../services/heic-to-jpeg', () => ({
  convertHeicToJpeg: (...args) => mockConvertHeicToJpeg(...args),
  MAX_HEIC_BYTES: 5 * 1024 * 1024,
}));
jest.mock('../utils/funnel-photos', () => ({
  uploadFunnelPhotoToS3: (...args) => mockUploadFunnelPhotoToS3(...args),
  storeFunnelPhotos: jest.fn(),
  storeTreeShrubCustomerPhotos: jest.fn(),
}));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/appointment-reminders', () => ({
  ...jest.requireActual('../services/appointment-reminders'),
  buildServiceLabel: jest.fn(async (id, name) => name || 'service'),
}));

let dbState;

// Minimal knex-chain fake covering exactly what loadByToken, visitServicesFor
// (ungrouped short-circuits without touching the DB at all) and
// services/visit-prep.js need. `dbState.svcRow` is what loadByToken /
// the FOR UPDATE lock resolve to; count queries read
// dbState.{submissionCount,photoCount} plus whatever this run has inserted.
function chain(table) {
  const api = {};
  let countMode = null;
  api.where = () => api;
  api.whereNotIn = () => api;
  api.whereNot = () => api;
  api.orderBy = () => api;
  api.leftJoin = () => api;
  api.join = () => api;
  api.forUpdate = () => api;
  api.count = () => { countMode = table.indexOf('visit_prep_photos') === 0 ? 'photos' : 'submissions'; return api; };
  api.first = async () => {
    if (countMode === 'photos') return { count: dbState.photoCount + dbState.inserted.photos.length };
    if (countMode === 'submissions') return { count: dbState.submissionCount + dbState.inserted.submissions.length };
    if (table.startsWith('scheduled_services')) return dbState.svcRow;
    return null;
  };
  api.select = async () => {
    if (table === 'scheduled_services' && dbState.membersThrow) throw new Error('members lookup failed');
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
    submissionCount: 0,
    photoCount: 0,
    existingHashes: [],
    membersThrow: false,
    inserted: { submissions: [], photos: [] },
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use('/api/public/appointment', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
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
  ])('%s is not eligible: 409 PREP_NOT_AVAILABLE', async (_label, overrides) => {
    resetDbState({ svcRow: { ...dbStateSvc(), ...overrides } });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PREP_NOT_AVAILABLE');
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
    });
  });

  test('unreadable grouped membership (visitUnknown): 409 PREP_NOT_AVAILABLE', async () => {
    resetDbState({ svcRow: { ...dbStateSvc(), visit_id: 'visit-1' }, membersThrow: true });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PREP_NOT_AVAILABLE');
    });
  });

  test('cap already reached: 409 PREP_CAP_REACHED without ever parsing the body', async () => {
    resetDbState({ submissionCount: 3 });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PREP_CAP_REACHED');
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
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

  test('HEIC is converted to JPEG before storage', async () => {
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: HEIC_BYTES, mimetype: 'image/heic', name: 'photo.heic' }] });
      expect(res.status).toBe(201);
      expect(mockConvertHeicToJpeg).toHaveBeenCalledTimes(1);
      expect(mockUploadFunnelPhotoToS3).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/jpeg' }));
    });
  });

  test('all-duplicate resubmit is idempotent: 200, nothing new stored', async () => {
    const sha256 = crypto.createHash('sha256').update(JPEG_BYTES).digest('hex');
    resetDbState({ existingHashes: [sha256] });
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, { files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, prepPhotos: { eligible: true, photoCount: 0, photosRemaining: 6 } });
      expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
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

  test('success: 201, and the response carries no keys/urls/note/identity', async () => {
    await withServer(async (baseUrl) => {
      const res = await postPhotos(baseUrl, {
        files: [{ bytes: JPEG_BYTES, mimetype: 'image/jpeg' }],
        note: 'Dog is friendly, gate code 1234',
        topic: 'pest',
        locationOnProperty: 'back_yard',
      });
      expect(res.status).toBe(201);
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
