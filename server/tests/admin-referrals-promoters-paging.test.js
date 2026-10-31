/**
 * GET /admin/referrals/promoters: search, page and limit reach the query, bad
 * page/limit answer 400 before any SQL, limit is capped, and hasMore tells the
 * Referrals page whether another page exists. The `promoters` key keeps its
 * shape for the older ReferralsPage.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockCalls = [];
let mockRows = [];

jest.mock('../models/db', () => {
  const chain = new Proxy({}, {
    get(_t, name) {
      if (name === 'then') {
        return (resolve, reject) => Promise.resolve(mockRows).then(resolve, reject);
      }
      return (...args) => {
        mockCalls.push([name, ...args]);
        if (name === 'where' && typeof args[0] === 'function') {
          // Run the search group against a recording builder.
          const rec = new Proxy({}, {
            get(_x, n) {
              return (...a) => { mockCalls.push(['search.' + n, ...a]); return rec; };
            },
          });
          args[0].call(rec);
        }
        return chain;
      };
    },
  });
  return jest.fn(() => chain);
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.techRole = 'admin';
      req.technicianId = '11111111-1111-4111-8111-111111111111';
      return next();
    },
  };
});

const express = require('express');
const router = require('../routes/admin-referrals-v2');

async function get(qs) {
  const app = express();
  app.use(express.json());
  app.use('/admin/referrals', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/referrals/promoters${qs}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, first_name: `P${i}` }));
const callArg = (name) => (mockCalls.find((c) => c[0] === name) || [])[1];

beforeEach(() => { mockCalls.length = 0; mockRows = []; });

describe('GET /admin/referrals/promoters paging', () => {
  it('defaults to page 1, limit 50, and asks for one extra row', async () => {
    mockRows = rowsOf(3);
    const { status, body } = await get('?status=all');
    expect(status).toBe(200);
    expect(callArg('limit')).toBe(51);
    expect(callArg('offset')).toBe(0);
    expect(body.promoters).toHaveLength(3);
    expect(body).toMatchObject({ page: 1, limit: 50, hasMore: false });
  });

  it('reports hasMore and trims the extra row when another page exists', async () => {
    mockRows = rowsOf(51);
    const { body } = await get('?status=all');
    expect(body.promoters).toHaveLength(50);
    expect(body.hasMore).toBe(true);
  });

  it('turns page and limit into the offset', async () => {
    mockRows = rowsOf(2);
    const { body } = await get('?status=all&page=3&limit=20');
    expect(callArg('limit')).toBe(21);
    expect(callArg('offset')).toBe(40);
    expect(body).toMatchObject({ page: 3, limit: 20, hasMore: false });
  });

  it('caps limit at 200', async () => {
    const { body } = await get('?limit=5000');
    expect(callArg('limit')).toBe(201);
    expect(body.limit).toBe(200);
  });

  it('passes search to the query as a case-insensitive pattern', async () => {
    await get('?status=all&search=Promoter%2060');
    const likes = mockCalls.filter((c) => /ILike$/.test(c[0]) || c[0] === 'search.whereILike' || c[0] === 'search.orWhereILike');
    expect(likes.length).toBe(4);
    expect(likes.every((c) => c[2] === '%Promoter 60%')).toBe(true);
  });

  it('matches a full name across first and last name, as the old page filter did', async () => {
    await get('?status=all&search=Jane%20Smith');
    const fullName = mockCalls.find((c) => c[0] === 'search.orWhereRaw');
    expect(fullName).toBeDefined();
    expect(fullName[1]).toMatch(/concat_ws\(' ', referral_promoters\.first_name, referral_promoters\.last_name\) ILIKE \?/);
    expect(fullName[2]).toEqual(['%Jane Smith%']);
  });

  it('applies no search filter when search is blank', async () => {
    await get('?status=all&search=%20%20');
    expect(mockCalls.some((c) => /ILike$/.test(c[0]))).toBe(false);
  });

  it.each([
    ['page=abc'], ['page=0'], ['page=-1'], ['page=1.5'], ['page=1e3'],
    ['limit=abc'], ['limit=0'], ['limit=-5'], ['limit=2.5'], ['page=99999999999999999999'],
    ['page=1&page=2'],
  ])('refuses %s with 400 and never reaches the database', async (qs) => {
    const { status, body } = await get(`?${qs}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/positive whole number/);
    expect(mockCalls).toHaveLength(0);
  });
});
