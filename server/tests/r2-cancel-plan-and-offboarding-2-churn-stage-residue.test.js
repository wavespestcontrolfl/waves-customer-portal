/**
 * AUDIT REPRO r2-cancel-plan-and-offboarding-2 — Customer 360 "Stage = Churned"
 * (PUT /admin/customers/:id { pipelineStage: 'churned' }) records the churn but
 * leaves the account billing: active stays true, autopay_enabled stays true,
 * next_charge_date stays armed, monthly_rate stays > 0 — the exact row shape
 * processMonthlyBilling selects (billing-cron.js: active=true AND monthly_rate>0
 * AND service_paused_at IS NULL) and charges.
 *
 * Written to assert the EXPECTED (churn winds down billing, like
 * cancellation-processor.js does) behaviour, so it FAILS on current code.
 * Setup copied from audit-repro/r1-customers-1.test.js.
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
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({ ok: true })),
  sendMembershipUpdated: jest.fn(async () => ({ ok: true })),
  sendMembershipCanceled: jest.fn(async () => ({ ok: true })),
  sendMembershipReactivated: jest.fn(async () => ({ ok: true })),
}));

const mockState = { initial: null, locked: null, patches: [] };

jest.mock('../models/db', () => {
  const build = (table, inTransaction = false) => {
    const query = { lockedRead: false };
    for (const method of ['where', 'whereNull', 'whereNot', 'whereNotIn', 'whereRaw', 'select', 'leftJoin']) {
      query[method] = () => query;
    }
    query.forUpdate = () => { query.lockedRead = true; return query; };
    query.first = async () => {
      if (table !== 'customers') return null;
      return inTransaction && query.lockedRead ? { ...mockState.locked } : { ...mockState.initial };
    };
    query.update = async (patch) => {
      if (table === 'customers') {
        mockState.patches.push({ ...patch });
        Object.assign(mockState.locked, patch);
      }
      return 1;
    };
    query.insert = async () => 1;
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
const { stageLifecycleStamps } = require('../services/customer-stages');

// A live monthly member with autopay armed and a charge date set.
const MONTHLY_MEMBER = {
  id: 'customer-1',
  account_id: 'account-1',
  first_name: 'Test',
  last_name: 'Member',
  email: 'test@example.com',
  active: true,
  pipeline_stage: 'active_customer',
  waveguard_tier: 'Silver',
  waveguard_tier_source: 'manual',
  monthly_rate: 89,
  billing_mode: 'monthly_membership',
  autopay_enabled: true,
  next_charge_date: '2026-10-01',
  service_paused_at: null,
  deleted_at: null,
  member_since: '2025-01-01',
  churned_at: null,
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

// Mirror of processMonthlyBilling's candidate predicate (billing-cron.js ~161-166)
// plus GUARD 1 (autopay_enabled === false → skipped).
function monthlyBillingWouldCharge(row) {
  return row.active === true
    && Number(row.monthly_rate) > 0
    && row.service_paused_at == null
    && row.deleted_at == null
    && row.autopay_enabled !== false;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.initial = { ...MONTHLY_MEMBER };
  mockState.locked = { ...MONTHLY_MEMBER };
  mockState.patches = [];
});

describe('r2-cancel-plan-and-offboarding-2: Stage=Churned must wind down billing', () => {
  test('stageLifecycleStamps(active_customer → churned) only records the churn label', () => {
    const s = stageLifecycleStamps('active_customer', 'churned', MONTHLY_MEMBER, { today: '2026-09-23', churnReason: 'moved' });
    // Documenting what it DOES produce (passes on current code):
    expect(s).toMatchObject({ churned_at: '2026-09-23', churn_reason: 'moved' });
    expect(Object.keys(s).sort()).toEqual(['churn_reason', 'churned_at', 'pipeline_stage_changed_at']);
  });

  test('PUT /:id { pipelineStage: churned } leaves the row in the monthly-billing candidate set (EXPECTED: wound down)', async () => {
    const response = await saveCustomer({ pipelineStage: 'churned', churnReason: 'moved' });
    expect(response).toMatchObject({ status: 200, body: { success: true } });
    // Churn label was recorded...
    expect(mockState.locked).toMatchObject({ pipeline_stage: 'churned', churned_at: expect.any(String) });
    // ...but billing was not wound down. EXPECTED (cancellation-processor parity):
    expect(mockState.locked.active).toBe(false);
    expect(mockState.locked.autopay_enabled).toBe(false);
    expect(mockState.locked.next_charge_date).toBeNull();
    expect(monthlyBillingWouldCharge(mockState.locked)).toBe(false);
  });
});
