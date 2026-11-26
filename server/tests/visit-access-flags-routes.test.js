/**
 * Visit access flags on the routes (routes/admin-schedule.js):
 *  - GET /:id/visit-brief carries `accessFlags` only under GATE_VISIT_ACCESS_FLAGS=on (shadow and off leave the
 *    answer exactly as before, and read nothing); a reassignment during the read withholds the whole answer;
 *    a failed read omits the key and the brief still serves;
 *  - POST /:id/access-flags/:questionId is 404 unless the cards are live, 400 for an unknown flag or verdict, 404 for
 *    a visit that is not the technician's, and otherwise taps the flag as that technician.
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.technician = { email: 'tech@example.test' };
    req.techRole = req.headers['x-test-role'] || 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => (req.headers['x-test-role'] === 'technician' ? res.status(403).json({ error: 'Admin access required' }) : next()),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: () => ({ tag: 'pest_general', label: 'Pest Control' }),
  onServiceScheduled: jest.fn(async () => {}),
}));
jest.mock('../services/previsit-brief', () => ({
  briefGateEnabled: () => false,
  visitFactsGateEnabled: () => false,
  deterministicVisitFacts: jest.fn(async () => ({})),
  generateVisitBrief: jest.fn(),
  briefStaleReason: () => null,
  WDO_BRIEF_TYPE: 'wdo_inspection',
  VISIT_BRIEF_TYPE: 'visit_brief_v1',
}));
jest.mock('../services/away-watch', () => ({ ...jest.requireActual('../services/away-watch'), awayWatchCardLines: jest.fn(async () => null) }));
const mockAccessFlagsFor = jest.fn();
const mockTap = jest.fn();
jest.mock('../services/visit-access-flags', () => ({
  accessFlagsFor: (...a) => mockAccessFlagsFor(...a),
  tapAccessFlag: (...a) => mockTap(...a),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-schedule');

const GATES = ['GATE_TYPED_DECISIONS', 'GATE_VISIT_ACCESS_FLAGS'];
const saved = {};
beforeAll(() => { for (const k of GATES) saved[k] = process.env[k]; });
afterAll(() => { for (const k of GATES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const setGate = (value) => {
  for (const k of GATES) delete process.env[k];
  if (value) { process.env.GATE_TYPED_DECISIONS = 'true'; process.env.GATE_VISIT_ACCESS_FLAGS = value; }
};

const FLAG = { questionId: 'dog_on_property', title: 'Dog or other animal may be loose', tone: 'amber', status: 'open' };

// `owned` answers the atomic ownership-scoped fetch; `stillOwned` the recheck probe after the flags were read.
function stubVisit({ owned = true, stillOwned = true } = {}) {
  const row = { id: 'svc-1', customer_id: 'cust-1', pre_service_brief: null };
  db.mockImplementation(() => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.modify = jest.fn((cb) => { cb(q); return q; });
    q.first = jest.fn(async (...cols) => {
      if (cols[0] === 'scheduled_services.id' && cols.length === 1) return stillOwned ? { id: 'svc-1' } : undefined;
      return owned ? row : undefined;
    });
    return q;
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const call = (base, path, { method = 'GET', role = 'admin', body } = {}) => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-test-role': role }, body: body ? JSON.stringify(body) : undefined,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAccessFlagsFor.mockResolvedValue([FLAG]);
  mockTap.mockResolvedValue({ status: 'right', saved: false });
  setGate('on');
});

describe('GET /:id/visit-brief access flags', () => {
  test('on: the answer carries the flags, read for this visit', async () => {
    stubVisit();
    await withServer(async (base) => {
      const res = await call(base, '/admin/schedule/svc-1/visit-brief', { role: 'technician' });
      expect(await res.json()).toEqual({ brief: null, accessFlags: [FLAG] });
    });
    expect(mockAccessFlagsFor).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'svc-1', customer_id: 'cust-1' }));
  });

  test.each(['shadow', null])('gate %s: no key and no read', async (value) => {
    setGate(value);
    stubVisit();
    await withServer(async (base) => {
      const res = await call(base, '/admin/schedule/svc-1/visit-brief');
      expect(await res.json()).toEqual({ brief: null });
    });
    expect(mockAccessFlagsFor).not.toHaveBeenCalled();
  });

  test('no flags, or a failed read: the key is omitted and the brief still serves', async () => {
    stubVisit();
    await withServer(async (base) => {
      mockAccessFlagsFor.mockResolvedValueOnce([]);
      expect(await (await call(base, '/admin/schedule/svc-1/visit-brief')).json()).toEqual({ brief: null });
      mockAccessFlagsFor.mockResolvedValueOnce(null);
      expect(await (await call(base, '/admin/schedule/svc-1/visit-brief')).json()).toEqual({ brief: null });
    });
  });

  test('a visit reassigned while the flags were read withholds them', async () => {
    stubVisit({ stillOwned: false });
    await withServer(async (base) => {
      const res = await call(base, '/admin/schedule/svc-1/visit-brief', { role: 'technician' });
      expect(await res.json()).toEqual({ brief: null });
    });
  });
});

describe('POST /:id/access-flags/:questionId', () => {
  const tap = (base, over = {}) => call(base, `/admin/schedule/svc-1/access-flags/${over.questionId || 'dog_on_property'}`, {
    method: 'POST', role: over.role || 'technician', body: 'body' in over ? over.body : { verdict: 'right' },
  });

  test.each(['shadow', null])('gate %s: 404 before anything is read', async (value) => {
    setGate(value);
    stubVisit();
    await withServer(async (base) => {
      expect((await tap(base)).status).toBe(404);
    });
    expect(mockTap).not.toHaveBeenCalled();
  });

  test('an unknown flag or verdict is 400 and touches nothing', async () => {
    stubVisit();
    await withServer(async (base) => {
      expect((await tap(base, { questionId: 'constructor' })).status).toBe(400);
      expect((await tap(base, { questionId: 'not_a_question' })).status).toBe(400);
      expect((await tap(base, { body: { verdict: 'maybe' } })).status).toBe(400);
      expect((await tap(base, { body: undefined })).status).toBe(400);
    });
    expect(mockTap).not.toHaveBeenCalled();
  });

  test('a technician who is not assigned the visit gets 404 and no tap', async () => {
    stubVisit({ owned: false });
    await withServer(async (base) => {
      expect((await tap(base)).status).toBe(404);
    });
    expect(mockTap).not.toHaveBeenCalled();
  });

  test('the assigned technician taps: the flag is labeled as that technician and the status comes back', async () => {
    stubVisit();
    mockTap.mockResolvedValueOnce({ status: 'right', saved: true });
    await withServer(async (base) => {
      const res = await tap(base);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'right', saved: true });
    });
    expect(mockTap).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'svc-1' }), { questionId: 'dog_on_property', verdict: 'right' },
      expect.objectContaining({ labeledBy: 'tech@example.test', actorId: 'tech-1' }));
  });

  test('no saved key unless the pet line was written; a visit with no such flag is 404', async () => {
    stubVisit();
    await withServer(async (base) => {
      mockTap.mockResolvedValueOnce({ status: 'wrong', saved: false });
      expect(await (await tap(base, { body: { verdict: 'wrong' } })).json()).toEqual({ status: 'wrong' });
      mockTap.mockResolvedValueOnce(null);
      expect((await tap(base)).status).toBe(404);
    });
  });
});
