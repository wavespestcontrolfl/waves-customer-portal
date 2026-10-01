/**
 * services/visit-prep.js — pure/unit coverage: eligibility, the ONE cap
 * rule, per-stop summary scoping, the magic-byte sniff, field/file
 * preparation staging, and createVisitPrepSubmission's late-recheck +
 * stop-lock contract. Route-level guard-chain + storage/DB behavior is
 * covered by tests/appointment-public-prep-photos.test.js; the real-Postgres
 * migration/cascade/cap-race/concurrent-stop proof is
 * tests/visit-prep-postgres.test.js.
 */

const mockUploadFunnelPhotoToS3 = jest.fn();
const mockConvertHeicToJpeg = jest.fn();
const mockDeletePhoto = jest.fn().mockResolvedValue(undefined);
const mockLockStopForRow = jest.fn(async (trx, id) => id);
const mockTriggerPestRead = jest.fn(async () => {});
// The upload hook calls the ONE read dispatcher, which picks the engine.
jest.mock('../services/visit-prep-read-dispatch', () => ({
  dispatchVisitPrepRead: (...args) => mockTriggerPestRead(...args),
}));

jest.mock('../utils/funnel-photos', () => ({
  uploadFunnelPhotoToS3: (...args) => mockUploadFunnelPhotoToS3(...args),
  storeFunnelPhotos: jest.fn(),
  storeTreeShrubCustomerPhotos: jest.fn(),
}));
jest.mock('../services/heic-to-jpeg', () => ({
  convertHeicToJpeg: (...args) => mockConvertHeicToJpeg(...args),
  MAX_HEIC_BYTES: 5 * 1024 * 1024,
}));
jest.mock('../services/photos', () => ({
  deletePhoto: (...args) => mockDeletePhoto(...args),
}));
jest.mock('../services/visit-groups', () => ({
  lockStopForRow: (...args) => mockLockStopForRow(...args),
}));
const mockNotifyTechVisitPrepPhotos = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/visit-prep-tech-alert', () => ({
  notifyTechVisitPrepPhotos: (...args) => mockNotifyTechVisitPrepPhotos(...args),
}));
// sharp stand-in (identity): the real decode/normalize path is proven in
// visit-prep-image-decode.test.js; here the stages are the subject.
jest.mock('sharp', () => (input) => {
  const api = {};
  api.rotate = () => api;
  api.resize = () => api;
  api.jpeg = () => api;
  api.toBuffer = async () => Buffer.from(input);
  return api;
});

const queries = [];
function chain(table) {
  const api = {};
  let countMode = null;
  api.where = () => api;
  api.whereIn = () => api;
  api.join = () => api;
  api.forShare = () => { queries.push({ table, lock: 'share' }); return api; };
  // No scheduled_services rows by default: stopMemberIds falls back to
  // [svc.id] (see its own "always including svc.id" fallback), so an
  // ungrouped/simple grouped test never needs to stub this.
  api.select = async () => [];
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
const {
  VISIT_PREP_LIMITS, TOPICS, LOCATIONS, isRecurringLineageVisit, visitPrepEligibility, capReached, visitPrepSummary, createVisitPrepSubmission,
} = visitPrep;
const {
  detectedImageMime, mimeFamily, stripHtml, prepareFiles, normalizeSubmissionFields,
} = visitPrep._internal;

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4, 0), Buffer.from('WEBP', 'ascii'), Buffer.alloc(16, 3)]);
const HEIC_BYTES = Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftyp', 'ascii'), Buffer.from('heic', 'ascii'), Buffer.alloc(16, 4)]);

const RECURRING_SVC = { id: 'svc-1', customer_id: 'cust-1', property_id: 'prop-1', is_recurring: true };
const alwaysRecheck = (row = RECURRING_SVC) => async () => row;

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
    // The explicit `one_time` pattern sentinel is refused even though the
    // shared lineage predicate reads any pattern as recurring, and even
    // alongside other series evidence (Codex #5176 r3 P0).
    for (const extra of [{ is_recurring: false }, {}, { recurring_parent_id: 'parent-1' }]) {
      expect(visitPrepEligibility({ svc: { ...svc, ...extra, recurring_pattern: 'one_time' }, state: 'upcoming', visitUnknown: false }).reason).toBe('one_time_visit');
    }
    expect(visitPrepEligibility({ svc: { ...svc, is_recurring: false, recurring_pattern: 'quarterly' }, state: 'upcoming', visitUnknown: false }).eligible).toBe(true);
    expect(visitPrepEligibility({ svc, state: 'upcoming', visitUnknown: false, dispatchOwnedUnreviewed: true }).reason).toBe('dispatch_owned_unreviewed');
  });

  test('eligible only when every condition clears', () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    const svc = { ...RECURRING_SVC, customer_active: true };
    expect(visitPrepEligibility({ svc, state: 'upcoming', visitUnknown: false, dispatchOwnedUnreviewed: false }))
      .toEqual({ eligible: true, reason: null });
  });
});

describe('capReached — the ONE cap rule, applied under the stop lock', () => {
  test('submission count at/over the cap is reached regardless of photos', () => {
    expect(capReached({ submissionCount: 3, photoCount: 0 }, 1)).toBe(true);
    expect(capReached({ submissionCount: 2, photoCount: 0 }, 1)).toBe(false);
  });
  test('adding N photos past the photo cap is reached', () => {
    expect(capReached({ submissionCount: 0, photoCount: 5 }, 1)).toBe(false); // 5+1=6, at the cap, not over
    expect(capReached({ submissionCount: 0, photoCount: 6 }, 1)).toBe(true); // full visit, one more
    expect(capReached({ submissionCount: 0, photoCount: 5 }, 2)).toBe(true); // 5+2=7 > 6
  });
});

describe('visitPrepSummary / stopMemberIds — counts follow CURRENT stop membership', () => {
  beforeEach(() => { queries.length = 0; mockDb.mockClear(); mockDb.mockImplementation((table) => chain(table)); });

  test('an ungrouped visit scopes counts by scheduled_service_id, no scheduled_services lookup needed', async () => {
    const summary = await visitPrepSummary({ id: 'svc-1', visit_id: null });
    expect(summary).toEqual({ photoCount: 0, photosRemaining: 6, submissionCount: 0 });
    expect(mockDb).toHaveBeenCalledWith('visit_prep_submissions');
    expect(mockDb).toHaveBeenCalledWith('visit_prep_photos');
    expect(mockDb).not.toHaveBeenCalledWith('scheduled_services');
  });

  test('stopMemberIds resolves CURRENT scheduled_services membership, not any stored visit_id on submissions', async () => {
    mockDb.mockImplementation((table) => {
      const api = chain(table);
      if (table === 'scheduled_services') {
        api.select = async () => [{ id: 'svc-1' }, { id: 'svc-2' }];
      }
      return api;
    });
    const ids = await visitPrep._internal.stopMemberIds({ id: 'svc-1', visit_id: 'visit-9' }, mockDb);
    expect(ids.sort()).toEqual(['svc-1', 'svc-2']);
  });

  test('stopMemberIds always includes svc.id even if the fresh membership read somehow omits it', async () => {
    mockDb.mockImplementation((table) => {
      const api = chain(table);
      if (table === 'scheduled_services') api.select = async () => [{ id: 'svc-2' }];
      return api;
    });
    const ids = await visitPrep._internal.stopMemberIds({ id: 'svc-1', visit_id: 'visit-9' }, mockDb);
    expect(ids.sort()).toEqual(['svc-1', 'svc-2']);
  });

  test('a grouped visit counts submissions/photos across every CURRENT member id, via whereIn (no join)', async () => {
    const seen = { submissionIds: null, photoIds: null };
    mockDb.mockImplementation((table) => {
      const api = chain(table);
      if (table === 'scheduled_services') api.select = async () => [{ id: 'svc-1' }, { id: 'svc-2' }];
      const originalWhereIn = api.whereIn;
      api.whereIn = (col, ids) => {
        if (table === 'visit_prep_submissions') seen.submissionIds = ids;
        if (table === 'visit_prep_photos') seen.photoIds = ids;
        return originalWhereIn.call(api, col, ids);
      };
      return api;
    });
    await visitPrepSummary({ id: 'svc-1', visit_id: 'visit-9' });
    expect(seen.submissionIds.sort()).toEqual(['svc-1', 'svc-2']);
    expect(seen.photoIds.sort()).toEqual(['svc-1', 'svc-2']);
  });

  test('photosRemaining floors at zero, never negative', async () => {
    mockDb.mockImplementation((table) => {
      const api = {};
      let mode = null;
      api.where = () => api;
      api.whereIn = () => api;
      api.select = async () => [];
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

describe('normalizeSubmissionFields (stage 1) — topic/location get their own code', () => {
  test('unrecognized topic or location is PREP_INVALID_FIELD, not PREP_INVALID_PHOTO', () => {
    expect(() => normalizeSubmissionFields({ topic: 'raccoons' })).toThrow(expect.objectContaining({ statusCode: 400, code: 'PREP_INVALID_FIELD' }));
    expect(() => normalizeSubmissionFields({ locationOnProperty: 'moon_base' })).toThrow(expect.objectContaining({ statusCode: 400, code: 'PREP_INVALID_FIELD' }));
  });
  test('note is trimmed, HTML-stripped, and truncated to 500 chars', () => {
    const longNote = `  <b>hi</b> ${'x'.repeat(600)}  `;
    const { note } = normalizeSubmissionFields({ note: longNote });
    expect(note.startsWith('bhi/b')).toBe(true);
    expect(note.length).toBe(500);
  });
  test('blank/omitted topic and location pass through as null', () => {
    expect(normalizeSubmissionFields({})).toEqual({ topic: null, locationOnProperty: null, note: null });
  });
});

describe('prepareFiles (stage 2) — count bounds + within-request dedupe', () => {
  test('rejects zero or more than the per-submission cap', async () => {
    await expect(prepareFiles([])).rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
    const four = Array.from({ length: 4 }, () => ({ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }));
    await expect(prepareFiles(four)).rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
  });
  test('the SAME photo submitted twice in one request folds to one prepared item', async () => {
    const prepared = await prepareFiles([
      { buffer: JPEG_BYTES, mimetype: 'image/jpeg' },
      { buffer: Buffer.from(JPEG_BYTES), mimetype: 'image/jpeg' }, // identical bytes, different Buffer instance
    ]);
    expect(prepared).toHaveLength(1);
  });
});

describe('createVisitPrepSubmission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockImplementation((table) => chain(table));
    mockLockStopForRow.mockImplementation(async (trx, id) => id);
    mockUploadFunnelPhotoToS3.mockResolvedValue('visitprep/svc-1/photo_0.jpg');
  });

  test('requires a recheck function', async () => {
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page' }))
      .rejects.toThrow(/recheck/);
  });

  test('rejects zero files', async () => {
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files: [], entry: 'appointment_page', recheck: alwaysRecheck() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
  });

  test('rejects more than the per-submission cap before touching storage', async () => {
    const files = Array.from({ length: 4 }, () => ({ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }));
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_PHOTO' });
    expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
  });

  test('rejects an unrecognized topic before touching storage — PREP_INVALID_FIELD', async () => {
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, topic: 'raccoons', entry: 'appointment_page', recheck: alwaysRecheck() }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PREP_INVALID_FIELD' });
    expect(mockUploadFunnelPhotoToS3).not.toHaveBeenCalled();
  });

  test('rejects an oversize file before any sniff/upload', async () => {
    const files = [{ buffer: Buffer.alloc(VISIT_PREP_LIMITS.maxPhotoBytes + 1), mimetype: 'image/jpeg' }];
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck() }))
      .rejects.toMatchObject({ statusCode: 413, code: 'PREP_PHOTO_TOO_LARGE' });
  });

  test('a null recheck (visit went ineligible under the lock) rejects with the generic 404 and cleans up the upload', async () => {
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await expect(createVisitPrepSubmission({
      svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: async () => null,
    })).rejects.toMatchObject({ statusCode: 404, code: 'PREP_NOT_FOUND', message: 'Not found' });
    expect(mockUploadFunnelPhotoToS3).toHaveBeenCalledTimes(1); // it uploads BEFORE the lock, per the all-or-cleanup contract
    expect(mockDeletePhoto).toHaveBeenCalledWith('visitprep/svc-1/photo_0.jpg');
  });

  test('the write uses the RECHECKED row, not the pre-lock svc, for visit_id/customer_id/property_id', async () => {
    const inserted = [];
    mockDb.mockImplementation((table) => {
      const api = chain(table);
      if (table === 'visit_prep_submissions') {
        const originalInsert = api.insert;
        api.insert = (row) => { inserted.push(row); return originalInsert(row); };
      }
      return api;
    });
    const currentRow = { id: 'svc-1', customer_id: 'cust-RECHECKED', property_id: 'prop-RECHECKED', visit_id: 'visit-RECHECKED' };
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    const result = await createVisitPrepSubmission({
      svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck(currentRow),
    });
    expect(result.created).toBe(true);
    expect(inserted[0]).toMatchObject({ customer_id: 'cust-RECHECKED', property_id: 'prop-RECHECKED', visit_id: 'visit-RECHECKED' });
  });

  test('the customer row is locked FOR SHARE before the stop lock (createOrJoinVisit order, Codex #5306 r2 P2)', async () => {
    queries.length = 0;
    const order = [];
    mockLockStopForRow.mockImplementationOnce(async (trx, id) => { order.push('stop'); return id; });
    mockDb.mockImplementation((table) => {
      const api = chain(table);
      if (table === 'customers') api.forShare = () => { order.push('customer'); return api; };
      return api;
    });
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await createVisitPrepSubmission({
      svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck({ ...RECURRING_SVC }),
    });
    expect(order.slice(0, 2)).toEqual(['customer', 'stop']);
  });

  test('recheck is called with the SAME transaction the write uses (Finding 1) — never the global pool', async () => {
    const recheckSpy = jest.fn(async () => RECURRING_SVC);
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: recheckSpy });
    expect(recheckSpy).toHaveBeenCalledTimes(1);
    // mockDb.transaction = async (fn) => fn(mockDb) — the trx IS the global
    // mock object here, so this proves recheck receives the SAME connection
    // the write's own transaction callback runs on, not a bare re-require
    // of the plain db module.
    expect(recheckSpy).toHaveBeenCalledWith(mockDb);
  });

  test('retries VISIT_STOP_MOVED up to twice, then answers the generic 404', async () => {
    const err = Object.assign(new Error('stop moved'), { code: 'VISIT_STOP_MOVED' });
    mockLockStopForRow.mockRejectedValue(err);
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await expect(createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck() }))
      .rejects.toMatchObject({ statusCode: 404, code: 'PREP_NOT_FOUND', message: 'Not found' });
    expect(mockLockStopForRow).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  // PR 6 (tech card + push): the ONE post-commit hook lives inside this
  // function (see its own comment above `return`), so both the appointment
  // page and any future customer-auth route inherit it with no per-caller
  // wiring. visit-prep-tech-alert.js owns its own gate and silence rules —
  // here we only prove the hook fires exactly when a submission actually
  // stored something new, with the RECHECKED row's id, and never
  // for a duplicate-only resubmit.
  describe('tech alert hook (visit-prep-tech-alert.js)', () => {
    test('a new submission triggers the hook with the RECHECKED row', async () => {
      const currentRow = { id: 'svc-RECHECKED', customer_id: 'cust-1', property_id: 'prop-1', visit_id: 'visit-9' };
      const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
      const result = await createVisitPrepSubmission({
        svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck(currentRow),
      });
      expect(result.created).toBe(true);
      expect(mockNotifyTechVisitPrepPhotos).toHaveBeenCalledTimes(1);
      // Only the id: the alert re-reads technician, visit key and date live.
      expect(mockNotifyTechVisitPrepPhotos).toHaveBeenCalledWith({
        scheduledServiceId: 'svc-RECHECKED',
      });
    });

    test('a duplicate-only resubmit (nothing new stored) never triggers the hook', async () => {
      const { hashBuffer } = require('../services/service-report/photo-chain');
      const dupHash = hashBuffer(JPEG_BYTES);
      mockDb.mockImplementation((table) => {
        const api = chain(table);
        if (table === 'visit_prep_photos') api.select = async () => [{ image_sha256: dupHash }];
        return api;
      });
      const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
      const result = await createVisitPrepSubmission({
        svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck(),
      });
      expect(result.created).toBe(false);
      expect(result.stored).toBe(0);
      expect(mockNotifyTechVisitPrepPhotos).not.toHaveBeenCalled();
    });
  });
});

describe('pest read hook (PR 5)', () => {
  const { createVisitPrepSubmission } = require('../services/visit-prep');
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockImplementation((table) => chain(table));
    mockLockStopForRow.mockImplementation(async (trx, id) => id);
    mockUploadFunnelPhotoToS3.mockResolvedValue('visitprep/svc-1/photo_0.jpg');
  });
  afterEach(() => {
    delete process.env.GATE_VISIT_PREP_PEST_READ;
    delete process.env.GATE_VISIT_PREP_PLANT_READ;
    delete process.env.GATE_VISIT_FACTS;
    delete process.env.GATE_VISIT_PREP_PHOTOS;
  });
  const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

  test('gates off: the read is never dispatched', async () => {
    mockTriggerPestRead.mockClear();
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck() });
    await flushImmediate();
    expect(mockTriggerPestRead).not.toHaveBeenCalled();
  });

  test('gate on: the read starts on the next tick, after the submission returns', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    process.env.GATE_VISIT_PREP_PEST_READ = 'true';
    process.env.GATE_VISIT_FACTS = 'true';
    mockTriggerPestRead.mockClear();
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck() });
    expect(mockTriggerPestRead).not.toHaveBeenCalled();
    await flushImmediate();
    expect(mockTriggerPestRead).toHaveBeenCalledTimes(1);
    expect(mockTriggerPestRead.mock.calls[0][0]).toMatchObject({ svc: expect.objectContaining({ id: 'svc-1' }) });
  });

  test('both read gates on: ONE dispatch per upload, never one per engine (Codex #5320 r9)', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    process.env.GATE_VISIT_PREP_PEST_READ = 'true';
    process.env.GATE_VISIT_PREP_PLANT_READ = 'true';
    process.env.GATE_VISIT_FACTS = 'true';
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck() });
    await flushImmediate();
    expect(mockTriggerPestRead).toHaveBeenCalledTimes(1);
  });

  test('only the plant read gate on: the upload still dispatches', async () => {
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    process.env.GATE_VISIT_PREP_PLANT_READ = 'true';
    process.env.GATE_VISIT_FACTS = 'true';
    const files = [{ buffer: JPEG_BYTES, mimetype: 'image/jpeg' }];
    await createVisitPrepSubmission({ svc: RECURRING_SVC, files, entry: 'appointment_page', recheck: alwaysRecheck() });
    await flushImmediate();
    expect(mockTriggerPestRead).toHaveBeenCalledTimes(1);
  });
});
