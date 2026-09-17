/**
 * PUT /admin/customers/:id — membership tier provenance and lifecycle sends.
 *
 * The directory posts its full form on every save. An unchanged automatic
 * tier is still derived state, so echoing it must preserve `auto` and remain
 * communication-silent. Membership transitions are judged from the customer
 * row locked by the write transaction; the earlier validation read may be
 * stale after another editor commits first.
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
const mockSyncScalarWriteToLedger = jest.fn(async () => {});
jest.mock('../services/plan-rate-ledger', () => ({
  syncScalarWriteToLedger: mockSyncScalarWriteToLedger,
}));

const mockMembershipEmail = {
  sendMembershipStarted: jest.fn(async () => ({ ok: true })),
  sendMembershipUpdated: jest.fn(async () => ({ ok: true })),
  sendMembershipCanceled: jest.fn(async () => ({ ok: true })),
  sendMembershipReactivated: jest.fn(async () => ({ ok: true })),
};
jest.mock('../services/account-membership-email', () => mockMembershipEmail);

const mockState = {
  initial: null,
  locked: null,
  patches: [],
};

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

const AUTO_LABEL = {
  id: 'customer-1',
  account_id: 'account-1',
  first_name: 'Test',
  last_name: 'Customer',
  active: true,
  pipeline_stage: 'active_customer',
  waveguard_tier: 'Bronze',
  waveguard_tier_source: 'auto',
  monthly_rate: 0,
  billing_mode: 'per_visit',
  deleted_at: null,
};

async function saveCustomer(body) {
  const layer = router.stack.find((entry) => entry.route?.path === '/:id' && entry.route?.methods?.put);
  if (!layer) throw new Error('PUT /:id route not registered');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = {
    params: { id: 'customer-1' },
    body,
    technicianId: 'admin-1',
    ip: '127.0.0.1',
    get: jest.fn(() => 'jest'),
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

function expectNoMembershipEmail() {
  expect(mockMembershipEmail.sendMembershipStarted).not.toHaveBeenCalled();
  expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();
  expect(mockMembershipEmail.sendMembershipCanceled).not.toHaveBeenCalled();
  expect(mockMembershipEmail.sendMembershipReactivated).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.initial = { ...AUTO_LABEL };
  mockState.locked = { ...AUTO_LABEL };
  mockState.patches = [];
});

describe('PUT /admin/customers/:id membership save', () => {
  test('an unchanged full-form tier preserves automatic provenance and sends no welcome', async () => {
    const response = await saveCustomer({ tier: 'Bronze' });

    expect(response).toMatchObject({ status: 200, body: { success: true } });
    expect(mockState.patches).toHaveLength(1);
    expect(mockState.patches[0]).toEqual({ waveguard_tier: 'Bronze' });
    expect(mockState.locked.waveguard_tier_source).toBe('auto');
    expectNoMembershipEmail();
  });

  test('an explicitly changed tier becomes manual and emits the real membership start', async () => {
    await saveCustomer({ tier: 'Silver' });

    expect(mockState.patches[0]).toMatchObject({
      waveguard_tier: 'Silver',
      waveguard_tier_source: 'manual',
    });
    expect(mockMembershipEmail.sendMembershipStarted).toHaveBeenCalledTimes(1);
    expect(mockMembershipEmail.sendMembershipStarted).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      membershipTier: 'Silver',
      monthlyRate: 0,
      billingLane: 'per_visit',
    }));
    expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();
  });

  test('an unchanged auto tier becoming a paid membership still emits the legitimate start', async () => {
    await saveCustomer({
      tier: 'Bronze',
      monthlyRate: 55,
      billingMode: 'monthly_membership',
    });

    expect(mockState.patches[0]).toMatchObject({
      waveguard_tier: 'Bronze',
      monthly_rate: 55,
      billing_mode: 'monthly_membership',
    });
    expect(mockState.patches[0]).not.toHaveProperty('waveguard_tier_source');
    expect(mockState.locked.waveguard_tier_source).toBe('auto');
    expect(mockSyncScalarWriteToLedger).toHaveBeenCalledWith(
      expect.any(Function), 'customer-1', 55, { source: 'admin_edit' },
    );
    expect(mockMembershipEmail.sendMembershipStarted).toHaveBeenCalledTimes(1);
    expect(mockMembershipEmail.sendMembershipStarted).toHaveBeenCalledWith(expect.objectContaining({
      membershipTier: 'Bronze',
      monthlyRate: 55,
      billingLane: 'monthly_membership',
    }));
  });

  test('clearing an automatic tier clears its provenance without a cancellation send', async () => {
    await saveCustomer({ tier: '' });

    expect(mockState.patches[0]).toMatchObject({
      waveguard_tier: '',
      waveguard_tier_source: null,
    });
    expectNoMembershipEmail();
  });

  test('a stale pre-lock label snapshot cannot queue a duplicate membership start', async () => {
    // Another save committed the same tier as a manual membership after this
    // request's initial read. The waiting request must judge manual→manual
    // from its FOR UPDATE snapshot, not auto-label→manual from `initial`.
    mockState.locked = { ...AUTO_LABEL, waveguard_tier_source: 'manual' };

    await saveCustomer({ tier: 'Bronze' });

    expect(mockState.patches[0]).toMatchObject({
      waveguard_tier: 'Bronze',
      waveguard_tier_source: 'manual',
    });
    expectNoMembershipEmail();
  });

  test.each([
    { name: 'cancellation', initialActive: true, lockedActive: false, submittedActive: false },
    { name: 'reactivation', initialActive: false, lockedActive: true, submittedActive: true },
  ])('a stale pre-lock active snapshot cannot duplicate $name', async ({ initialActive, lockedActive, submittedActive }) => {
    const member = {
      ...AUTO_LABEL,
      waveguard_tier_source: 'manual',
      monthly_rate: 55,
      billing_mode: 'monthly_membership',
    };
    mockState.initial = { ...member, active: initialActive };
    mockState.locked = { ...member, active: lockedActive };

    await saveCustomer({ active: submittedActive });

    expect(mockState.patches[0]).toEqual({ active: submittedActive });
    expectNoMembershipEmail();
  });
});
