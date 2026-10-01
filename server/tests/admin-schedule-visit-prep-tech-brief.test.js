/**
 * PR 3a (customer photos before a visit, tech Visit Brief surface) —
 * routes/admin-schedule.js's two additions:
 *  - GET /:id/visit-prep-photos: signed-URL thumbnails endpoint, gated on
 *    GATE_VISIT_PREP_PHOTOS, authorized EXACTLY like GET /:id/visit-brief
 *    (technicianCurrentVisitFilter ownership scoping + a reassignment
 *    recheck after the signing work).
 *  - GET /:id/visit-brief's tech_seen_at stamp: fired only for the
 *    ASSIGNED TECHNICIAN (never an admin/dispatcher preview), only when
 *    facts.customerFlagged is non-empty, best-effort (a stamp failure
 *    never fails the brief read).
 *
 * Pattern: real router + real technician-visit-scope (unmocked — its
 * predicate is itself under test via the fake query builder), stubbed
 * adminAuthenticate/requireTechOrAdmin (role switchable per request),
 * services/previsit-brief and services/visit-prep mocked at the module
 * boundary (their own behavior is proven in previsit-brief-routes.test.js,
 * previsit-brief-customer-flagged.test.js and visit-prep-tech-facts.test.js).
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = req.headers['x-test-role'] || 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.headers['x-test-role'] === 'technician'
      ? res.status(403).json({ error: 'Admin access required' })
      : next()
  ),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockOnServiceScheduled = jest.fn(async () => {});
jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: () => ({ tag: 'pest_general', label: 'Pest Control' }),
  onServiceScheduled: (...args) => mockOnServiceScheduled(...args),
}));
const mockFactsGateEnabled = jest.fn(() => true);
const mockDeterministicVisitFacts = jest.fn(async () => ({ access: null, last_visit: null }));
jest.mock('../services/previsit-brief', () => ({
  briefGateEnabled: () => false,
  visitFactsGateEnabled: (...args) => mockFactsGateEnabled(...args),
  deterministicVisitFacts: (...args) => mockDeterministicVisitFacts(...args),
  generateVisitBrief: jest.fn(),
  briefStaleReason: () => null,
  WDO_BRIEF_TYPE: 'wdo_inspection',
  VISIT_BRIEF_TYPE: 'visit_brief_v1',
}));
const mockVisitPrepPhotosLive = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({
  visitPrepPhotosLive: (...args) => mockVisitPrepPhotosLive(...args),
}));
const mockStopPhotoViewUrls = jest.fn(async () => []);
jest.mock('../services/visit-prep', () => ({
  stopPhotoViewUrls: (...args) => mockStopPhotoViewUrls(...args),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');
const logger = require('../services/logger');

const SVC_ROW = {
  id: 'svc-1',
  service_type: 'Pest Control Service',
  scheduled_date: '2026-08-13',
  pre_service_brief: null,
  pre_service_brief_type: null,
  pre_service_brief_generated_at: null,
};

// ownsVisit drives the FIRST ownership-scoped fetch (the atomic
// scheduled_services.* read); recheckOwns (default: follow ownsVisit)
// drives the id-only probe used by BOTH the visit-brief facts recheck and
// the thumbnails route's post-signing recheck — a test can diverge them to
// simulate a reassignment landing mid-request.
function stubScheduledServices({ ownsVisit = true, recheckOwns = null } = {}) {
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereIn = jest.fn((col, vals) => { q._whereIn = { col, vals }; return q; });
    q.whereNotIn = jest.fn(() => q);
    q.whereNot = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.modify = jest.fn((cb) => { cb(q); return q; });
    q.first = jest.fn(async (...cols) => {
      if (table !== 'scheduled_services') return undefined;
      if (cols[0] === 'scheduled_services.id') return (recheckOwns ?? ownsVisit) ? { id: 'svc-1' } : undefined;
      if (cols[0] === 'scheduled_services.*') return ownsVisit ? SVC_ROW : undefined;
      return undefined;
    });
    q.update = jest.fn(async (patch) => {
      db.__updates.push({ table, whereIn: q._whereIn, patch });
      return 1;
    });
    return q;
  });
  db.__updates = [];
}

jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  dbFn.__updates = [];
  return dbFn;
});

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function get(base, path, role) {
  return fetch(`${base}/admin/schedule/${path}`, { headers: role ? { 'x-test-role': role } : {} });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFactsGateEnabled.mockReturnValue(true);
  mockVisitPrepPhotosLive.mockReturnValue(true);
  mockDeterministicVisitFacts.mockResolvedValue({ access: null, last_visit: null });
  mockStopPhotoViewUrls.mockResolvedValue([]);
});

describe('GET /:id/visit-prep-photos', () => {
  test('gate off → 404, stopPhotoViewUrls never called', async () => {
    mockVisitPrepPhotosLive.mockReturnValue(false);
    stubScheduledServices({ ownsVisit: true });
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-prep-photos', 'technician');
      expect(res.status).toBe(404);
      expect(mockStopPhotoViewUrls).not.toHaveBeenCalled();
    });
  });

  test('the assigned technician gets signed thumbnails', async () => {
    stubScheduledServices({ ownsVisit: true });
    mockStopPhotoViewUrls.mockResolvedValue([{ id: 'photo-1', submissionId: 'sub-1', url: 'signed://a' }]);
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-prep-photos', 'technician');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.photos).toEqual([{ id: 'photo-1', submissionId: 'sub-1', url: 'signed://a' }]);
      expect(mockStopPhotoViewUrls).toHaveBeenCalledWith(SVC_ROW);
    });
  });

  test('an admin/office request is unscoped and also gets the thumbnails', async () => {
    stubScheduledServices({ ownsVisit: true });
    mockStopPhotoViewUrls.mockResolvedValue([{ id: 'photo-1', submissionId: 'sub-1', url: 'signed://a' }]);
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-prep-photos', 'admin');
      expect(res.status).toBe(200);
    });
  });

  test('another (non-assigned) technician gets a generic 404, same shape as an unknown visit', async () => {
    stubScheduledServices({ ownsVisit: false });
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-prep-photos', 'technician');
      expect(res.status).toBe(404);
      expect(mockStopPhotoViewUrls).not.toHaveBeenCalled();
    });
  });

  test('a technician reassigned away DURING the signing work gets 404, not the already-signed urls', async () => {
    // Owned at the first fetch, but the post-signing recheck fails —
    // models a dispatch reassignment landing between the two.
    stubScheduledServices({ ownsVisit: true, recheckOwns: false });
    mockStopPhotoViewUrls.mockResolvedValue([{ id: 'photo-1', submissionId: 'sub-1', url: 'signed://leaked' }]);
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-prep-photos', 'technician');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/leaked/);
      // The signing DID happen (it has to, to know what to withhold) —
      // this proves the route withholds the RESULT, not that it skips
      // the work.
      expect(mockStopPhotoViewUrls).toHaveBeenCalled();
    });
  });
});

describe('GET /:id/visit-brief — tech_seen_at stamp', () => {
  const FLAGGED = [{ id: 'sub-1', sentAt: '2026-09-30T23:42:00.000Z', topic: 'lawn', locationOnProperty: 'back_yard', note: 'x', photoIds: ['p1'] }];

  test('the assigned technician stamps tech_seen_at once, whereNull-guarded', async () => {
    stubScheduledServices({ ownsVisit: true });
    mockDeterministicVisitFacts.mockResolvedValue({ access: null, last_visit: null, customerFlagged: FLAGGED });
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-brief', 'technician');
      expect(res.status).toBe(200);
      const update = db.__updates.find((u) => u.table === 'visit_prep_submissions');
      expect(update).toBeDefined();
      expect(update.whereIn).toEqual({ col: 'id', vals: ['sub-1'] });
      expect(update.patch).toEqual({ tech_seen_at: 'NOW' });
    });
  });

  test('an admin/dispatcher preview of the same stop does NOT stamp', async () => {
    stubScheduledServices({ ownsVisit: true });
    mockDeterministicVisitFacts.mockResolvedValue({ access: null, last_visit: null, customerFlagged: FLAGGED });
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-brief', 'admin');
      expect(res.status).toBe(200);
      expect(db.__updates.find((u) => u.table === 'visit_prep_submissions')).toBeUndefined();
    });
  });

  test('no customerFlagged on the facts → no stamp attempted', async () => {
    stubScheduledServices({ ownsVisit: true });
    mockDeterministicVisitFacts.mockResolvedValue({ access: null, last_visit: null });
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-brief', 'technician');
      expect(res.status).toBe(200);
      expect(db.__updates.find((u) => u.table === 'visit_prep_submissions')).toBeUndefined();
    });
  });

  test('a stamp failure is best-effort: the brief still serves 200 and a warning is logged', async () => {
    stubScheduledServices({ ownsVisit: true });
    mockDeterministicVisitFacts.mockResolvedValue({ access: null, last_visit: null, customerFlagged: FLAGGED });
    db.mockImplementation((table) => {
      const q = {};
      q.where = jest.fn(() => q);
      q.whereIn = jest.fn(() => q);
      q.whereNotIn = jest.fn(() => q);
      q.whereNot = jest.fn(() => q);
      q.whereNull = jest.fn(() => q);
      q.modify = jest.fn((cb) => { cb(q); return q; });
      q.first = jest.fn(async (...cols) => {
        if (table !== 'scheduled_services') return undefined;
        if (cols[0] === 'scheduled_services.id') return { id: 'svc-1' };
        if (cols[0] === 'scheduled_services.*') return SVC_ROW;
        return undefined;
      });
      q.update = jest.fn(async () => { throw new Error('db unavailable'); });
      return q;
    });
    await withServer(async (base) => {
      const res = await get(base, 'svc-1/visit-brief', 'technician');
      expect(res.status).toBe(200);
      // Give the fire-and-forget update() rejection's .catch a turn to run.
      await new Promise((resolve) => setImmediate(resolve));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tech_seen_at stamp failed'));
    });
  });
});
