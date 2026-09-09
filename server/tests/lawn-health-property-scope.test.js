/**
 * App property scope, PR 4 — GET /lawn-health/:customerId (+ /history) hand
 * the SESSION's selected saved property to the per-property history reader
 * (#4039, behind GATE_LAWN_PROPERTY_HISTORY) and echo the resolved scope;
 * no selection / gate off = the reader's own default, no echo.
 */
jest.mock('../models/db', () => { const fn = jest.fn(); fn.raw = jest.fn((s) => s); return fn; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/photos', () => null);
jest.mock('../services/turf-height-service', () => ({ getLatestTurfHeight: jest.fn(async () => null), getTurfHeightTrend: jest.fn(async () => []) }));
jest.mock('../services/service-report/turf-height', () => ({ buildMowingHeightContext: jest.fn(() => null) }));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn((k) => k === 'GATE_LAWN_PROPERTY_HISTORY' && global.__LAWN_GATE__ === true), isEnabled: jest.fn(() => false) }));
jest.mock('../services/lawn-assessment-history', () => ({
  visitEligibility: jest.fn(async ({ customerId, propertyId }) => ({ customerId, propertyId: propertyId || null })),
  eligibleVisitIds: jest.fn(async () => []),
  latestForCustomer: jest.fn(async () => []),
}));
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return { ...actual, resolveSessionScope: jest.fn(async () => global.__SCOPE__) };
});
jest.mock('../middleware/auth', () => ({ authenticate: (req, _res, next) => { req.customerId = 'cust-1'; req.customer = { id: 'cust-1', active: true }; next(); } }));

const express = require('express');
const db = require('../models/db');
const History = require('../services/lawn-assessment-history');
const router = require('../routes/lawn-health');

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'select', 'orderBy', 'limit', 'first']) c[m] = jest.fn(() => c);
  c.first = jest.fn(async () => rows[0]);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}
let server; let base;
beforeAll((done) => {
  const app = express();
  app.use('/lawn-health', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  global.__LAWN_GATE__ = true;
  db.mockImplementation(() => chain([]));
});

const SECONDARY = { customerId: 'cust-1', enabled: true, multi: true, scoped: true, closed: false, property: { id: 'prop-b', is_primary: false } };
const OFF = { customerId: 'cust-1', enabled: false, multi: false, scoped: false, closed: false, property: null };

describe('GET /lawn-health/:customerId under the saved-property scope', () => {
  test('the selected saved property reaches the history reader and the scope is echoed', async () => {
    global.__SCOPE__ = SECONDARY;
    const res = await fetch(`${base}/lawn-health/cust-1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(History.visitEligibility).toHaveBeenCalledWith({ customerId: 'cust-1', propertyId: 'prop-b' }, expect.anything());
    expect(History.latestForCustomer).toHaveBeenCalledWith('cust-1', { propertyId: 'prop-b' }, expect.anything());
    expect(body.propertyScope).toEqual({ enabled: true, propertyId: 'prop-b', closed: false });
  });
  test('gate off: the reader gets no property (its own default) and nothing is echoed', async () => {
    global.__SCOPE__ = OFF;
    const res = await fetch(`${base}/lawn-health/cust-1`);
    const body = await res.json();
    expect(History.visitEligibility).toHaveBeenCalledWith({ customerId: 'cust-1', propertyId: undefined }, expect.anything());
    expect(body.propertyScope).toBeUndefined();
  });
  test('history: the same session property', async () => {
    global.__SCOPE__ = SECONDARY;
    const res = await fetch(`${base}/lawn-health/cust-1/history`);
    expect(res.status).toBe(200);
    expect(History.latestForCustomer).toHaveBeenCalledWith('cust-1', { propertyId: 'prop-b' }, expect.anything());
  });
  test('another customer id is forbidden', async () => {
    global.__SCOPE__ = SECONDARY;
    expect((await fetch(`${base}/lawn-health/cust-2`)).status).toBe(403);
  });
});
