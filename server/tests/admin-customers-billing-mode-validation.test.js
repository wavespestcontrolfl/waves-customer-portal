/**
 * PUT /admin/customers/:id — billing type (billingMode) validation.
 *
 * The route's lane prerequisites moved into services/billing-mode-rules.js so
 * the Intelligence Bar's update_customer refuses exactly what this route
 * refuses. These cases pin the route's own responses (status + message) so the
 * extraction stays behavior-identical.
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

const mockState = { customer: null, term: null, visits: [], patches: [] };

jest.mock('../models/db', () => {
  const build = (table) => {
    const query = {};
    for (const method of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereRaw', 'orWhere', 'select', 'orderBy', 'limit', 'forUpdate']) {
      query[method] = () => query;
    }
    query.first = async () => {
      if (table === 'customers') return { ...mockState.customer };
      if (table === 'annual_prepay_terms') return mockState.term;
      return null;
    };
    query.then = (resolve, reject) => {
      const rows = table === 'scheduled_services' ? mockState.visits : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    query.update = async (patch) => { mockState.patches.push({ table, ...patch }); return 1; };
    return query;
  };
  const db = jest.fn((table) => build(table));
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => build(table));
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

async function save(body) {
  const layer = router.stack.find((entry) => entry.route?.path === '/:id' && entry.route?.methods?.put);
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

const lanePatch = () => mockState.patches.find((p) => p.table === 'customers' && 'billing_mode' in p);

beforeEach(() => {
  jest.clearAllMocks();
  mockState.customer = { ...BASE };
  mockState.term = null;
  mockState.visits = [];
  mockState.patches = [];
});

describe('PUT /admin/customers/:id billingMode validation', () => {
  test('an unknown mode is refused', async () => {
    const r = await save({ billingMode: 'weekly' });
    expect(r).toMatchObject({ status: 400, body: { error: 'Invalid billing mode' } });
    expect(lanePatch()).toBeUndefined();
  });

  test('monthly membership needs a positive monthly rate (stored or in the same save)', async () => {
    const r = await save({ billingMode: 'monthly_membership' });
    expect(r).toMatchObject({ status: 400, body: { error: 'Set a monthly rate before selecting Monthly membership — dues cannot collect at $0' } });
    const ok = await save({ billingMode: 'monthly_membership', monthlyRate: '55' });
    expect(ok.status).toBe(200);
    expect(lanePatch()).toMatchObject({ billing_mode: 'monthly_membership' });
  });

  test('per application needs a stored per-application fee', async () => {
    const r = await save({ billingMode: 'per_application' });
    expect(r).toMatchObject({ status: 400, body: { error: 'Set a per-application fee before selecting Per application — visits would complete unbilled' } });
    mockState.customer.per_application_fee = '91.00';
    const ok = await save({ billingMode: 'per_application' });
    expect(ok.status).toBe(200);
    expect(lanePatch()).toMatchObject({ billing_mode: 'per_application' });
  });

  test('annual prepay needs a paid term covering today', async () => {
    const r = await save({ billingMode: 'annual_prepay' });
    expect(r).toMatchObject({ status: 400, body: { error: 'Annual prepay requires a PAID term covering today — the lane stamps automatically when the annual invoice is paid' } });
    mockState.term = { id: 'term-1' };
    const ok = await save({ billingMode: 'annual_prepay' });
    expect(ok.status).toBe(200);
  });

  test('per visit and one time refuse while upcoming visits have no price', async () => {
    mockState.customer.billing_mode = 'per_application';
    mockState.customer.per_application_fee = '91.00';
    mockState.visits = [{ id: 's1', service_type: 'Pest Control', is_callback: false, scheduled_date: '2099-01-05' }];
    const one = await save({ billingMode: 'per_visit' });
    expect(one).toMatchObject({ status: 400, body: { error: "Per visit bills each visit's own price — 1 upcoming visit (first 2099-01-05) has no price and would complete unbilled. Price or cancel it before switching." } });
    mockState.visits.push({ id: 's2', service_type: 'Lawn Care', is_callback: false, scheduled_date: '2099-02-05' });
    const two = await save({ billingMode: 'one_time' });
    expect(two).toMatchObject({ status: 400, body: { error: "One-time bills each visit's own price — 2 upcoming visits (first 2099-01-05) have no price and would complete unbilled. Price or cancel them before switching." } });
  });

  test('callbacks are not counted as unpriced billable visits', async () => {
    mockState.customer.billing_mode = 'per_application';
    mockState.customer.per_application_fee = '91.00';
    mockState.visits = [{ id: 's1', service_type: 'Pest Control', is_callback: true, scheduled_date: '2099-01-05' }];
    const r = await save({ billingMode: 'per_visit' });
    expect(r.status).toBe(200);
    expect(lanePatch()).toMatchObject({ billing_mode: 'per_visit' });
  });

  test('clearing to Not set refuses when it resolves per visit with unpriced visits', async () => {
    mockState.visits = [{ id: 's1', service_type: 'Pest Control', is_callback: false, scheduled_date: '2099-01-05' }];
    const r = await save({ billingMode: '' });
    expect(r).toMatchObject({ status: 400, body: { error: 'Not set resolves this customer to per-visit billing — 1 upcoming visit (first 2099-01-05) has no price and would complete unbilled. Price or cancel it, or pick an explicit lane.' } });
    mockState.customer.waveguard_tier = 'Gold';
    mockState.customer.monthly_rate = 80;
    const ok = await save({ billingMode: null });
    expect(ok.status).toBe(200);
    expect(lanePatch()).toMatchObject({ billing_mode: null });
  });
});
