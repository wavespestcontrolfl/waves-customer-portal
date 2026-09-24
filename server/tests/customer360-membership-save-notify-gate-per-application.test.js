/**
 * Regression test for AUDIT r1-customers-1 (per_application profile edits).
 *
 * Before the fix, Customer 360 "Edit customer" rate/tier/active edits fired
 * membership lifecycle emails unconditionally, including a false "your plan
 * pricing was updated" notice for a monthly_rate this per_application lane
 * never bills. PUT /admin/customers/:id now requires an explicit
 * notifyCustomer:true from the caller before sending a membership.updated /
 * membership.canceled email for an existing membership's field edits, and a
 * rate-only change on a lane that doesn't bill monthly stays silent even
 * when notifyCustomer is set (nothing the customer is charged changed).
 * Mirrors server/tests/admin-customers-membership-save.test.js mocks.
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/plan-rate-ledger', () => ({ syncScalarWriteToLedger: jest.fn(async () => {}) }));

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
    for (const m of ['where', 'whereNull', 'whereNot', 'whereRaw', 'select']) query[m] = () => query;
    query.forUpdate = () => { query.lockedRead = true; return query; };
    query.first = async () => {
      if (table !== 'customers') return null;
      return inTransaction && query.lockedRead ? { ...mockState.locked } : { ...mockState.initial };
    };
    query.update = async (patch) => { mockState.patches.push({ ...patch }); Object.assign(mockState.locked, patch); return 1; };
    return query;
  };
  const db = jest.fn((table) => build(table));
  db.transaction = jest.fn(async (fn) => { const trx = jest.fn((t) => build(t, true)); trx.raw = jest.fn(async () => ({ rows: [] })); return fn(trx); });
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  return db;
});

const router = require('../routes/admin-customers');

// A real per-application customer: manual tier, stale monthly_rate never billed.
const PER_APP = {
  id: 'customer-1', account_id: 'account-1', first_name: 'Pat', last_name: 'Tester', email: 'pat@example.com',
  active: true, pipeline_stage: 'active_customer',
  waveguard_tier: 'Bronze', waveguard_tier_source: 'manual',
  monthly_rate: 45, per_application_fee: 91, billing_mode: 'per_application', deleted_at: null,
};

async function saveCustomer(body) {
  const layer = router.stack.find((e) => e.route?.path === '/:id' && e.route?.methods?.put);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id: 'customer-1' }, body, technicianId: 'admin-1', ip: '127.0.0.1', get: jest.fn(() => 'jest') };
  const result = { status: 200, body: null, error: null };
  const res = { status(c) { result.status = c; return res; }, json(p) { result.body = p; return res; } };
  await handler(req, res, (err) => { result.error = err; });
  if (result.error) throw result.error;
  await new Promise((r) => setImmediate(r));
  return result;
}

beforeEach(() => { jest.clearAllMocks(); mockState.initial = { ...PER_APP }; mockState.locked = { ...PER_APP }; mockState.patches = []; });

describe('r1-customers-1: per_application customer, Customer 360 edit (notifyCustomer gate)', () => {
  test('rate typo fix 45 -> 50 stays silent, even with notifyCustomer:true (never-billed rate)', async () => {
    let res = await saveCustomer({ monthlyRate: 50 });
    expect(res.status).toBe(200);
    expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();

    mockState.initial = { ...mockState.locked };
    res = await saveCustomer({ monthlyRate: 55, notifyCustomer: true });
    expect(res.status).toBe(200);
    // Rate-only change on a lane that never bills monthly_rate: no false
    // "your plan pricing was updated" notice, even with explicit opt-in.
    expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();
  });

  test('zeroing the stale rate 45 -> 0 stays silent, with or without notifyCustomer', async () => {
    await saveCustomer({ monthlyRate: 0 });
    expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();

    mockState.initial = { ...mockState.locked };
    await saveCustomer({ monthlyRate: 0, notifyCustomer: true });
    expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();
  });

  test('clearing the tier with a lingering rate: silent by default, sends membership.updated ("Tier: Bronze to None") with notifyCustomer:true', async () => {
    let res = await saveCustomer({ tier: null });
    expect(res.status).toBe(200);
    expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();
    expect(mockMembershipEmail.sendMembershipCanceled).not.toHaveBeenCalled();

    // Reset — the silent save above already cleared the tier; start fresh
    // for the notifyCustomer:true attempt so there is a real change again.
    mockState.initial = { ...PER_APP };
    mockState.locked = { ...PER_APP };
    res = await saveCustomer({ tier: null, notifyCustomer: true });
    expect(res.status).toBe(200);
    expect(mockMembershipEmail.sendMembershipUpdated).toHaveBeenCalledTimes(1);
    expect(mockMembershipEmail.sendMembershipUpdated.mock.calls[0][0].after.waveguard_tier).toBeNull();
    expect(mockMembershipEmail.sendMembershipCanceled).not.toHaveBeenCalled();
  });

  test('clearing the tier when rate is 0: silent by default, sends membership.canceled "Membership removed" with notifyCustomer:true', async () => {
    mockState.initial = { ...PER_APP, monthly_rate: 0 };
    mockState.locked = { ...PER_APP, monthly_rate: 0 };
    let res = await saveCustomer({ tier: null });
    expect(res.status).toBe(200);
    expect(mockMembershipEmail.sendMembershipCanceled).not.toHaveBeenCalled();

    // Reset to the same rate-0 starting point for the notifyCustomer:true attempt.
    mockState.initial = { ...PER_APP, monthly_rate: 0 };
    mockState.locked = { ...PER_APP, monthly_rate: 0 };
    res = await saveCustomer({ tier: null, notifyCustomer: true });
    expect(res.status).toBe(200);
    expect(mockMembershipEmail.sendMembershipCanceled).toHaveBeenCalledTimes(1);
    expect(mockMembershipEmail.sendMembershipCanceled.mock.calls[0][0].reason).toBe('Membership removed');
  });

  test('active=false: silent by default, sends membership.canceled "Account deactivated" with notifyCustomer:true', async () => {
    let res = await saveCustomer({ active: false });
    expect(res.status).toBe(200);
    expect(mockMembershipEmail.sendMembershipCanceled).not.toHaveBeenCalled();

    mockState.initial = { ...mockState.locked, active: true };
    mockState.locked = { ...mockState.locked, active: true };
    res = await saveCustomer({ active: false, notifyCustomer: true });
    expect(res.status).toBe(200);
    expect(mockMembershipEmail.sendMembershipCanceled).toHaveBeenCalledTimes(1);
    expect(mockMembershipEmail.sendMembershipCanceled.mock.calls[0][0].reason).toBe('Account deactivated');
  });

  test('control: a name-only edit sends nothing, notifyCustomer or not', async () => {
    await saveCustomer({ leadSource: 'referral' });
    await saveCustomer({ leadSource: 'referral', notifyCustomer: true });
    expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();
    expect(mockMembershipEmail.sendMembershipCanceled).not.toHaveBeenCalled();
  });
});
