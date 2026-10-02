// Lawn assessment routes are scoped to the technician's own route and
// customers (codex #5568 r1 P1): a technician token previously listed every
// lawn customer scheduled that day (name, phone, email, address), read any
// customer's history/baseline/latest, confirmed any assessment, and could
// run the admin-only baseline reset. The real role middlewares run; only
// adminAuthenticate is stubbed to pick the role, and the ownership predicate
// is mocked so denial paths return before any other query.
let mockRole = 'technician';
let mockServices = false;
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((x) => x);
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false) }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; req.techRole = mockRole; req.technician = { id: 'tech-1', name: 'Fixture' }; next(); } };
});
jest.mock('../services/technician-visit-scope', () => ({
  isTechnicianRequest: (req) => req.techRole === 'technician',
  technicianServicesCustomer: jest.fn(async (req) => (req.techRole !== 'technician' ? true : mockServices)),
  technicianCurrentVisitFilter: jest.fn((req, q) => q),
}));
const mockGetCustomerHistory = jest.fn(async () => [{ id: 'a1' }]);
const mockGetBaseline = jest.fn(async () => ({ id: 'b1' }));
const mockResetBaseline = jest.fn(async () => ({ newBaselineId: 'b2' }));
jest.mock('../services/lawn-assessment', () => ({
  getCustomerHistory: (...a) => mockGetCustomerHistory(...a),
  getBaseline: (...a) => mockGetBaseline(...a),
  resetBaseline: (...a) => mockResetBaseline(...a),
}));
jest.mock('../services/lawn-intelligence', () => ({ flagBaselineRecapture: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-lawn-assessment');

const CUSTOMER = '11111111-2222-4333-8444-555555555555';

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/lawn-assessment', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin/lawn-assessment`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}
const call = (base, method, path, body) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = 'technician';
  mockServices = false;
  db.mockImplementation(() => { throw new Error('db must not be reached'); });
});

describe('per-customer reads and writes', () => {
  test.each([
    ['GET', `/history/${CUSTOMER}`, null],
    ['GET', `/baseline/${CUSTOMER}`, null],
    ['GET', `/latest/${CUSTOMER}`, null],
    ['POST', '/assess', { customerId: CUSTOMER, photos: [{ data: 'x', mimeType: 'image/jpeg' }] }],
  ])('%s %s → 404 for a technician who does not service the customer, before any data access', async (method, path, body) => {
    await withServer(async (base) => {
      const res = await call(base, method, path, body);
      expect(res.status).toBe(404);
    });
    expect(db).not.toHaveBeenCalled();
    expect(mockGetCustomerHistory).not.toHaveBeenCalled();
    expect(mockGetBaseline).not.toHaveBeenCalled();
  });

  test('a technician who services the customer reads history and baseline', async () => {
    mockServices = true;
    await withServer(async (base) => {
      expect(await (await call(base, 'GET', `/history/${CUSTOMER}`)).json()).toEqual({ history: [{ id: 'a1' }] });
      expect(await (await call(base, 'GET', `/baseline/${CUSTOMER}`)).json()).toEqual({ baseline: { id: 'b1' } });
    });
  });

  test('an admin is unscoped', async () => {
    mockRole = 'admin';
    await withServer(async (base) => {
      expect((await call(base, 'GET', `/history/${CUSTOMER}`)).status).toBe(200);
    });
  });
});

describe('baseline reset is admin-only', () => {
  test('a technician gets 403 before the service runs; an admin resets', async () => {
    mockServices = true;
    await withServer(async (base) => {
      const res = await call(base, 'POST', `/reset-baseline/${CUSTOMER}`, { reason: 'moved' });
      expect(res.status).toBe(403);
    });
    expect(mockResetBaseline).not.toHaveBeenCalled();
    mockRole = 'admin';
    await withServer(async (base) => {
      const res = await call(base, 'POST', `/reset-baseline/${CUSTOMER}`, { reason: 'moved' });
      expect(res.status).toBe(200);
    });
    expect(mockResetBaseline).toHaveBeenCalledTimes(1);
  });
});

describe('GET /customers', () => {
  test("a technician with no lawn stop on their route today gets an empty list, never the customer directory", async () => {
    // The only query allowed is the own-route existence probe.
    const first = jest.fn(async () => null);
    const chain = {};
    for (const m of ['where', 'whereNotIn', 'whereIn', 'whereNull', 'join', 'leftJoin', 'select', 'orderBy', 'andWhere', 'orWhere', 'whereRaw']) chain[m] = jest.fn(() => chain);
    chain.first = first;
    db.mockImplementation(() => chain);
    await withServer(async (base) => {
      const res = await call(base, 'GET', '/customers');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ customers: [] });
    });
    expect(chain.where).toHaveBeenCalledWith('ss.technician_id', 'tech-1');
    expect(chain.limit).toBeUndefined();
  });
});

describe('POST /assess binds to the submitted visit', () => {
  test("a serviceId on another technician's route → 404 even when the customer is on this technician's route", async () => {
    mockServices = true;
    const scope = require('../services/technician-visit-scope');
    scope.technicianCurrentVisitFilter.mockImplementation((req, q) => q);
    const chain = {};
    for (const m of ['where', 'whereNotIn', 'whereIn', 'whereNull', 'join', 'leftJoin', 'select', 'orderBy', 'modify']) chain[m] = jest.fn(() => chain);
    chain.first = jest.fn(async () => null); // the filtered lookup finds no owned row
    db.mockImplementation(() => chain);
    await withServer(async (base) => {
      const res = await call(base, 'POST', '/assess', { customerId: CUSTOMER, serviceId: '22222222-2222-4333-8444-555555555555', photos: [{ data: 'x', mimeType: 'image/jpeg' }] });
      expect(res.status).toBe(404);
    });
    expect(scope.technicianCurrentVisitFilter).toHaveBeenCalled();
  });
});
