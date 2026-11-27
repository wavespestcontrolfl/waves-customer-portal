/**
 * routes/admin-product-mix-rules.js: a technician reads the rules and runs a tank check, only an admin writes, and
 * the input is validated (verdict list, reason required and at most 200 characters). The real requireAdmin /
 * requireTechOrAdmin run; adminAuthenticate is stubbed to set a role. The service runs for real (its validation is
 * what the route answers with) over a mocked db, so no query reaches a database.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const express = require('express');

let mockRole = 'admin';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technicianId = '00000000-0000-4000-8000-0000000000aa';
      req.techRole = mockRole;
      next();
    },
  };
});
const mockAudit = [];
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async (event) => { mockAudit.push(event); }) }));

const mockWrites = [];
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
jest.mock('../models/db', () => {
  const rows = {
    products_catalog: [
      { id: '00000000-0000-4000-8000-000000000001', name: 'Celsius WG', category: 'herbicide' },
      { id: '00000000-0000-4000-8000-000000000002', name: 'Certainty Turf Herbicide', category: 'herbicide' },
    ],
  };
  const query = (table) => {
    let ids = null;
    const q = {
      leftJoin: () => q, select: () => q, orderBy: () => q, where: () => q, andWhere: () => q, whereNot: () => q, forUpdate: () => q,
      whereIn: (col, values) => { if (col === 'id') ids = values; return q; },
      first: async () => undefined,
      insert: (row) => { mockWrites.push(['insert', table, row]); return { returning: async () => [{ id: 'r1', ...row }] }; },
      update: (row) => { mockWrites.push(['update', table, row]); return { returning: async () => [{ id: 'r1', ...row }] }; },
      then: (resolve, reject) => Promise.resolve((rows[table] || []).filter((r) => !ids || ids.includes(r.id))).then(resolve, reject),
    };
    return q;
  };
  const db = jest.fn(query);
  db.fn = { now: () => 'NOW' };
  db.transaction = async (fn) => {
    const trx = jest.fn(query);
    trx.fn = db.fn;
    trx.isTestTrx = true;
    trx.raw = async (sql, bindings) => { mockWrites.push(['raw', sql, bindings]); return { rows: [{ id: 'r1', inserted: true, verdict: bindings[3] }] }; };
    return fn(trx);
  };
  return db;
});

let server;
let baseUrl;
beforeAll((done) => {
  const a = express();
  a.use(express.json());
  a.use('/api/admin/product-mix-rules', require('../routes/admin-product-mix-rules'));
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = a.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

async function call(method, url, body) {
  const res = await fetch(`${baseUrl}${url}`, {
    method: method.toUpperCase(),
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const good = { productAId: A, productBId: B, verdict: 'caution', reason: 'Approved weed mix.' };

beforeEach(() => { mockRole = 'admin'; mockWrites.length = 0; mockAudit.length = 0; });

describe('a technician', () => {
  beforeEach(() => { mockRole = 'technician'; });

  test('reads the rules, the products and the groups', async () => {
    const res = await call('get', '/api/admin/product-mix-rules');
    expect(res.status).toBe(200);
    expect(res.body.products.map((p) => p.name)).toEqual(['Celsius WG', 'Certainty Turf Herbicide']);
    expect(res.body.groups.map((g) => g.key)).toContain('fertilizer');
  });

  test('runs a tank check', async () => {
    const res = await call('get', `/api/admin/product-mix-rules/check?productIds=${A},${B}`);
    expect(res.status).toBe(200);
    expect(res.body.pairs).toHaveLength(1);
  });

  test.each([
    ['post', '/api/admin/product-mix-rules'],
    ['put', '/api/admin/product-mix-rules/00000000-0000-4000-8000-0000000000ff'],
    ['delete', '/api/admin/product-mix-rules/00000000-0000-4000-8000-0000000000ff'],
  ])('cannot %s', async (method, url) => {
    const res = await call(method, url, good);
    expect(res.status).toBe(403);
    expect(mockWrites).toEqual([]);
  });
});

describe('an admin', () => {
  test('adds a rule in one atomic upsert on the pair index, smaller id first, audited in the same transaction', async () => {
    const res = await call('post', '/api/admin/product-mix-rules', { ...good, productAId: B, productBId: A });
    expect(res.status).toBe(201);
    const [kind, sql, bindings] = mockWrites[0];
    expect(kind).toBe('raw');
    expect(sql).toMatch(/INSERT INTO product_mix_rules \(product_a_id, product_b_id, group_b, verdict,/);
    expect(sql).toMatch(/ON CONFLICT \(product_a_id, product_b_id\) WHERE product_b_id IS NOT NULL\s+DO UPDATE SET/);
    expect(bindings.slice(0, 4)).toEqual([A, B, null, 'caution']);
    expect(mockAudit).toEqual([expect.objectContaining({ action: 'product_mix_rules.created', critical: true, trx: expect.objectContaining({ isTestTrx: true }) })]);
  });

  test('a product + group rule upserts on the group index', async () => {
    await call('post', '/api/admin/product-mix-rules', { ...good, productBId: null, groupB: 'fertilizer' });
    expect(mockWrites[0][1]).toMatch(/ON CONFLICT \(product_a_id, group_b\) WHERE group_b IS NOT NULL/);
  });

  test.each([
    [{ verdict: 'maybe' }],
    [{ reason: '' }],
    [{ reason: 'x'.repeat(201) }],
    [{ productBId: null }],
    [{ groupB: 'oil' }],
  ])('gets a 400 for %j and nothing is written', async (patch) => {
    const res = await call('post', '/api/admin/product-mix-rules', { ...good, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(mockWrites).toEqual([]);
  });

  test('the tank check counts distinct products: duplicates and case do not count twice', async () => {
    expect((await call('get', `/api/admin/product-mix-rules/check?productIds=${A},${A.toUpperCase()}, ${A}`)).status).toBe(400);
    const repeated = [...Array.from({ length: 10 }, () => A), B].join(',');
    const res = await call('get', `/api/admin/product-mix-rules/check?productIds=${repeated}`);
    expect(res.status).toBe(200);
    expect(res.body.pairs).toHaveLength(1);
  });

  test('a tank check needs 2 to 10 products', async () => {
    expect((await call('get', `/api/admin/product-mix-rules/check?productIds=${A}`)).status).toBe(400);
    const eleven = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`).join(',');
    expect((await call('get', `/api/admin/product-mix-rules/check?productIds=${eleven}`)).status).toBe(400);
  });

  test('edit of a rule that does not exist is a 404', async () => {
    expect((await call('put', '/api/admin/product-mix-rules/00000000-0000-4000-8000-0000000000ff', good)).status).toBe(404);
  });
});
