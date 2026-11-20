/**
 * /api/admin/prospects: staff-only, read-only Builders list. Input is checked before the service runs.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockRole = 'admin';
const mockList = jest.fn();
const mockPermits = jest.fn();

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: mockRole };
      req.technicianId = 'staff-1';
      req.techRole = mockRole;
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn(() => { throw new Error('the route reads no table itself'); }));
jest.mock('../services/prospects/builder-list', () => ({
  KINDS: ['pool', 'home'],
  listBuilders: (...args) => mockList(...args),
  builderPermits: (...args) => mockPermits(...args),
}));

const express = require('express');
const router = require('../routes/admin-prospects');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/admin/prospects', router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });
beforeEach(() => { mockRole = 'admin'; mockList.mockReset(); mockPermits.mockReset(); });

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('GET /builders', () => {
  test('defaults to pool builders and returns the service answer', async () => {
    mockList.mockResolvedValue({ kind: 'pool', dataThrough: '2026-11-16', week: { from: '2026-11-10', through: '2026-11-16', permits: 3, builders: 2 }, builders: [] });
    const res = await get('/api/admin/prospects/builders');
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith({ kind: 'pool' });
    expect(res.body.week).toEqual({ from: '2026-11-10', through: '2026-11-16', permits: 3, builders: 2 });
  });

  test('passes kind=home through', async () => {
    mockList.mockResolvedValue({ kind: 'home', builders: [] });
    await get('/api/admin/prospects/builders?kind=home');
    expect(mockList).toHaveBeenCalledWith({ kind: 'home' });
  });

  test.each(['kind=roof', 'kind=pool&extra=1'])('%s is a 400 and the service never runs', async (query) => {
    const res = await get(`/api/admin/prospects/builders?${query}`);
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('a service failure is a 500 with a plain sentence, not the error text', async () => {
    mockList.mockRejectedValue(new Error('relation does not exist'));
    const res = await get('/api/admin/prospects/builders');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not load the builders list.');
  });

  test('a technician who is not an admin is refused', async () => {
    mockRole = 'technician';
    const res = await get('/api/admin/prospects/builders');
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('GET /builders/permits', () => {
  test('returns the builder permits for the key', async () => {
    mockPermits.mockResolvedValue([{ id: 'P-1', issuedDate: '2026-11-16', status: 'Permit Issued', address: '200 SAMPLE TRL', city: 'PARRISH', zip: '34219', typeOfWork: null }]);
    const res = await get('/api/admin/prospects/builders/permits?kind=pool&builder=SAMPLE%20POOLS');
    expect(res.status).toBe(200);
    expect(mockPermits).toHaveBeenCalledWith({ kind: 'pool', key: 'SAMPLE POOLS' });
    expect(res.body.permits).toHaveLength(1);
  });

  test.each(['kind=pool', 'kind=pool&builder=', 'kind=bad&builder=X', `builder=${'A'.repeat(201)}`])('%s is a 400', async (query) => {
    const res = await get(`/api/admin/prospects/builders/permits?${query}`);
    expect(res.status).toBe(400);
    expect(mockPermits).not.toHaveBeenCalled();
  });
});
