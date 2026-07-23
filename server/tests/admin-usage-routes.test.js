process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => ({ __raw: sql }));
  return fn;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'a0000000-0000-4000-8000-000000000001', role: 'admin', name: 'Owner' },
      tech: { id: 'b0000000-0000-4000-8000-000000000002', role: 'technician', name: 'Tech' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole)
      ? next()
      : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const express = require('express');
const db = require('../models/db');
const adminUsageRouter = require('../routes/admin-usage');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/usage', adminUsageRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Minimal chainable knex fake. Every builder method returns the chain; the
// chain records calls and resolves to `result` (or `firstResult` after
// .first()). insert() resolves immediately and records the row.
function makeChain(result = []) {
  const calls = { where: [], insert: null, firstCalled: false };
  const chain = {
    calls,
    then(resolve, reject) {
      return Promise.resolve(calls.firstCalled ? chain.__first : result)
        .then(resolve, reject);
    },
    catch() { return this; },
  };
  for (const m of [
    'select', 'count', 'countDistinct', 'max', 'groupBy', 'orderBy',
    'whereNotNull', 'join',
  ]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.where = jest.fn((...args) => {
    calls.where.push(args);
    return chain;
  });
  chain.first = jest.fn(() => {
    calls.firstCalled = true;
    return chain;
  });
  chain.insert = jest.fn((row) => {
    calls.insert = row;
    return Promise.resolve([]);
  });
  chain.__first = undefined;
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw.mockImplementation((sql) => ({ __raw: sql }));
});

describe('admin usage: auth gating', () => {
  test('POST /track requires authentication', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/usage/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageKey: 'dashboard' }),
      });
      expect(res.status).toBe(401);
    });
  });

  test('GET /summary scope=all rejects non-admin staff', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/usage/summary?scope=all`, {
        headers: { Authorization: 'Bearer tech' },
      });
      expect(res.status).toBe(403);
    });
  });
});

describe('admin usage: POST /track', () => {
  test('valid page view inserts a row for the authenticated staff member', async () => {
    const chain = makeChain();
    db.mockImplementation(() => chain);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/usage/track`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageKey: 'customers',
          path: '/admin/customers/:id',
          tab: 'notes',
          source: 'sidebar',
        }),
      });
      expect(res.status).toBe(204);
      expect(chain.calls.insert).toEqual({
        technician_id: 'a0000000-0000-4000-8000-000000000001',
        event_type: 'page_view',
        page_key: 'customers',
        path: '/admin/customers/:id',
        tab: 'notes',
        source: 'sidebar',
      });
    });
  });

  test.each([
    ['pageKey with uppercase', { pageKey: 'Customers' }],
    ['pageKey with slash', { pageKey: 'customers/detail' }],
    ['path with query string', { pageKey: 'leads', path: '/admin/leads?source_name=x' }],
    ['path outside /admin', { pageKey: 'leads', path: '/tech/route' }],
    ['tab with spaces', { pageKey: 'leads', tab: 'my search' }],
    ['unknown source', { pageKey: 'leads', source: 'carrier-pigeon' }],
    ['unknown eventType', { pageKey: 'leads', eventType: 'click' }],
    ['missing pageKey', {}],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const chain = makeChain();
    db.mockImplementation(() => chain);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/usage/track`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(chain.calls.insert).toBeNull();
    });
  });
});

describe('admin usage: GET /summary', () => {
  function primeSummaryChains({ pages = [], sources = [], tabs = [], totals, users = [] } = {}) {
    const chains = [];
    // The route fires 4 queries for scope=me (pages, sources, tabs, totals)
    // and a 5th (users) for scope=all — db() is called once per query.
    db.mockImplementation(() => {
      const idx = chains.length;
      let chain;
      if (idx === 0) chain = makeChain(pages);
      else if (idx === 1) chain = makeChain(sources);
      else if (idx === 2) chain = makeChain(tabs);
      else if (idx === 3) {
        chain = makeChain([]);
        chain.__first = totals || { views: 0, active_days: 0 };
      } else chain = makeChain(users);
      chains.push(chain);
      return chain;
    });
    return chains;
  }

  test('scope defaults to me: every aggregate is filtered to the caller', async () => {
    const chains = primeSummaryChains({
      pages: [{
        page_key: 'dispatch', views: '42', active_days: '9',
        last_used: '2026-07-22T14:00:00.000Z',
      }],
      sources: [{ page_key: 'dispatch', source: 'sidebar', views: '30' }],
      tabs: [{ page_key: 'dispatch', tab: 'board', views: '12' }],
      totals: { views: '42', active_days: '9' },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/usage/summary?days=30`, {
        headers: { Authorization: 'Bearer tech' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.windowDays).toBe(30);
      expect(body.scope).toBe('me');
      expect(body.users).toBeUndefined();
      expect(body.totals).toEqual({ views: 42, activeDays: 9 });
      expect(body.pages).toEqual([{
        pageKey: 'dispatch',
        views: 42,
        activeDays: 9,
        lastUsed: '2026-07-22T14:00:00.000Z',
        sources: { sidebar: 30 },
        tabs: [{ tab: 'board', views: 12 }],
      }]);

      // 4 queries, each windowed by a REAL Date (timestamptz leak guard) and
      // filtered to the caller's technician_id.
      expect(chains).toHaveLength(4);
      for (const chain of chains) {
        const windowWhere = chain.calls.where.find((a) => a[0] === 'created_at');
        expect(windowWhere).toBeDefined();
        expect(windowWhere[1]).toBe('>=');
        expect(windowWhere[2]).toBeInstanceOf(Date);
        const scopeWhere = chain.calls.where.find((a) => a[0] === 'technician_id');
        expect(scopeWhere).toEqual(['technician_id', 'b0000000-0000-4000-8000-000000000002']);
      }
    });
  });

  test('scope=all (admin) skips the technician filter and returns per-user rows', async () => {
    const chains = primeSummaryChains({
      totals: { views: '7', active_days: '3' },
      users: [{ id: 'x', name: 'Owner', views: '7' }],
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/usage/summary?scope=all&days=7`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scope).toBe('all');
      expect(body.users).toEqual([{ name: 'Owner', views: 7 }]);
      expect(chains).toHaveLength(5);
      for (const chain of chains.slice(0, 4)) {
        expect(chain.calls.where.find((a) => a[0] === 'technician_id')).toBeUndefined();
      }
    });
  });

  test('days is clamped to [1, 365] and defaults to 30', async () => {
    await withServer(async (baseUrl) => {
      const get = async (qs) => {
        primeSummaryChains({ totals: { views: 0, active_days: 0 } });
        const res = await fetch(`${baseUrl}/admin/usage/summary${qs}`, {
          headers: { Authorization: 'Bearer admin' },
        });
        return (await res.json()).windowDays;
      };
      expect(await get('?days=100000')).toBe(365);
      expect(await get('?days=-4')).toBe(1);
      expect(await get('?days=abc')).toBe(30);
      expect(await get('')).toBe(30);
    });
  });
});

describe('admin usage: SQL compiles', () => {
  // The summary aggregates use knex's object-alias forms with a raw ET-day
  // expression. Prove the exact chain compiles on the pg client — a mocked
  // route test can't catch a knex API mismatch.
  test('ET-day distinct aggregate compiles on the pg client', () => {
    const realKnex = require('knex')({ client: 'pg' });
    const ET_DAY_SQL = "(created_at AT TIME ZONE 'America/New_York')::date";
    const { sql, bindings } = realKnex('admin_usage_events')
      .where('created_at', '>=', new Date('2026-07-01T04:00:00.000Z'))
      .where('technician_id', 'abc')
      .select('page_key')
      .count({ views: '*' })
      .countDistinct({ active_days: realKnex.raw(ET_DAY_SQL) })
      .max({ last_used: 'created_at' })
      .groupBy('page_key')
      .orderBy([{ column: 'active_days', order: 'desc' }, { column: 'views', order: 'desc' }])
      .toSQL();
    expect(sql).toContain('count(*) as "views"');
    expect(sql).toContain(
      'count(distinct (created_at AT TIME ZONE \'America/New_York\')::date) as "active_days"',
    );
    expect(sql).toContain('max("created_at") as "last_used"');
    expect(bindings[0]).toBeInstanceOf(Date);
    realKnex.destroy();
  });
});
