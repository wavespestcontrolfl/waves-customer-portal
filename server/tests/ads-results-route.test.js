/** GET /api/admin/ads/results: period handling and response shape. The service itself is covered in ads-results.test.js. */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => { req.technicianId = 'staff-1'; req.techRole = 'admin'; return next(); },
    requireAdmin: (_req, _res, next) => next(),
  };
});
const mockAdResults = jest.fn();
jest.mock('../services/ads/ad-results', () => ({ adResults: (...a) => mockAdResults(...a) }));

const express = require('express');
const { etDateString, addETDays } = require('../utils/datetime-et');
const adsRouter = require('../routes/admin-ads');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/admin/ads', adsRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  mockAdResults.mockReset();
  mockAdResults.mockImplementation(async ({ since, until }) => ({ since, until, rows: [], totals: { spend: 0 } }));
});

const get = async (query = '') => {
  const res = await fetch(`${baseUrl}/api/admin/ads/results${query}`);
  return { status: res.status, body: await res.json() };
};

test('defaults to 90 days: today and the 89 days before it', async () => {
  const { status, body } = await get();
  const today = etDateString(new Date());
  expect(status).toBe(200);
  expect(body).toEqual({ period: '90d', since: etDateString(addETDays(new Date(), -89)), until: today, rows: [], totals: { spend: 0 } });
  expect(mockAdResults).toHaveBeenCalledWith({ since: body.since, until: today });
});

test.each([['30d', 29], ['90d', 89], ['180d', 179]])('period %s covers %i days back plus today', async (period, back) => {
  const { status, body } = await get(`?period=${period}`);
  expect(status).toBe(200);
  expect(body.period).toBe(period);
  expect(body.since).toBe(etDateString(addETDays(new Date(), -back)));
});

test('an unknown period is a 400 and reads nothing', async () => {
  const { status, body } = await get('?period=7d');
  expect(status).toBe(400);
  expect(body.error).toMatch(/30d, 90d or 180d/);
  expect(mockAdResults).not.toHaveBeenCalled();
});

test('a service failure goes to the error handler', async () => {
  mockAdResults.mockRejectedValueOnce(new Error('boom'));
  const { status, body } = await get('?period=30d');
  expect(status).toBe(500);
  expect(body.error).toBe('boom');
});
