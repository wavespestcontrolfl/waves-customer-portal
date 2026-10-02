// admin-dispatch pins every /:serviceId route to the technician's own
// current/recent visit once, in router.param, before the handler (codex #5568
// r2 P1: card-hold and a few other per-visit reads had no check of their own).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);
let mockRole = 'technician';
let mockOwnedRow = null;
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => { req.technician = { id: 'tech-A', role: mockRole }; req.technicianId = 'tech-A'; req.techRole = mockRole; next(); } };
});
jest.mock('../services/technician-visit-scope', () => {
  const actual = jest.requireActual('../services/technician-visit-scope');
  return { ...actual, technicianCurrentVisitFilter: jest.fn((req, q) => q) };
});
jest.mock('../models/db', () => {
  const fn = jest.fn(() => {
    const c = {};
    for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'leftJoin', 'join', 'orderBy', 'limit', 'select', 'modify']) c[m] = () => c;
    c.first = async () => mockOwnedRow;
    return c;
  });
  fn.raw = (x) => x;
  fn.transaction = async (cb) => cb(fn);
  return fn;
});
const mockCancelPreview = jest.fn(async () => ({ ok: true }));
jest.mock('../services/estimate-card-holds', () => ({ cardHoldCancelPreview: (...a) => mockCancelPreview(...a) }));

const express = require('express');
const router = require('../routes/admin-dispatch');
const SERVICE = '11111111-2222-4333-8444-555555555555';

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin/dispatch`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

beforeEach(() => { jest.clearAllMocks(); mockRole = 'technician'; mockOwnedRow = null; });

test('a technician reading /:serviceId/card-hold for a visit that does not exist gets 404 before the handler', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/${SERVICE}/card-hold`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Service not found' });
  });
  expect(mockCancelPreview).not.toHaveBeenCalled();
});

test("a technician reading another technician's visit gets the router's 403 service_not_assigned before the handler", async () => {
  mockOwnedRow = { id: SERVICE, technician_id: 'tech-B', scheduled_date: new Date().toISOString().slice(0, 10) };
  await withServer(async (base) => {
    const res = await fetch(`${base}/${SERVICE}/card-hold`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  });
  expect(mockCancelPreview).not.toHaveBeenCalled();
});

test('a technician whose route includes the visit reaches the handler', async () => {
  mockOwnedRow = { id: SERVICE, technician_id: 'tech-A', scheduled_date: new Date().toISOString().slice(0, 10) };
  await withServer(async (base) => {
    const res = await fetch(`${base}/${SERVICE}/card-hold`);
    expect(res.status).not.toBe(404);
  });
  expect(mockCancelPreview).toHaveBeenCalledWith(SERVICE);
});

test('an admin is not scoped by the param guard', async () => {
  mockRole = 'admin';
  await withServer(async (base) => { expect((await fetch(`${base}/${SERVICE}/card-hold`)).status).not.toBe(404); });
  expect(mockCancelPreview).toHaveBeenCalledWith(SERVICE);
});

test('GET /reschedules/log is admin-only', async () => {
  await withServer(async (base) => { expect((await fetch(`${base}/reschedules/log`)).status).toBe(403); });
});
