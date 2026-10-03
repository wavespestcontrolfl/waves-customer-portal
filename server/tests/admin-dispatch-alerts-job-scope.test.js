/**
 * GET /api/admin/dispatch/alerts?job_id= — the single-visit view the open
 * board asks for after a visit update (lawn_spray_hold follow-up). Same query
 * and the same spray-hold validity filter, scoped to one job; a malformed id
 * is a 400; callers without job_id are unchanged.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockRows = [];
const mockWhereCalls = [];
const mockLimits = [];
const mockSuperseded = [];
const mockDbCalls = [];

jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const chain = {};
    for (const m of ['leftJoin', 'join', 'select', 'orderByRaw', 'orderBy', 'whereNull', 'whereNotIn', 'whereIn', 'whereRaw']) chain[m] = () => chain;
    chain.where = (...args) => { mockWhereCalls.push(args); return chain; };
    chain.limit = (n) => { mockLimits.push(n); return chain; };
    chain.then = (resolve, reject) => {
      const jobFilter = mockWhereCalls.filter((a) => a[0] === 'a.job_id').map((a) => a[1]).pop();
      return Promise.resolve(mockRows.filter((r) => !jobFilter || r.job_id === jobFilter)).then(resolve, reject);
    };
    return chain;
  };
  const proxy = (table) => { mockDbCalls.push(table); return makeChain(table); };
  proxy.transaction = async (fn) => {
    const trx = (table) => {
      const c = { where: (arg) => c, whereNull: () => c, whereNotNull: () => c, whereIn: () => c, whereRaw: () => c };
      c.update = () => ({ returning: async () => { mockSuperseded.push(table); return [{ id: 'x', type: 'lawn_spray_hold', payload: {}, resolved_at: 'NOW' }]; } });
      c.where = (arg) => { if (arg && arg.id) mockSuperseded.push(arg.id); return c; };
      return c;
    };
    trx.fn = { now: () => 'NOW' };
    trx.raw = (sql, b) => ({ sql, b });
    return fn(trx);
  };
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../sockets', () => ({ getIo: () => null }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const router = require('../routes/admin-dispatch');
const { etDateString } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());
const JOB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function invoke(query) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/alerts' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
  return new Promise((resolve, reject) => {
    handler({ query }, res, (err) => (err ? reject(err) : resolve(res))).then(() => resolve(res)).catch(reject);
  });
}

const card = (over = {}) => ({
  id: 'spray-1', type: 'lawn_spray_hold', severity: 'warn', job_id: JOB, resolved_at: null,
  payload: { for_date: TODAY, window_start: '09:00:00' },
  visit_status: 'confirmed', scheduled_date: TODAY, window_start: '09:00:00', ...over,
});

beforeEach(() => {
  mockRows = [];
  mockWhereCalls.length = 0; mockLimits.length = 0; mockSuperseded.length = 0; mockDbCalls.length = 0;
});

describe('GET /alerts?job_id=', () => {
  test('a valid card for the job is returned, scoped by job_id, with a limit big enough to be complete', async () => {
    mockRows = [card(), { id: 'other', type: 'missed_photo', job_id: OTHER, resolved_at: null, payload: {}, visit_status: 'confirmed' }];
    const res = await invoke({ job_id: JOB });
    expect(res.statusCode).toBe(200);
    expect(res.body.alerts.map((a) => a.id)).toEqual(['spray-1']);
    expect(mockWhereCalls).toContainEqual(['a.job_id', JOB]);
    expect(mockLimits).toEqual([200]);
    expect(mockSuperseded).toEqual([]);
  });

  test('a stale card (the visit was edited away) is absent from the answer and superseded', async () => {
    mockRows = [card({ scheduled_date: '2026-12-31' })];
    const res = await invoke({ job_id: JOB });
    expect(res.body.alerts).toEqual([]);
    expect(mockSuperseded.length).toBeGreaterThan(0);
  });

  test('a malformed job_id is a 400 and never reaches the database', async () => {
    for (const bad of ['not-a-uuid', '', '1; DROP TABLE x', ['a', 'b']]) {
      mockDbCalls.length = 0;
      const res = await invoke({ job_id: bad });
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'job_id must be a UUID' });
      expect(mockDbCalls).toEqual([]);
    }
  });

  test('without job_id the query is unchanged: no job filter, the default 50 limit', async () => {
    mockRows = [card()];
    const res = await invoke({});
    expect(res.body.alerts).toHaveLength(1);
    expect(mockWhereCalls.some((a) => a[0] === 'a.job_id')).toBe(false);
    expect(mockLimits).toEqual([50]);
  });
});
