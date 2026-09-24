/**
 * AUDIT REPRO r1-customers-1 — PUT /admin/customers/:id on a per_application
 * customer: a monthly_rate correction (a figure this lane never bills) or a
 * tier clear must NOT fire a customer-facing membership lifecycle email.
 *
 * Written to assert the EXPECTED (comms-silent) behaviour, so it FAILS on
 * current code if the route really fires AccountMembershipEmail.
 * Setup copied from tests/admin-customers-membership-save.test.js.
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
jest.mock('../services/plan-rate-ledger', () => ({
  syncScalarWriteToLedger: jest.fn(async () => {}),
}));

const mockMembershipEmail = {
  sendMembershipStarted: jest.fn(async () => ({ ok: true })),
  sendMembershipUpdated: jest.fn(async () => ({ ok: true })),
  sendMembershipCanceled: jest.fn(async () => ({ ok: true })),
  sendMembershipReactivated: jest.fn(async () => ({ ok: true })),
};
jest.mock('../services/account-membership-email', () => mockMembershipEmail);

const mockState = { initial: null, locked: null, patches: [] };

jest.mock('../models/db', () => {
  const build = (table, inTransaction = false) => {
    const query = { lockedRead: false };
    for (const method of ['where', 'whereNull', 'whereNot', 'whereRaw', 'select']) {
      query[method] = () => query;
    }
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

// A real (manual-provenance) Bronze per-application customer carrying the
// unbilled monthly_rate the service comments describe (157 of 159 rows).
const PER_APP_MEMBER = {
  id: 'customer-1',
  account_id: 'account-1',
  first_name: 'Test',
  last_name: 'Customer',
  email: 'test@example.com',
  active: true,
  pipeline_stage: 'active_customer',
  waveguard_tier: 'Bronze',
  waveguard_tier_source: 'manual',
  monthly_rate: 45,
  billing_mode: 'per_application',
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

function calls() {
  return {
    started: mockMembershipEmail.sendMembershipStarted.mock.calls.length,
    updated: mockMembershipEmail.sendMembershipUpdated.mock.calls.length,
    canceled: mockMembershipEmail.sendMembershipCanceled.mock.calls.length,
    reactivated: mockMembershipEmail.sendMembershipReactivated.mock.calls.length,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.initial = { ...PER_APP_MEMBER };
  mockState.locked = { ...PER_APP_MEMBER };
  mockState.patches = [];
});

describe('r1-customers-1: per_application profile edits must stay comms-silent', () => {
  test('correcting the never-billed monthly rate (45 -> 50) sends no membership email', async () => {
    const response = await saveCustomer({ monthlyRate: 50 });
    expect(response).toMatchObject({ status: 200, body: { success: true } });
    expect(mockState.patches[0]).toMatchObject({ monthly_rate: 50 });
    expect(calls()).toEqual({ started: 0, updated: 0, canceled: 0, reactivated: 0 });
  });

  test('zeroing the stale monthly rate (45 -> 0) sends no membership email', async () => {
    await saveCustomer({ monthlyRate: 0 });
    expect(mockState.patches[0]).toMatchObject({ monthly_rate: 0 });
    expect(calls()).toEqual({ started: 0, updated: 0, canceled: 0, reactivated: 0 });
  });

  test('clearing the tier on a per_application customer sends no "Membership removed" email', async () => {
    await saveCustomer({ tier: '' });
    expect(mockState.patches[0]).toMatchObject({ waveguard_tier: '', waveguard_tier_source: null });
    expect(calls()).toEqual({ started: 0, updated: 0, canceled: 0, reactivated: 0 });
  });

  test('deactivating (active=false) sends no "Account deactivated" email', async () => {
    await saveCustomer({ active: false });
    expect(mockState.patches[0]).toMatchObject({ active: false });
    expect(calls()).toEqual({ started: 0, updated: 0, canceled: 0, reactivated: 0 });
  });
});
