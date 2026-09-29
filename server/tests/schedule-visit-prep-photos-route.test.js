// POST /api/schedule/:id/prep-photos — the Waves app's customer-authenticated
// twin of the public appointment-page photo route (visit prep photos PR 4).
// Route wiring only: gate, ownership, eligibility, multipart, entry='app',
// the locked ownership recheck, and the response shape. Storage, caps and
// dedupe live in visit-prep.js and are covered by its own suites.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
// One limiter instance lives for the whole file; stub it so the case count
// never trips the 6/min budget. The limiter itself is plain express-rate-limit.
const mockLimiterOptions = [];
jest.mock('express-rate-limit', () => {
  const fn = (opts) => { mockLimiterOptions.push(opts); return (_req, _res, next) => next(); };
  fn.rateLimit = fn;
  fn.default = fn;
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/auth', () => {
  const asCustomer = (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', active: true };
    next();
  };
  return { ...jest.requireActual('../middleware/auth'), authenticate: asCustomer, authenticateAllowInactive: asCustomer };
});

const mockScope = { enabled: true, scoped: true, property: { id: 'prop-7', is_primary: false } };
const mockResolveScope = jest.fn(async () => mockScope);
const mockApplyPredicate = jest.fn((qb) => qb);
jest.mock('../services/account-properties', () => ({
  ...jest.requireActual('../services/account-properties'),
  resolveSessionScope: (...args) => mockResolveScope(...args),
  applyPropertyPredicate: (...args) => mockApplyPredicate(...args),
}));

const mockCreate = jest.fn();
jest.mock('../services/visit-prep', () => ({
  ...jest.requireActual('../services/visit-prep'),
  createVisitPrepSubmission: (...args) => mockCreate(...args),
}));

const mockDeriveEligibility = jest.fn();
const mockRecheckCore = jest.fn();
const mockNotifyOffice = jest.fn();
jest.mock('../routes/appointment-public', () => {
  const multer = require('multer');
  return {
    deriveVisitPrepEligibility: (...args) => mockDeriveEligibility(...args),
    reloadEligibleVisitPrepRowCore: (...args) => mockRecheckCore(...args),
    notifyOfficeVisitPrepSubmission: (...args) => mockNotifyOffice(...args),
    visitPrepUpload: multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }),
  };
});

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/schedule');

const OWN_VISIT = {
  id: '11111111-1111-4111-8111-111111111111', customer_id: 'cust-1', property_id: 'prop-7', visit_id: null, status: 'confirmed',
};

function chain(result) {
  const c = {};
  for (const m of ['where', 'whereNull', 'forShare', 'forUpdate']) c[m] = jest.fn(() => c);
  c.first = jest.fn(async () => result);
  return c;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function photoForm(note) {
  const form = new FormData();
  form.append('photos', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), 'bug.jpg');
  if (note) form.append('note', note);
  return form;
}

describe('POST /api/schedule/:id/prep-photos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    db.mockImplementation(() => chain(OWN_VISIT));
    mockDeriveEligibility.mockResolvedValue({ eligible: true });
    mockCreate.mockResolvedValue({
      created: true, stored: 1, svc: OWN_VISIT, summary: { photoCount: 1, photosRemaining: 5, submissionCount: 1 },
    });
  });

  afterAll(() => { delete process.env.GATE_VISIT_PREP_PHOTOS; });

  test('gate off → 404 before any lookup', async () => {
    delete process.env.GATE_VISIT_PREP_PHOTOS;
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/11111111-1111-4111-8111-111111111111/prep-photos`, { method: 'POST', body: photoForm() });
      expect(res.status).toBe(404);
    });
    expect(db).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("another customer's visit → the same generic 404, nothing stored", async () => {
    db.mockImplementation(() => chain({ ...OWN_VISIT, customer_id: 'cust-OTHER' }));
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/11111111-1111-4111-8111-111111111111/prep-photos`, { method: 'POST', body: photoForm() });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a malformed visit id → the same 404, never reaching the uuid column', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/not-a-uuid/prep-photos`, { method: 'POST', body: photoForm() });
      expect(res.status).toBe(404);
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('unknown visit → 404', async () => {
    db.mockImplementation(() => chain(null));
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/22222222-2222-4222-8222-222222222222/prep-photos`, { method: 'POST', body: photoForm() });
      expect(res.status).toBe(404);
    });
  });

  test('ineligible visit (one-time, en route, etc.) → 404', async () => {
    mockDeriveEligibility.mockResolvedValue({ eligible: false });
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/11111111-1111-4111-8111-111111111111/prep-photos`, { method: 'POST', body: photoForm() });
      expect(res.status).toBe(404);
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('happy path: 201, entry=app, the visit row (with its own property) is stored, office item fires', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/11111111-1111-4111-8111-111111111111/prep-photos`, { method: 'POST', body: photoForm('Ants by the slider') });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        ok: true,
        prepPhotos: { eligible: true, photoCount: 1, photosRemaining: 5, photosAdded: 1 },
      });
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0][0];
    expect(args.entry).toBe('app');
    expect(args.note).toBe('Ants by the slider');
    expect(args.svc).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', customer_id: 'cust-1', property_id: 'prop-7' });
    expect(args.files).toHaveLength(1);
    expect(typeof args.recheck).toBe('function');
    expect(mockNotifyOffice).toHaveBeenCalledTimes(1);
    // The session's saved-property scope was applied to the lookup.
    expect(mockApplyPredicate).toHaveBeenCalledWith(expect.anything(), mockScope);
  });

  test('a visit outside the session property scope → the same generic 404', async () => {
    // The scoped lookup matches nothing.
    db.mockImplementation(() => chain(null));
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/11111111-1111-4111-8111-111111111111/prep-photos`, { method: 'POST', body: photoForm() });
      expect(res.status).toBe(404);
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('duplicate-only resubmit → 200, no office item', async () => {
    mockCreate.mockResolvedValue({
      created: false, stored: 0, svc: OWN_VISIT, summary: { photoCount: 1, photosRemaining: 5, submissionCount: 1 },
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/11111111-1111-4111-8111-111111111111/prep-photos`, { method: 'POST', body: photoForm() });
      expect(res.status).toBe(200);
      expect((await res.json()).prepPhotos.photosAdded).toBe(0);
    });
    expect(mockNotifyOffice).not.toHaveBeenCalled();
  });

  test('a visit-prep error keeps its status and code (409 cap)', async () => {
    const err = Object.assign(new Error('This visit already has the most photos it can take.'), {
      visitPrep: true, statusCode: 409, code: 'PREP_CAP_REACHED',
    });
    mockCreate.mockRejectedValue(err);
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/11111111-1111-4111-8111-111111111111/prep-photos`, { method: 'POST', body: photoForm() });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PREP_CAP_REACHED');
    });
  });

  test('the upload has its own per-customer limiter', () => {
    const opts = mockLimiterOptions.find((o) => o.message?.error === 'Too many attempts. Please try again in a minute.'
      && o.keyGenerator?.({ customerId: 'cust-1' }) === 'visit-prep-app:cust-1');
    expect(opts).toBeTruthy();
    expect(opts.max).toBe(6);
  });

  describe('the locked recheck', () => {
    async function captureRecheck() {
      await withServer(async (base) => {
        await fetch(`${base}/schedule/11111111-1111-4111-8111-111111111111/prep-photos`, { method: 'POST', body: photoForm() });
      });
      return mockCreate.mock.calls[0][0].recheck;
    }

    function fakeTrx({ customer = { id: 'cust-1', active: true }, svc = OWN_VISIT } = {}) {
      const calls = [];
      const trx = (table) => {
        const c = chain(table === 'customers' ? customer : svc);
        calls.push({ table, c });
        return c;
      };
      trx.calls = calls;
      return trx;
    }

    test('locks the customer FOR SHARE, then the visit FOR UPDATE, then re-derives eligibility', async () => {
      const recheck = await captureRecheck();
      mockRecheckCore.mockResolvedValue(OWN_VISIT);
      const trx = fakeTrx();
      await expect(recheck(trx)).resolves.toEqual(OWN_VISIT);
      expect(trx.calls[0].table).toBe('customers');
      expect(trx.calls[0].c.forShare).toHaveBeenCalled();
      expect(trx.calls[1].c.forUpdate).toHaveBeenCalled();
      expect(mockRecheckCore).toHaveBeenCalledWith(expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111', customer_active: true }), trx);
    });

    test('a visit that moved to another customer under the lock → null (nothing stored)', async () => {
      const recheck = await captureRecheck();
      const trx = fakeTrx({ svc: { ...OWN_VISIT, customer_id: 'cust-OTHER' } });
      await expect(recheck(trx)).resolves.toBeNull();
      expect(mockRecheckCore).not.toHaveBeenCalled();
    });

    test('a visit moved to another property under the lock → null (nothing stored)', async () => {
      const recheck = await captureRecheck();
      const trx = fakeTrx({ svc: { ...OWN_VISIT, property_id: 'prop-OTHER' } });
      await expect(recheck(trx)).resolves.toBeNull();
      expect(mockRecheckCore).not.toHaveBeenCalled();
    });

    test('a deleted customer → null', async () => {
      const recheck = await captureRecheck();
      const trx = fakeTrx({ customer: null });
      await expect(recheck(trx)).resolves.toBeNull();
    });
  });
});
