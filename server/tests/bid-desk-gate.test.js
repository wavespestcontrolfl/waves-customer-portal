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

describe('saveBidUpdate and checklist reorder hardening', () => {
  const { saveBidUpdate } = require('../routes/admin-bid-desk');
  const checklist = require('../services/bid-desk/checklist');

  test('rejects archived estimates when linking estimateId', async () => {
    const queries = [];
    const trx = (table) => {
      const state = { table, whereNulls: [], lockedShare: false };
      queries.push(state);
      const q = {
        where: () => q,
        whereNull: (col) => { state.whereNulls.push(col); return q; },
        forUpdate: () => q,
        forShare: () => { state.lockedShare = true; return q; },
        first: async () => (table === 'bid_opportunities' ? { id: ID, status: 'new', updated_at: new Date('2026-10-02T12:00:00.000Z') } : undefined),
      };
      return q;
    };
    const out = await saveBidUpdate(trx, ID, { estimateId: '22222222-2222-4333-8444-555555555555' });
    expect(out).toEqual({ status: 400, body: { error: 'That estimate does not exist or is archived' } });
    expect(queries.find((q) => q.table === 'estimates')).toMatchObject({ whereNulls: ['archived_at'], lockedShare: true });
  });

  test('enforces expected_updated_at concurrency fence on non-date updates when supplied', async () => {
    let fencedSql = null;
    const trx = () => {
      const q = {
        where: () => q,
        forUpdate: () => q,
        first: async () => ({ id: ID, status: 'new', updated_at: new Date('2026-10-02T13:00:00.000Z') }),
        modify: (fn) => { fn(q); return q; },
        whereRaw: (sql, args) => { fencedSql = [sql, args]; return q; },
        update: async () => 0,
      };
      return q;
    };
    trx.raw = (sql) => sql;
    const out = await saveBidUpdate(trx, ID, { status: 'bid', expected_updated_at: '2026-10-02T12:00:00.000Z' });
    expect(out).toEqual({ status: 409, body: { error: 'This bid changed since you opened it. Reload and check it again.' } });
    expect(fencedSql).toEqual(["date_trunc('milliseconds', updated_at) = ?::timestamptz", ['2026-10-02T12:00:00.000Z']]);
  });

  test('reorderItems updates positions in a single batched VALUES query', async () => {
    const rawCalls = [];
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';
    const conn = () => {
      const q = { where: () => q, whereNull: () => q, forUpdate: () => q, select: async () => [{ id: id1 }, { id: id2 }] };
      return q;
    };
    conn.raw = jest.fn(async (sql, bindings) => { rawCalls.push({ sql, bindings }); });
    const ok = await checklist.reorderItems(conn, ID, [id2, id1]);
    expect(ok).toBe(true);
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0].sql).toContain('FROM (VALUES (?::uuid, ?::int), (?::uuid, ?::int)) AS v(id, pos)');
    expect(rawCalls[0].bindings).toEqual([id2, 1, id1, 2, ID]);
  });

  test('checklist start advances bid updated_at when changing solicitation_type so stale PATCH returns 409', async () => {
    let bidRow = { id: ID, status: 'new', solicitation_type: null, updated_at: new Date('2026-10-02T12:00:00.000Z') };
    const updates = [];
    mockDb.mockReset();
    mockDb.mockImplementation((fn) => {
      if (typeof fn === 'function') {
        const trx = (table) => {
          const q = {
            where: () => q,
            whereNull: () => q,
            whereNotNull: () => q,
            forUpdate: () => q,
            orderBy: () => q,
            max: () => q,
            modify: (cb) => { cb(q); return q; },
            whereRaw: () => q,
            first: async () => (table === 'bid_opportunities' ? bidRow : { top: 0 }),
            select: async () => [],
            insert: async () => [],
            update: async (patch) => {
              updates.push({ table, patch });
              if (table === 'bid_opportunities' && patch.updated_at) {
                bidRow = { ...bidRow, ...patch, updated_at: new Date('2026-10-02T13:00:00.000Z') };
              }
              return 1;
            },
          };
          return q;
        };
        trx.raw = (sql) => sql;
        return fn(trx);
      }
      return {};
    });

    const started = await call('POST', `/api/admin/bid-desk/${ID}/checklist/start`, { type: 'rfp' });
    expect(started.status).toBe(201);
    expect(updates).toContainEqual({
      table: 'bid_opportunities',
      patch: { solicitation_type: 'rfp', updated_at: 'clock_timestamp()' },
    });

    const stalePatch = await saveBidUpdate(
      (() => {
        const t = () => {
          const q = {
            where: () => q,
            forUpdate: () => q,
            first: async () => bidRow,
            modify: (cb) => { cb(q); return q; },
            whereRaw: (_sql, [expected]) => { q._matched = new Date(expected).getTime() === bidRow.updated_at.getTime(); return q; },
            update: async () => (q._matched ? 1 : 0),
          };
          return q;
        };
        t.raw = (sql) => sql;
        return t;
      })(),
      ID,
      { status: 'bid', expected_updated_at: '2026-10-02T12:00:00.000Z' },
    );
    expect(stalePatch.status).toBe(409);
  });
});
