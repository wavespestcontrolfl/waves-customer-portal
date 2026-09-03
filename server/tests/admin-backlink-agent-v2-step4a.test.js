/**
 * Backlink Manager v2 step 4a — admin policy route contract:
 *  - GET /policy returns stored + effective (env-tightened) policy, overrides,
 *    the field specs, the audit tail and the GATE_LINK_AUTHORITY state.
 *  - PATCH /policy: non-object / empty → 400; any invalid field → 400 and
 *    nothing written; valid edits audited under the admin's name.
 * Handlers are invoked directly off the router stack (no supertest at root).
 */
const mockState = { policyRow: { id: 1 }, audit: [], updates: [], inserts: [] };

jest.mock('../models/db', () => {
  const mk = (table) => {
    const q = {
      where: () => q, forUpdate: () => q, orderBy: () => q, limit: () => q,
      select: async () => (table === 'seo_link_policy_audit' ? mockState.audit : []),
      first: async () => (table === 'seo_link_policy' ? mockState.policyRow : undefined),
      update: async (u) => { mockState.updates.push({ table, u }); Object.assign(mockState.policyRow, u); return 1; },
      insert: async (rows) => { mockState.inserts.push(...rows); return rows.length; },
    };
    return q;
  };
  const db = jest.fn((table) => mk(table));
  db.transaction = async (cb) => cb(db);
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/seo/link-registry-intake', () => ({ intake: jest.fn(), resolveIntakeItems: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((g) => g === 'linkAuthority') }));
jest.mock('../services/seo/link-path-investigator', () => ({ investigatePaths: jest.fn(), LOCK_KEY: 'link-path-investigator' }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const router = require('../routes/admin-backlink-agent-v2');
const P = require('../services/seo/link-authority-policy');

function handler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const run = async (method, routePath, req) => {
  const r = res();
  let err;
  await handler(method, routePath)({ body: {}, query: {}, params: {}, ...req }, r, (e) => { err = e; });
  if (err) throw err;
  return r;
};

beforeEach(() => {
  mockState.policyRow = { id: 1, min_score: 60, auto_outreach_daily_cap: 10, min_path_confidence: '0.60', updated_at: 'T', updated_by: 'Adam' };
  mockState.audit = [{ id: 'a1', field: 'min_score', old_value: '50', new_value: '60', changed_by: 'Adam', changed_at: 'T' }];
  mockState.updates = []; mockState.inserts = [];
  delete process.env.LINK_OUTREACH_DAILY_CAP;
});

describe('GET /policy', () => {
  test('stored + effective + overrides + fields + audit + gate', async () => {
    process.env.LINK_OUTREACH_DAILY_CAP = '4';
    const r = await run('get', '/policy', {});
    expect(r.statusCode).toBe(200);
    expect(r.body.stored.auto_outreach_daily_cap).toBe(10);
    expect(r.body.policy.auto_outreach_daily_cap).toBe(4);
    expect(r.body.overrides).toEqual([{ field: 'auto_outreach_daily_cap', env: 'LINK_OUTREACH_DAILY_CAP', row: 10, applied: 4 }]);
    expect(r.body.stored.min_path_confidence).toBe(0.6);
    expect(r.body.fields).toBe(P.POLICY_FIELDS);
    expect(r.body.audit).toEqual(mockState.audit);
    expect(r.body).toMatchObject({ gateOn: true, updated_at: 'T', updated_by: 'Adam' });
  });
});

describe('PATCH /policy', () => {
  test.each([[undefined], [null], [[1]], ['x'], [{}]])('body %p → 400', async (body) => {
    const r = await run('patch', '/policy', { body });
    expect(r.statusCode).toBe(400);
    expect(mockState.updates).toEqual([]);
  });
  test('one invalid field rejects the whole patch; nothing written', async () => {
    const r = await run('patch', '/policy', { body: { min_score: 70, preferred_provider: 'nope' }, technician: { id: 1, name: 'Adam' } });
    expect(r.statusCode).toBe(400);
    expect(r.body.errors).toEqual(['preferred_provider must be one of deterministic_runner, openai_cua, claude_cu, stagehand, grok, human']);
    expect(mockState.updates).toEqual([]);
    expect(mockState.inserts).toEqual([]);
  });
  test('valid edits write + audit under the admin name and return the effective policy', async () => {
    const r = await run('patch', '/policy', { body: { min_score: '70', auto_outreach_min_score: 80 }, technician: { id: 1, name: 'Adam' } });
    expect(r.statusCode).toBe(200);
    expect(r.body.changed).toEqual([{ field: 'min_score', old: 60, new: 70 }, { field: 'auto_outreach_min_score', old: null, new: 80 }]);
    expect(mockState.updates).toHaveLength(1);
    expect(mockState.updates[0].u).toMatchObject({ min_score: 70, auto_outreach_min_score: 80, updated_by: 'Adam' });
    expect(mockState.inserts.map((i) => i.field)).toEqual(['min_score', 'auto_outreach_min_score']);
    expect(mockState.inserts[0]).toMatchObject({ changed_by: 'Adam', old_value: '60', new_value: '70' });
    expect(r.body.policy.min_score).toBe(70);
  });
  test('an admin without a name is recorded by id', async () => {
    await run('patch', '/policy', { body: { max_spam_score: 5 }, technician: { id: 7 } });
    expect(mockState.inserts[0].changed_by).toBe('7');
  });
});
