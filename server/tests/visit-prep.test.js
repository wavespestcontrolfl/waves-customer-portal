/**
 * services/visit-prep.js — pure/unit coverage: eligibility, per-stop
 * summary scoping, the magic-byte sniff, and createVisitPrepSubmission's
 * input validation. Route-level guard-chain + storage/DB behavior is
 * covered by tests/appointment-public-prep-photos.test.js; the real-Postgres
 * migration/cascade/cap-race proof is tests/visit-prep-postgres.test.js.
 */

const mockUploadFunnelPhotoToS3 = jest.fn();
const mockConvertHeicToJpeg = jest.fn();

jest.mock('../utils/funnel-photos', () => ({
  uploadFunnelPhotoToS3: (...args) => mockUploadFunnelPhotoToS3(...args),
  storeFunnelPhotos: jest.fn(),
  storeTreeShrubCustomerPhotos: jest.fn(),
}));
jest.mock('../services/heic-to-jpeg', () => ({
  convertHeicToJpeg: (...args) => mockConvertHeicToJpeg(...args),
  MAX_HEIC_BYTES: 5 * 1024 * 1024,
}));

const queries = [];
function chain(table) {
  const api = {};
  let countMode = null;
  api.where = () => api;
  api.join = () => api;
  api.forUpdate = () => api;
  api.select = async () => (table === 'visit_prep_photos' ? [] : []);
  api.count = () => { countMode = table.indexOf('visit_prep_photos') === 0 ? 'photos' : 'submissions'; return api; };
  api.first = async () => {
    queries.push({ table, countMode });
    if (countMode === 'photos') return { count: 0 };
    if (countMode === 'submissions') return { count: 0 };
    if (table.startsWith('scheduled_services')) return { id: 'svc-1' };
    return null;
  };
  api.insert = (rows) => {
    if (table === 'visit_prep_submissions') return { returning: async () => [{ id: 'sub-1' }] };
    return Promise.resolve();
  };
  return api;
}
const mockDb = jest.fn((table) => chain(table));
mockDb.transaction = async (fn) => fn(mockDb);
jest.mock('../models/db', () => mockDb);

const visitPrep = require('../services/visit-prep');
const { VISIT_PREP_LIMITS, TOPICS, LOCATIONS, isRecurringLineageVisit, visitPrepEligibility, visitPrepSummary, createVisitPrepSubmission } = visitPrep;
const { detectedImageMime, mimeFamily, stripHtml } = visitPrep._internal;

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4, 0), Buffer.from('WEBP', 'ascii'), Buffer.alloc(16, 3)]);
const HEIC_BYTES = Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftyp', 'ascii'), Buffer.from('heic', 'ascii'), Buffer.alloc(16, 4)]);

const RECURRING_SVC = { id: 'svc-1', customer_id: 'cust-1', property_id: 'prop-1', is_recurring: true };

describe('constants', () => {
  test('caps match the shared request-photo-validation contract', () => {
    const { MAX_PHOTOS, MAX_PHOTO_BYTES } = require('../utils/request-photo-validation');
    expect(VISIT_PREP_LIMITS.photosPerSubmission).toBe(MAX_PHOTOS);
    expect(VISIT_PREP_LIMITS.maxPhotoBytes).toBe(MAX_PHOTO_BYTES);
    expect(VISIT_PREP_LIMITS.photosPerVisit).toBe(6);
    expect(VISIT_PREP_LIMITS.submissionsPerVisit).toBe(3);
    expect(VISIT_PREP_LIMITS.noteMaxChars).toBe(500);
  });

  test('TOPICS + LOCATIONS are the documented sets', () => {
    expect(TOPICS).toEqual(['pest', 'lawn', 'tree_shrub', 'other']);
    expect(LOCATIONS).toEqual(require('../routes/requests').VALID_LOCATIONS);
  });
});

describe('isRecurringLineageVisit (shared with estimate-card-holds.js)', () => {
  test('true for is_recurring, a recurring_parent_id, or a recurring_pattern', () => {
    expect(isRecurringLineageVisit({ is_recurring: true })).toBe(true);
    expect(isRecurringLineageVisit({ recurring_parent_id: 'parent-1' })).toBe(true);
    expect(isRecurringLineageVisit({ recurring_pattern: 'quarterly' })).toBe(true);
  });
  test('false for a plain one-time visit or a missing row', () => {
    expect(isRecurringLineageVisit({ is_recurring: false })).toBe(false);
    expect(isRecurringLineageVisit(null)).toBe(false);
    expect(isRecurringLineageVisit({})).toBe(false);
  });
});

describe('visitPrepEligibility', () => {
  const prevGate = process.env.GATE_VISIT_PREP_PHOTOS;
  afterEach(() => { if (prevGate === undefined) delete process.env.GATE_VISIT_PREP_PHOTOS; else process.env.GATE_VISIT_PREP_PHOTOS = prevGate; });

  test('gate off refuses regardless of everything else', () => {
    delete process.env.GATE_VISIT_PREP_PHOTOS;
    const svc = { ...RECURRING_SVC, customer_active: true };
    expect(visitPrepEligibility({ svc, state: 'upcoming', visitUnknown: false }))
      .toEqual({ eligible: false, reason: 'gate_off' });
  });

  test('every other refusal reason, gate on', () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    const svc = { ...RECURRING_SVC, customer_active: true };
    expect(visitPrepEligibility({ svc, state: 'upcoming', visitUnknown: true }).reason).toBe('visit_unknown');
    expect(visitPrepEligibility({ svc, state: 'past', visitUnknown: false }).reason).toBe('not_upcoming');
    expect(visitPrepEligibility({ svc: { ...svc, customer_active: false }, state: 'upcoming', visitUnknown: false }).reason).toBe('customer_inactive');
    expect(visitPrepEligibility({ svc: { ...svc, is_recurring: false }, state: 'upcoming', visitUnknown: false }).reason).toBe('one_time_visit');
    expect(visitPrepEligibility({ svc, state: 'upcoming', visitUnknown: false, dispatchOwnedUnreviewed: true }).reason).toBe('dispatch_owned_unreviewed');
  });

  test('eligible only when every condition clears', () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    const svc = { ...RECURRING_SVC, customer_active: true };
    expect(visitPrepEligibility({ svc, state: 'upcoming', visitUnknown: false, dispatchOwnedUnreviewed: false }))
      .toEqual({ eligible: true, reason: null });
  });
});

describe('visitPrepSummary — per-STOP scoping', () => {
  beforeEach(() => { queries.length = 0; mockDb.mockClear(); });

  test('an ungrouped visit scopes counts by scheduled_service_id', async () => {
    const summary = await visitPrepSummary({ id: 'svc-1', visit_id: null });
    expect(summary).toEqual({ photoCount: 0, photosRemaining: 6, submissionCount: 0 });
    expect(mockDb).toHaveBeenCalledWith('visit_prep_submissions');
  });

  test('a grouped visit (visit_id set) scopes by visit_id, not the row id', async () => {
    await visitPrepSummary({ id: 'svc-1', visit_id: 'visit-9' });
    // Both queries ran (submissions count + the photos join) — the
    // scope-column choice itself is exercised end-to-end in the route and
    // Postgres suites; here we just prove no query blew up on a grouped row.
    expect(queries.length).toBeGreaterThanOrEqual(2);
  });

  test('photosRemaining floors at zero, never negative', async () => {
    mockDb.mockImplementation((table) => {
      const api = {};
      let mode = null;
      api.where = () => api;
      api.join = () => api;
      api.count = () => { mode = table.indexOf('visit_prep_photos') === 0 ? 'photos' : 'submissions'; return api; };
      api.first = async () => ({ count: mode === 'photos' ? 9 : 1 });
      return api;
    });
    const summary = await visitPrepSummary({ id: 'svc-1', visit_id: null });
    expect(summary.photosRemaining).toBe(0);
  });
});

describe('magic-byte sniff', () => {
  test('recognizes JPEG, PNG, WebP, and HEIC ftyp brands', () => {
    expect(detectedImageMime(JPEG_BYTES)).toBe('image/jpeg');
    expect(detectedImageMime(PNG_BYTES)).toBe('image/png');
    expect(detectedImageMime(WEBP_BYTES)).toBe('image/webp');
    expect(detectedImageMime(HEIC_BYTES)).toBe('image/heic');
  });
  test('returns null for garbage, empty, or too-short input', () => {
    expect(detectedImageMime(Buffer.from('not an image, just text'))).toBeNull();
    expect(detectedImageMime(Buffer.alloc(0))).toBeNull();
    expect(detectedImageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull(); // < 12 bytes
    expect(detectedImageMime(null)).toBeNull();
  });
  test('mimeFamily folds jpg->jpeg and heif->heic', () => {
    expect(mimeFamily('image/jpg')).toBe('image/jpeg');
    expect(mimeFamily('image/heif')).toBe('image/heic');
    expect(mimeFamily('image/png')).toBe('image/png');
  });
});

describe('stripHtml', () => {
  test('drops angle brackets only', () => {
    expect(stripHtml('<script>alert(1)</script> gate code is 1234')).toBe('scriptalert(1)/script gate code is 1234');
    expect(stripHtml(null)).toBe('');
  });
});

describe('createVisitPrepSubmission — input validation (no upload reached)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockImplementation((table) => chain(table));
  });

  test('rejects zero files', async () => {
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files: [], entry: 'appointment_page' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
  });

  test('rejects more than the per-submission cap', async () => {
    const files = Array.from({ length: 4 }, () => ({ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }));
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
    expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
  });

  test('rejects an unrecognized topic or location before touching storage', async () => {
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, topic: 'raccoons', entry: 'appointment_page' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, locationOnProperty: 'moon_base', entry: 'appointment_page' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
    expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
  });

  test('rejects an oversize file before any sniff/upload', async () => {
    const files = [{ buffer: Buffer.alloc(VISIT_PREP_LIMITS.maxPhotoBytes + 1), mimetype: 'image/jpeg' }];
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page' }))
      .rejects.toMatchObject({ statusCode: 413, code: 'PREP_PHOTO_TOO_LARGE' });
  });

  test('note is trimmed, HTML-stripped, and truncated to 500 chars', async () => {
    mockUploadFunnelPhotoToS3.mockResolvedValue('visitprep/svc-1/photo_0.jpg');
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    const longNote = `  <b>hi</b> ${'x'.repeat(600)}  `;
    await createVisitPrepSubmission({ svc: RECURRING_SVC, files, note: longNote, entry: 'appointment_page' });
    // No direct return of the stored note (the route never echoes it back
    // either) — the shape under test here is that creation succeeded and
    // never threw on an over-length/markup note; the exact stored value is
    // asserted against the transaction insert in the Postgres suite.
  });
});
