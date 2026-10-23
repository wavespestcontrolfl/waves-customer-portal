// Bid Desk checklist dark gate (GATE_BID_CHECKLIST). Off: the new PATCH fields are refused, the checklist and estimate
// routes answer 404, no new reminder runs, and the existing reminder query is the one it always was. On: bad ids and
// bad bodies are refused before any query. The mocked database throws if it is touched when it must not be.
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
    req.techRole = req.headers.authorization === 'Bearer admin' ? 'admin' : 'technician';
    req.technicianId = 'actor-1';
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const service = require('../services/bid-desk');
const { bidChecklistLive } = require('../config/feature-gates');

const ID = '11111111-2222-4333-8444-555555555555';
const ITEM = '99999999-2222-4333-8444-555555555555';
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
let server;
let baseUrl;

async function call(method, url, body) {
  const res = await fetch(`${baseUrl}/api/admin/bid-desk${url}`, { method, headers: admin, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/bid-desk', require('../routes/admin-bid-desk'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
beforeEach(() => { mockDb.mockReset(); mockDb.mockImplementation(() => { throw new Error('the database must not be touched'); }); delete process.env.GATE_BID_DESK; delete process.env.GATE_BID_CHECKLIST; });
afterEach(() => { delete process.env.GATE_BID_DESK; delete process.env.GATE_BID_CHECKLIST; });

const NEW_FIELDS = [
  { solicitationType: 'rfp' }, { scored: true }, { questionsDueAt: '2026-10-05T14:00' }, { jobWalkAt: '2026-10-05T14:00' },
  { jobWalkMandatory: true }, { estimateId: ID }, { submittedAt: '2026-10-05T14:00' }, { submissionConfirmation: 'Receipt 55' },
];

describe('the reader', () => {
  test.each(['true ', '1', 'TRUE', 'on', 'yes', ''])('only the exact string "true" turns it on (%j)', (value) => {
    process.env.GATE_BID_DESK = 'true';
    process.env.GATE_BID_CHECKLIST = value;
    expect(bidChecklistLive()).toBe(false);
  });
  test('it needs the Bid Desk gate too', () => {
    process.env.GATE_BID_CHECKLIST = 'true';
    expect(bidChecklistLive()).toBe(false);
    process.env.GATE_BID_DESK = 'true';
    expect(bidChecklistLive()).toBe(true);
  });
});

describe('gate off (Bid Desk on)', () => {
  beforeEach(() => { process.env.GATE_BID_DESK = 'true'; });

  test.each(NEW_FIELDS)('PATCH refuses %j before any query', async (field) => {
    expect((await call('PATCH', `/${ID}`, field)).status).toBe(400);
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('the checklist and estimate routes answer 404 before any query', async () => {
    for (const [method, url, body] of [['POST', `/${ID}/checklist/start`, {}], ['POST', `/${ID}/checklist`, { label: 'x' }],
      ['PATCH', `/${ID}/checklist/${ITEM}`, { checked: true }], ['DELETE', `/${ID}/checklist/${ITEM}`], ['POST', `/${ID}/checklist/reorder`, { ids: [ITEM] }],
      ['GET', '/estimates?q=EST']]) {
      expect((await call(method, url, body)).status).toBe(404);
    }
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('no new reminder runs: the date reminders return before any query', async () => {
    expect(await service.sendDateReminders()).toBe(0);
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('the due-date reminder query has no 14-day clause and a 7-day horizon', async () => {
    const calls = [];
    const chain = new Proxy({}, {
      get: (_t, name) => {
        if (name === 'then') return (resolve) => resolve([]);
        return (...args) => { calls.push([name, args]); return chain; };
      },
    });
    mockDb.mockImplementation(() => chain);
    const now = new Date('2026-10-01T14:00:00Z');
    expect(await service.sendDueReminders({ now })).toBe(0);
    expect(JSON.stringify(calls)).not.toContain('reminder_14d_sent_at');
    const horizon = calls.find(([name, args]) => name === 'where' && args[0] === 'due_at' && args[1] === '<=' && args[2].getTime() === now.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(horizon).toBeDefined();
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_BID_DESK = 'true'; process.env.GATE_BID_CHECKLIST = 'true'; });

  test('bad ids and bad bodies are refused before any query', async () => {
    const refused = [
      ['PATCH', `/${ID}`, { solicitationType: 'carrier_pigeon' }, 400],
      ['PATCH', `/${ID}`, { scored: 'yes' }, 400],
      ['PATCH', `/${ID}`, { jobWalkMandatory: 'true' }, 400],
      ['PATCH', `/${ID}`, { estimateId: 'EST-1001' }, 400],
      ['PATCH', `/${ID}`, { questionsDueAt: 'October 5' }, 400],
      ['PATCH', `/${ID}`, { submissionConfirmation: 'x'.repeat(501) }, 400],
      ['PATCH', `/${ID}`, { jobWalkAt: '2026-10-05T14:00', job_walk_at: '2026-10-05T14:00' }, 400],
      ['PATCH', `/${ID}`, { buyer_email: 'x@y.test' }, 400],
      ['POST', `/${ID}/checklist/start`, { type: 'carrier_pigeon' }, 400],
      ['POST', `/${ID}/checklist/start?add=everything`, {}, 400],
      ['POST', `/${ID}/checklist`, {}, 400],
      ['POST', `/${ID}/checklist`, { label: '' }, 400],
      ['POST', `/${ID}/checklist`, { label: 'x', extra: 1 }, 400],
      ['PATCH', `/${ID}/checklist/${ITEM}`, {}, 400],
      ['PATCH', `/${ID}/checklist/${ITEM}`, { checked: 'yes' }, 400],
      ['PATCH', `/${ID}/checklist/not-a-uuid`, { checked: true }, 404],
      ['DELETE', `/${ID}/checklist/not-a-uuid`, undefined, 404],
      ['POST', `/not-a-uuid/checklist/start`, {}, 404],
      ['POST', `/${ID}/checklist/reorder`, { ids: ['nope'] }, 400],
      ['POST', `/${ID}/checklist/reorder`, { ids: [] }, 400],
      ['GET', '/estimates?q=a', undefined, 200],
    ];
    for (const [method, url, body, status] of refused) {
      const res = await call(method, url, body);
      expect([method, url, res.status]).toEqual([method, url, status]);
    }
    expect(mockDb).not.toHaveBeenCalled();
  });
});
