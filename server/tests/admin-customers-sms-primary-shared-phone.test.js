/**
 * PUT /admin/customers/:id accepts smsPrimaryForSharedPhone (GATE_SMS_SHARED_PHONE_LINK)
 * and writes it to customers.sms_primary_for_shared_phone as a boolean.
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// A phone change fans out to estimates, leads and threads through this
// service; that propagation is covered by its own suites, not here.
jest.mock('../services/customer-contact-fanout', () => {
  const actual = jest.requireActual('../services/customer-contact-fanout');
  return Object.fromEntries(Object.keys(actual).map((k) => [k, typeof actual[k] === 'function' ? jest.fn(async () => ({})) : actual[k]]));
});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/plan-rate-ledger', () => ({ syncScalarWriteToLedger: jest.fn(async () => {}) }));

const mockState = { initial: null, locked: null, patches: [] };

jest.mock('../models/db', () => {
  const build = (table, inTransaction = false) => {
    const query = { lockedRead: false };
    for (const method of ['where', 'whereNull', 'whereNot', 'whereRaw']) {
      query[method] = () => query;
    }
    // A phone change runs a cross-account conflict read that awaits
    // .select(...) as a row list; keep the chain and resolve to no rows.
    query.select = () => {
      const chained = Object.create(query);
      chained.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return chained;
    };
    query.forUpdate = () => { query.lockedRead = true; return query; };
    query.first = async () => {
      if (table !== 'customers') return null;
      return inTransaction && query.lockedRead ? { ...mockState.locked } : { ...mockState.initial };
    };
    query.update = async (patch) => {
      mockState.patches.push({ ...patch });
      Object.assign(mockState.locked, patch);
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

const BASE = {
  id: 'customer-1',
  account_id: 'account-1',
  first_name: 'Test',
  last_name: 'Customer',
  phone: '+19415550100',
  active: true,
  pipeline_stage: 'active_customer',
  waveguard_tier: 'Bronze',
  waveguard_tier_source: 'auto',
  monthly_rate: 0,
  billing_mode: 'per_visit',
  sms_primary_for_shared_phone: false,
  deleted_at: null,
};

async function saveCustomer(body) {
  const layer = router.stack.find((entry) => entry.route?.path === '/:id' && entry.route?.methods?.put);
  if (!layer) throw new Error('PUT /:id route not registered');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id: 'customer-1' }, body, technicianId: 'admin-1', ip: '127.0.0.1', get: jest.fn(() => 'jest') };
  const result = { status: 200, body: null, error: null };
  const res = {
    status(code) { result.status = code; return res; },
    json(payload) { result.body = payload; return res; },
  };
  await handler(req, res, (error) => { result.error = error; });
  if (result.error) throw result.error;
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.initial = { ...BASE };
  mockState.locked = { ...BASE };
  mockState.patches = [];
});

describe('PUT /admin/customers/:id smsPrimaryForSharedPhone', () => {
  test('true sets the mark as a boolean', async () => {
    const response = await saveCustomer({ smsPrimaryForSharedPhone: true });
    expect(response).toMatchObject({ status: 200, body: { success: true } });
    expect(mockState.patches).toHaveLength(1);
    expect(mockState.patches[0]).toEqual({ sms_primary_for_shared_phone: true });
  });

  test('false clears the mark', async () => {
    mockState.initial.sms_primary_for_shared_phone = true;
    mockState.locked.sms_primary_for_shared_phone = true;
    await saveCustomer({ smsPrimaryForSharedPhone: false });
    expect(mockState.patches[0]).toEqual({ sms_primary_for_shared_phone: false });
  });

  test('a new phone number drops a mark chosen for the old number', async () => {
    mockState.initial.sms_primary_for_shared_phone = true;
    mockState.locked.sms_primary_for_shared_phone = true;
    await saveCustomer({ phone: '+19415550199' });
    expect(mockState.patches[0]).toMatchObject({ phone: expect.any(String), sms_primary_for_shared_phone: false });
  });

  test('a mark committed between the unlocked read and the lock is still dropped on a phone change', async () => {
    mockState.initial.sms_primary_for_shared_phone = false;
    mockState.locked.sms_primary_for_shared_phone = true;
    await saveCustomer({ phone: '+19415550199' });
    expect(mockState.patches[0]).toMatchObject({ sms_primary_for_shared_phone: false });
  });

  test('a concurrent save that moved the number and marked it keeps its mark when this write matches the new number', async () => {
    mockState.initial = { ...mockState.initial, phone: '+19415550100', sms_primary_for_shared_phone: true };
    mockState.locked = { ...mockState.locked, phone: '+19415550199', sms_primary_for_shared_phone: true };
    await saveCustomer({ phone: '+19415550199' });
    expect(mockState.patches[0]).not.toHaveProperty('sms_primary_for_shared_phone');
  });

  test('the same number in another format keeps the mark', async () => {
    mockState.initial.sms_primary_for_shared_phone = true;
    mockState.locked.sms_primary_for_shared_phone = true;
    await saveCustomer({ phone: '(941) 555-0100' });
    expect(mockState.patches[0]).not.toHaveProperty('sms_primary_for_shared_phone');
  });

  test('a new phone number with the mark set in the same save keeps it', async () => {
    mockState.initial.sms_primary_for_shared_phone = true;
    mockState.locked.sms_primary_for_shared_phone = true;
    await saveCustomer({ phone: '+19415550199', smsPrimaryForSharedPhone: true });
    expect(mockState.patches[0]).toMatchObject({ sms_primary_for_shared_phone: true });
  });

  test('a truthy string from a form is coerced, an unrelated string is not true', async () => {
    await saveCustomer({ smsPrimaryForSharedPhone: 'true' });
    expect(mockState.patches[0].sms_primary_for_shared_phone).toBe(true);
    mockState.patches = [];
    await saveCustomer({ smsPrimaryForSharedPhone: 'no' });
    expect(mockState.patches[0].sms_primary_for_shared_phone).toBe(false);
  });
});
