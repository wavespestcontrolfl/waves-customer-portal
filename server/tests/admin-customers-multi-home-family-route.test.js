/**
 * GET / POST / DELETE /admin/customers/:id/multi-home-family ("Same family" link, owner 2026-11-04): admin only,
 * validates ids before touching the service, answers with the familyMembers shape, and passes the actor through.
 * The service itself is proven on Postgres in multi-home-family-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const mockAuth = { role: 'admin' };
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = mockAuth.role; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const db = () => { throw new Error('db must not be touched by this route test'); };
  db.transaction = jest.fn();
  db.schema = { hasTable: jest.fn(async () => false) };
  return db;
});
const SHAPE = { familyId: 'fam-1', members: [{ id: 'a', name: 'Sample One', address: '1 Example Way, Sarasota, FL 34231', active: true, isSelf: true }] };
const mockMembers = jest.fn(async () => SHAPE);
const mockLink = jest.fn(async () => SHAPE);
const mockUnlink = jest.fn(async () => ({ familyId: null, members: [] }));
jest.mock('../services/multi-home-family', () => ({
  ...jest.requireActual('../services/multi-home-family'),
  familyMembers: (...args) => mockMembers(...args),
  linkFamily: (...args) => mockLink(...args),
  unlinkFamily: (...args) => mockUnlink(...args),
}));

const express = require('express');
const router = require('../routes/admin-customers');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}
const call = (baseUrl, method, id, body) => fetch(`${baseUrl}/admin/customers/${id}/multi-home-family`, {
  method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => { jest.clearAllMocks(); mockAuth.role = 'admin'; });

test('GET answers with the family shape', async () => {
  await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'GET', A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SHAPE);
  });
  expect(mockMembers).toHaveBeenCalledWith(expect.anything(), A);
});

test('POST links the other profile and passes the actor', async () => {
  await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'POST', A, { otherCustomerId: B });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SHAPE);
  });
  expect(mockLink).toHaveBeenCalledWith(expect.anything(), { customerId: A, otherCustomerId: B, actorId: 'admin-1' });
});

test.each([[{}], [{ otherCustomerId: 'not-a-uuid' }], [{ otherCustomerId: 5 }]])('POST refuses %j before the service runs', async (body) => {
  await withServer(async (baseUrl) => { expect((await call(baseUrl, 'POST', A, body)).status).toBe(400); });
  expect(mockLink).not.toHaveBeenCalled();
});

test('a bad customer id is a 400 on every verb', async () => {
  await withServer(async (baseUrl) => {
    expect((await call(baseUrl, 'GET', 'nope')).status).toBe(400);
    expect((await call(baseUrl, 'POST', 'nope', { otherCustomerId: B })).status).toBe(400);
    expect((await call(baseUrl, 'DELETE', 'nope')).status).toBe(400);
  });
  expect(mockMembers).not.toHaveBeenCalled();
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockUnlink).not.toHaveBeenCalled();
});

test('DELETE unlinks and answers with the empty family', async () => {
  await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'DELETE', A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ familyId: null, members: [] });
  });
  expect(mockUnlink).toHaveBeenCalledWith(expect.anything(), { customerId: A, actorId: 'admin-1' });
});

test('a service refusal keeps its status (two different families is a 409)', async () => {
  mockLink.mockRejectedValue(Object.assign(new Error('Both profiles are already in different families. Unlink one first.'), { status: 409 }));
  await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'POST', A, { otherCustomerId: B });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/different families/);
  });
});

test('a technician token gets 403 on every verb and nothing runs', async () => {
  mockAuth.role = 'technician';
  await withServer(async (baseUrl) => {
    expect((await call(baseUrl, 'GET', A)).status).toBe(403);
    expect((await call(baseUrl, 'POST', A, { otherCustomerId: B })).status).toBe(403);
    expect((await call(baseUrl, 'DELETE', A)).status).toBe(403);
  });
  expect(mockMembers).not.toHaveBeenCalled();
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockUnlink).not.toHaveBeenCalled();
});
