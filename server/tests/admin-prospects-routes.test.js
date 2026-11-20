/**
 * /api/admin/prospects: staff-only, read-only Builders and Restaurants lists. Input is checked before the service runs.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockRole = 'admin';
const mockList = jest.fn();
const mockPermits = jest.fn();
const mockRestaurants = jest.fn();

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
jest.mock('../services/prospects/restaurant-list', () => ({
  PERIODS: [30, 90],
  listRestaurants: (...args) => mockRestaurants(...args),
}));

const express = require('express');
const logger = require('../services/logger');
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
beforeEach(() => { mockRole = 'admin'; mockList.mockReset(); mockPermits.mockReset(); mockRestaurants.mockReset(); });

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

  test('a service failure is a 500 with a plain sentence; the log carries the error code, not the error text', async () => {
    logger.error.mockClear();
    mockList.mockRejectedValue(Object.assign(new Error('select ... - relation does not exist'), { code: '42P01' }));
    const res = await get('/api/admin/prospects/builders');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not load the builders list.');
    expect(logger.error).toHaveBeenCalledWith('[admin-prospects] builders list failed (42P01)');
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

  test('a failed read never writes the builder name to the log (knex puts bound values in its message)', async () => {
    logger.error.mockClear();
    mockPermits.mockRejectedValue(Object.assign(new Error("select ... where name in ('JOHN SAMPLE POOLS') - timeout"), { code: '57014' }));
    const res = await get('/api/admin/prospects/builders/permits?kind=pool&builder=JOHN%20SAMPLE%20POOLS');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not load that builder’s permits.');
    expect(logger.error).toHaveBeenCalledWith('[admin-prospects] builder permits failed (57014)');
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/JOHN/);
  });

  test.each(['kind=pool', 'kind=pool&builder=', 'kind=bad&builder=X', `builder=${'A'.repeat(201)}`])('%s is a 400', async (query) => {
    const res = await get(`/api/admin/prospects/builders/permits?${query}`);
    expect(res.status).toBe(400);
    expect(mockPermits).not.toHaveBeenCalled();
  });
});

describe('GET /restaurants', () => {
  test('defaults to 30 days and returns the service answer', async () => {
    mockRestaurants.mockResolvedValue({ days: 30, from: '2026-10-21', through: '2026-11-19', readAt: null, counts: { new_restaurant: 0, new_owner: 0, pest_finding: 0 }, rows: [] });
    const res = await get('/api/admin/prospects/restaurants');
    expect(res.status).toBe(200);
    expect(mockRestaurants).toHaveBeenCalledWith({ days: 30 });
    expect(res.body.through).toBe('2026-11-19');
  });

  test('passes days=90 through as a number', async () => {
    mockRestaurants.mockResolvedValue({ days: 90, rows: [] });
    await get('/api/admin/prospects/restaurants?days=90');
    expect(mockRestaurants).toHaveBeenCalledWith({ days: 90 });
  });

  test.each(['days=7', 'days=abc', 'days=30.5', 'days=30&extra=1'])('%s is a 400 and the service never runs', async (query) => {
    const res = await get(`/api/admin/prospects/restaurants?${query}`);
    expect(res.status).toBe(400);
    expect(mockRestaurants).not.toHaveBeenCalled();
  });

  test('a service failure is a 500 with a plain sentence; the log carries the error code, not the error text', async () => {
    logger.error.mockClear();
    mockRestaurants.mockRejectedValue(Object.assign(new Error('select ... - relation does not exist'), { code: '42P01' }));
    const res = await get('/api/admin/prospects/restaurants');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not load the restaurants list.');
    expect(logger.error).toHaveBeenCalledWith('[admin-prospects] restaurants list failed (42P01)');
  });

  test('a technician who is not an admin is refused', async () => {
    mockRole = 'technician';
    const res = await get('/api/admin/prospects/restaurants');
    expect(res.status).toBe(403);
    expect(mockRestaurants).not.toHaveBeenCalled();
  });
});
