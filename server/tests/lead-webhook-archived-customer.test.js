/**
 * Public lead webhook — archived (soft-deleted) customer with the same phone.
 *
 * Admin archive sets customers.deleted_at and leaves the phone intact. The
 * webhook's existing-customer lookup used to match that archived row, write a
 * note + attribution onto it and return early: no leads row, no new-lead
 * bell, and the note sits on a row no admin list shows. An archived customer
 * must not match, so the submission flows down the normal new-lead path.
 *
 * Drives the real POST handler with an in-memory customers table behind a
 * recording db mock. ensureCustomerAccount (the first call on the new-customer
 * branch) throws a sentinel to stop the handler once the branch is proven.
 */

const mockCalls = [];
const mockTables = { customers: [] };

jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const state = { table, filters: [], op: null, payload: null };
    mockCalls.push(state);
    const chain = {};
    const passthrough = ['where', 'whereNot', 'whereIn', 'whereILike', 'whereRaw', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereILike', 'select', 'orderBy', 'limit', 'forUpdate'];
    passthrough.forEach((m) => {
      chain[m] = (...args) => { state.filters.push([m, ...args]); return chain; };
    });
    chain.first = () => {
      state.op = 'first';
      if (table !== 'customers') return Promise.resolve(undefined);
      const hasLiveFilter = state.filters.some(([m, col]) => m === 'whereNull' && col === 'deleted_at');
      const phoneFilter = state.filters.find(([m, f]) => m === 'where' && f && typeof f === 'object' && f.phone);
      const rows = mockTables.customers.filter((r) => (
        (!phoneFilter || r.phone === phoneFilter[1].phone) && (!hasLiveFilter || r.deleted_at == null)
      ));
      return Promise.resolve(rows[0]);
    };
    chain.update = (payload) => { state.op = 'update'; state.payload = payload; return Promise.resolve(1); };
    chain.insert = (payload) => {
      state.op = 'insert';
      state.payload = payload;
      const p = Promise.resolve([{ id: 'new-row' }]);
      p.returning = () => Promise.resolve([{ id: 'new-row', ...payload }]);
      return p;
    };
    chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return chain;
  };
  const db = jest.fn((table) => makeChain(table));
  db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/turnstile', () => ({ verifyTurnstileToken: jest.fn().mockResolvedValue({ ok: true, enforced: false, reason: 'test' }) }));
jest.mock('../routes/admin-customers', () => ({
  ensureCustomerAccount: jest.fn().mockRejectedValue(new Error('STOP_AFTER_NEW_CUSTOMER_BRANCH')),
}));

const router = require('../routes/lead-webhook');
const { ensureCustomerAccount } = require('../routes/admin-customers');

const PHONE_RAW = '9415550142';
const PHONE = '+19415550142';

function leadHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function submit() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const req = {
    body: { name: 'Testy Archivedperson', phone: PHONE_RAW, email: 'testy.archived@example.com', address: '100 Example Way, Bradenton, FL 34205' },
    headers: {},
    ip: '203.0.113.9',
    get: () => undefined,
  };
  await leadHandler()(req, res);
  return res;
}

const customerWrites = () => mockCalls.filter((c) => c.table === 'customers' && (c.op === 'update' || c.op === 'insert'));
const noteWrites = () => mockCalls.filter((c) => c.table === 'customer_interactions' && c.op === 'insert');

describe('lead webhook: archived customer with the same phone', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    mockTables.customers = [];
    ensureCustomerAccount.mockClear();
  });

  test('an archived customer does not match: the new-customer path runs and nothing is written to the archived row', async () => {
    mockTables.customers = [{ id: 'archived-1', phone: PHONE, deleted_at: new Date('2026-01-01T00:00:00Z') }];

    const res = await submit();

    // Reached the new-customer branch (the sentinel then surfaces as the
    // handler's generic 500); never the early-return existing-customer reply.
    expect(ensureCustomerAccount).toHaveBeenCalledTimes(1);
    expect(ensureCustomerAccount.mock.calls[0][1]).toMatchObject({ phone: PHONE });
    expect(res.body).not.toMatchObject({ existingCustomer: true });
    expect(customerWrites()).toHaveLength(0);
    expect(noteWrites()).toHaveLength(0);
  });

  test('a live customer with the phone still takes the existing-customer branch (no new-lead path)', async () => {
    mockTables.customers = [{ id: 'live-1', phone: PHONE, deleted_at: null }];

    await submit();

    expect(ensureCustomerAccount).not.toHaveBeenCalled();
    const update = customerWrites().find((c) => c.op === 'update');
    expect(update).toBeDefined();
    expect(update.filters).toContainEqual(['where', { id: 'live-1' }]);
    expect(noteWrites()[0].payload).toMatchObject({ customer_id: 'live-1', subject: 'Form submission (existing customer)' });
  });
});
