// Bid Desk routes validate input before touching the database, and the feature-flag answer still carries bid_desk.
// No database is used here.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockDb = jest.fn(() => { throw new Error('the database must not be touched'); });
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.transaction = (...args) => mockDb(...args);
  db.raw = (...args) => mockDb(...args);
  db.fn = { now: () => 'now()' };
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const role = req.headers.authorization === 'Bearer admin' ? 'admin'
      : req.headers.authorization === 'Bearer tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = role;
    req.technicianId = role === 'admin' ? 'actor-1' : 'tech-1';
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/visual-service-notes', () => ({
  VISUAL_SERVICE_NOTES_FLAG: 'visual_service_notes',
  getVisualServiceNotesSettings: jest.fn(),
  isVisualServiceNotesEnabled: jest.fn(async () => false),
  setVisualServiceNotesSettings: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');

const ID = '11111111-2222-4333-8444-555555555555';
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
let server;
let baseUrl;

async function call(method, url, body, headers = admin) {
  const res = await fetch(`${baseUrl}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/bid-desk', require('../routes/admin-bid-desk'));
  app.use('/api/admin/feature-flags', require('../routes/admin-feature-flags'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => { mockDb.mockClear(); });

describe('routes', () => {
  test('the feature-flag response still carries bid_desk for older client builds', async () => {
    mockDb.mockImplementation(() => ({ where: () => ({ select: async () => [] }) }));
    const res = await call('GET', '/api/admin/feature-flags');
    expect(res.body.flags.bid_desk).toBe(true);
    mockDb.mockReset();
  });

  test('bad ids and bad bodies are refused before any query', async () => {
    mockDb.mockReset();
    mockDb.mockImplementation(() => { throw new Error('the database must not be touched'); });
    expect((await call('GET', '/api/admin/bid-desk/not-a-uuid')).status).toBe(404);
    expect((await call('PATCH', '/api/admin/bid-desk/not-a-uuid', { status: 'bid' })).status).toBe(404);
    expect((await call('PATCH', `/api/admin/bid-desk/${ID}`, { status: 'maybe' })).status).toBe(400);
    expect((await call('PATCH', `/api/admin/bid-desk/${ID}`, {})).status).toBe(400);
    expect((await call('PATCH', `/api/admin/bid-desk/${ID}`, { due_at: 'October 5' })).status).toBe(400);
    expect((await call('PATCH', `/api/admin/bid-desk/${ID}`, { buyer_email: 'x@y.test' })).status).toBe(400);
    expect((await call('PATCH', `/api/admin/bid-desk/${ID}`, { confirm_due: false })).status).toBe(400);
    expect((await call('POST', '/api/admin/bid-desk/from-email', {})).status).toBe(400);
    expect((await call('POST', '/api/admin/bid-desk/from-email', { email_id: 'abc' })).status).toBe(400);
    expect((await call('GET', '/api/admin/bid-desk', undefined, { Authorization: 'Bearer tech' })).status).toBe(403);
    expect(mockDb).not.toHaveBeenCalled();
  });
});

test('the scheduler runs the job under the cron lock', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
  const at = source.indexOf("'0 3,18,33,48 * * * *'");
  expect(at).toBeGreaterThan(-1);
  const block = source.slice(at, at + 900);
  expect(block).toContain("runExclusive('bid-desk-intake'");
  expect(block).toContain('runBidDeskTick');
});
