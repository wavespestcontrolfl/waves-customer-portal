/**
 * Regression test for AUDIT r1-comms-side-effects-2 (route level).
 *
 * Before the fix, PUT /api/admin/customers/:id fired sendMembershipUpdated /
 * sendMembershipCanceled with no notify/consent flag in the request at all —
 * any rate/tier/active edit on a real member silently emailed the customer.
 * The route now requires an explicit notifyCustomer:true from the caller
 * before either send fires for an existing membership's field edits.
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
    for (const method of ['where', 'whereNull', 'whereNot', 'whereRaw', 'select']) query[method] = () => query;
    query.forUpdate = () => { query.lockedRead = true; return query; };
    query.first = async () => {
      if (table !== 'customers') return null;
      return inTransaction && query.lockedRead ? { ...mockState.locked } : { ...mockState.initial };
    };
    query.update = async (patch) => { mockState.patches.push({ ...patch }); Object.assign(mockState.locked, patch); return 1; };
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

const MEMBER = {
  id: 'customer-1', account_id: 'account-1', first_name: 'Test', last_name: 'Customer', active: true,
  pipeline_stage: 'active_customer', waveguard_tier: 'Gold', waveguard_tier_source: 'manual',
  monthly_rate: 89, billing_mode: 'monthly_membership', deleted_at: null,
};

async function saveCustomer(body) {
  const layer = router.stack.find((e) => e.route?.path === '/:id' && e.route?.methods?.put);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id: 'customer-1' }, body, technicianId: 'admin-1', ip: '127.0.0.1', get: jest.fn(() => 'jest') };
  const result = { status: 200, body: null, error: null };
  const res = { status(c) { result.status = c; return res; }, json(p) { result.body = p; return res; } };
  await handler(req, res, (e) => { result.error = e; });
  if (result.error) throw result.error;
  return result;
}

beforeEach(() => { jest.clearAllMocks(); mockState.initial = { ...MEMBER }; mockState.locked = { ...MEMBER }; mockState.patches = []; });

test('a monthly-rate typo fix alone sends nothing with no notify flag; notifyCustomer:true fires membership.updated (real monthly lane)', async () => {
  const silent = await saveCustomer({ monthlyRate: 98 });
  expect(silent.status).toBe(200);
  expect(mockMembershipEmail.sendMembershipUpdated).not.toHaveBeenCalled();
  expect(silent.body).not.toHaveProperty('emailed'); // route response says nothing about the send

  mockState.initial = { ...mockState.locked };
  const r1 = await saveCustomer({ monthlyRate: 105, notifyCustomer: true });
  expect(r1.status).toBe(200);
  expect(mockMembershipEmail.sendMembershipUpdated).toHaveBeenCalledTimes(1);
  const call1 = mockMembershipEmail.sendMembershipUpdated.mock.calls[0][0];
  expect(call1).toMatchObject({ customerId: 'customer-1', before: expect.objectContaining({ monthly_rate: 98 }), after: expect.objectContaining({ monthly_rate: 105 }) });
  expect(call1.idempotencyKey).toBeUndefined(); // defaults to hash(before,after) in the service

  // Operator notices the typo and reverts the same day, opting in again.
  mockState.initial = { ...mockState.locked };
  await saveCustomer({ monthlyRate: 98, notifyCustomer: true });
  expect(mockMembershipEmail.sendMembershipUpdated).toHaveBeenCalledTimes(2);
});

// Codex round-1 P2 follow-up: an inferred monthly member (billing_mode NULL,
// a real tier, a positive rate — resolveBillingLane infers monthly_membership
// from the rate alone) whose rate drops from positive to zero must still
// fire membership.updated when notifyCustomer:true — this is a real dues
// change to zero, not a rate-only edit on a lane that never bills the rate.
// resolveBillingLane(after) alone would read 'per_visit' once the rate hits
// zero (the inference needs BOTH a real tier AND rate > 0), which would
// wrongly look like "rate-only on an unbilled lane" if only the after-side
// lane were checked.
test('an inferred monthly member (billing_mode NULL) whose rate drops to zero still fires membership.updated with notifyCustomer:true', async () => {
  const INFERRED_MONTHLY_MEMBER = {
    id: 'customer-2', account_id: 'account-1', first_name: 'Robin', last_name: 'Member', active: true,
    pipeline_stage: 'active_customer', waveguard_tier: 'Silver', waveguard_tier_source: 'manual',
    monthly_rate: 65, billing_mode: null, deleted_at: null,
  };
  mockState.initial = { ...INFERRED_MONTHLY_MEMBER };
  mockState.locked = { ...INFERRED_MONTHLY_MEMBER };

  const layer = router.stack.find((e) => e.route?.path === '/:id' && e.route?.methods?.put);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id: 'customer-2' }, body: { monthlyRate: 0, notifyCustomer: true }, technicianId: 'admin-1', ip: '127.0.0.1', get: jest.fn(() => 'jest') };
  const result = { status: 200, body: null, error: null };
  const res = { status(c) { result.status = c; return res; }, json(p) { result.body = p; return res; } };
  await handler(req, res, (e) => { result.error = e; });
  if (result.error) throw result.error;

  expect(result.status).toBe(200);
  expect(mockMembershipEmail.sendMembershipUpdated).toHaveBeenCalledTimes(1);
  expect(mockMembershipEmail.sendMembershipUpdated.mock.calls[0][0]).toMatchObject({
    customerId: 'customer-2',
    before: expect.objectContaining({ monthly_rate: 65 }),
    after: expect.objectContaining({ monthly_rate: 0 }),
  });
});

test('deactivating a member record (active=false) sends nothing with no notify flag; notifyCustomer:true fires membership.canceled "Account deactivated"', async () => {
  const silent = await saveCustomer({ active: false });
  expect(silent.status).toBe(200);
  expect(mockMembershipEmail.sendMembershipCanceled).not.toHaveBeenCalled();

  mockState.initial = { ...mockState.locked, active: true };
  mockState.locked = { ...mockState.locked, active: true };
  await saveCustomer({ active: false, notifyCustomer: true });
  expect(mockMembershipEmail.sendMembershipCanceled).toHaveBeenCalledTimes(1);
  expect(mockMembershipEmail.sendMembershipCanceled.mock.calls[0][0]).toMatchObject({ customerId: 'customer-1', reason: 'Account deactivated' });
});
