/**
 * Customers audit C11 + C12 — admin writes to a customer that is missing, or
 * was archived after the request read it, refuse with 404 and write nothing.
 *
 * C11: the general edit (PUT /:id) and the stage change (PUT /:id/stage) read
 * a live row, then lock by id. An archive committed in between used to let
 * the stale request rewrite the archived row (a stage save could set
 * active=true). The locked read now requires deleted_at IS NULL.
 * C12: the notification-preference save wrote without checking the customer
 * at all.
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/plan-rate-ledger', () => ({ syncScalarWriteToLedger: jest.fn(async () => {}) }));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({ ok: true })),
  sendMembershipUpdated: jest.fn(async () => ({ ok: true })),
  sendMembershipCanceled: jest.fn(async () => ({ ok: true })),
  sendMembershipReactivated: jest.fn(async () => ({ ok: true })),
}));

// readRow: what a read outside the transaction sees. lockedRow: what the
// transaction's reads see (an archive may have committed in between).
// null = no such customer.
const mockState = { readRow: null, lockedRow: null, prefs: null, writes: [] };

jest.mock('../models/db', () => {
  const build = (table, inTransaction = false) => {
    const query = { liveOnly: false };
    for (const method of ['where', 'whereIn', 'whereNot', 'whereRaw', 'orWhere', 'select', 'orderBy', 'limit', 'forUpdate']) {
      query[method] = () => query;
    }
    query.whereNull = (column) => {
      if (column === 'deleted_at') query.liveOnly = true;
      return query;
    };
    const customerRow = () => {
      const row = inTransaction ? mockState.lockedRow : mockState.readRow;
      if (!row || (query.liveOnly && row.deleted_at)) return undefined;
      return row;
    };
    query.first = async () => {
      if (table === 'customers') {
        const row = customerRow();
        return row ? { ...row } : undefined;
      }
      if (table === 'notification_prefs') return mockState.prefs;
      return null;
    };
    query.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    query.update = async (patch) => {
      if (table === 'customers' && !customerRow()) return 0;
      mockState.writes.push({ table, op: 'update', patch, inTransaction });
      return 1;
    };
    query.insert = (row) => {
      mockState.writes.push({ table, op: 'insert', row, inTransaction });
      const inserted = Promise.resolve([1]);
      inserted.onConflict = () => ({ ignore: async () => [1] });
      return inserted;
    };
    query.del = async () => {
      mockState.writes.push({ table, op: 'del', inTransaction });
      return 1;
    };
    return query;
  };
  const db = jest.fn((table) => build(table));
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => build(table, true));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    return fn(trx);
  });
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  return db;
});

const router = require('../routes/admin-customers');

const LIVE = {
  id: 'customer-1',
  account_id: 'account-1',
  first_name: 'Test',
  last_name: 'Person',
  active: true,
  pipeline_stage: 'active_customer',
  waveguard_tier: null,
  waveguard_tier_source: null,
  monthly_rate: 0,
  per_application_fee: null,
  billing_mode: 'per_visit',
  deleted_at: null,
};
const ARCHIVED = { ...LIVE, active: false, deleted_at: new Date('2026-10-29T12:00:00Z') };

async function call(method, path, { params = {}, body = {} } = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} route not registered`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = {
    params: { id: 'customer-1', ...params }, body, query: {},
    technicianId: 'admin-1', ip: '127.0.0.1', get: jest.fn(() => 'jest'),
  };
  const result = { status: 200, body: null, error: null };
  const res = {
    status(code) { result.status = code; return res; },
    json(payload) { result.body = payload; return res; },
  };
  await handler(req, res, (error) => { result.error = error; });
  if (result.error) throw result.error;
  return result;
}

const NOT_FOUND = { status: 404, body: { error: 'Customer not found' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockState.readRow = { ...LIVE };
  mockState.lockedRow = { ...LIVE };
  mockState.prefs = { customer_id: 'customer-1' };
  mockState.writes = [];
});

describe('C11: an archive that commits before the row lock refuses the edit', () => {
  beforeEach(() => { mockState.lockedRow = { ...ARCHIVED }; });

  test('PUT /:id writes nothing to the archived row', async () => {
    expect(await call('put', '/:id', { body: { crmNotes: 'Called back' } })).toMatchObject(NOT_FOUND);
    expect(mockState.writes.filter((w) => w.table === 'customers')).toEqual([]);
  });

  test('PUT /:id/stage neither relabels nor reactivates the archived row', async () => {
    expect(await call('put', '/:id/stage', { body: { stage: 'active_customer' } })).toMatchObject(NOT_FOUND);
    expect(mockState.writes).toEqual([]);
  });
});

describe('C12: notification-preference writes need a live customer', () => {
  test.each([
    ['archived', ARCHIVED],
    ['missing', null],
  ])('%s customer: the save refuses with 404 and writes nothing', async (_label, row) => {
    mockState.readRow = row && { ...row };
    mockState.lockedRow = row && { ...row };
    expect(await call('put', '/:id/notification-prefs', { body: { autoFlipEnRoute: false } })).toMatchObject(NOT_FOUND);
    expect(mockState.writes).toEqual([]);
  });

  test('a live customer still takes the save', async () => {
    expect((await call('put', '/:id/notification-prefs', { body: { autoFlipEnRoute: false } })).status).toBe(200);
  });
});
