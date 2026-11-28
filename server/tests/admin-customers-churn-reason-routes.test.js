/**
 * Route-level contract for churnReasonCode visibility and fresh churn transition enforcement:
 * - GET /api/admin/customers & GET /api/admin/customers/:id:
 *     - technician tokens NEVER receive churnReasonCode or free-text churnReason
 *     - admin tokens receive churnReasonCode and never unused free-text churnReason
 * - PUT /api/admin/customers/:id & PUT /api/admin/customers/:id/stage:
 *     - fresh non-churned -> churned without churnReasonCode returns 400 churn_reason_required
 *     - explicit churnReasonCode: 'unclassified' returns 400
 *     - fresh non-churned -> churned with a valid code persists churn_reason_code
 *     - already-churned customers remain editable for unrelated fields without churnReasonCode
 */
const mockState = {
  customer: null,
  locked: null,
  patches: [],
};

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/technician-visit-scope', () => ({
  technicianCurrentVisitFilter: (_req, q) => q,
  technicianServicesCustomer: jest.fn(async () => true),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/plan-rate-ledger', () => ({
  syncScalarWriteToLedger: jest.fn(async () => {}),
}));
jest.mock('../services/customer-lifecycle-guard', () => ({
  churnGuardOrRepair: jest.fn(async () => ({ blocked: false })),
  describeLiveVisit: jest.fn(() => 'live visit'),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({ ok: true })),
  sendMembershipUpdated: jest.fn(async () => ({ ok: true })),
  sendMembershipCanceled: jest.fn(async () => ({ ok: true })),
  sendMembershipReactivated: jest.fn(async () => ({ ok: true })),
}));

jest.mock('../models/db', () => {
  const build = (table, inTransaction = false) => {
    const tbl = typeof table === 'object' ? Object.values(table)[0] : String(table).split(' ')[0];
    const query = { lockedRead: false, isCount: false };
    const chainMethods = [
      'where', 'andWhere', 'orWhere', 'whereNot', 'orWhereNot', 'whereIn', 'orWhereIn', 'whereNotIn', 'orWhereNotIn',
      'whereNull', 'orWhereNull', 'whereNotNull', 'orWhereNotNull', 'whereRaw', 'orWhereRaw', 'select', 'distinct',
      'leftJoin', 'join', 'innerJoin', 'groupBy', 'groupByRaw', 'orderBy', 'orderByRaw',
      'limit', 'offset', 'modify', 'sum', 'max', 'min', 'as', 'with', 'from',
    ];
    for (const m of chainMethods) {
      query[m] = (...args) => {
        if ((m === 'where' || m === 'andWhere' || m === 'orWhere') && typeof args[0] === 'function') {
          args[0].call(query, query);
        }
        if (m === 'modify' && typeof args[0] === 'function') args[0](query);
        return query;
      };
    }
    query.count = () => { query.isCount = true; return query; };
    query.countDistinct = () => { query.isCount = true; return query; };
    query.clone = () => {
      const cloned = build(table, inTransaction);
      cloned.lockedRead = query.lockedRead;
      cloned.isCount = query.isCount;
      return cloned;
    };
    query.forUpdate = () => { query.lockedRead = true; return query; };
    query.pluck = async () => [];
    query.first = async () => {
      if (query.isCount) return { count: tbl === 'customers' && mockState.customer ? 1 : 0, total: 0 };
      if (tbl === 'customers') {
        const row = inTransaction && query.lockedRead ? mockState.locked : mockState.customer;
        return row ? { ...row } : null;
      }
      return null;
    };
    query.update = async (patch) => {
      if (tbl === 'customers') {
        mockState.patches.push({ ...patch });
        Object.assign(mockState.locked, patch);
      }
      return 1;
    };
    query.insert = async () => [1];
    query.then = (resolve, reject) => {
      const rows = tbl === 'customers' && mockState.customer ? [{ ...mockState.customer }] : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    query.catch = (reject) => Promise.resolve([]).catch(reject);
    return query;
  };
  const db = jest.fn((table) => build(table));
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => build(table, true));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.fn = { now: () => new Date() };
    trx.schema = { hasTable: jest.fn(async () => false), hasColumn: jest.fn(async () => false) };
    return fn(trx);
  });
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: () => new Date() };
  db.schema = { hasTable: jest.fn(async () => false), hasColumn: jest.fn(async () => false) };
  return db;
});

const router = require('../routes/admin-customers');

const BASE_CUSTOMER = {
  id: '00000000-0000-0000-0000-00000000c111',
  account_id: '00000000-0000-0000-0000-00000000a111',
  first_name: 'Pat',
  last_name: 'Lee',
  email: 'pat@example.com',
  phone: '9415550101',
  address_line1: '100 Main St',
  city: 'Sarasota',
  state: 'FL',
  zip: '34236',
  active: true,
  pipeline_stage: 'active_customer',
  churn_reason: 'sensitive office note',
  churn_reason_code: 'price',
  waveguard_tier: 'Silver',
  monthly_rate: 89,
  member_since: '2025-01-01',
  deleted_at: null,
};

async function invoke(method, path, { body = {}, query = {}, techRole = 'admin' } = {}) {
  const layer = router.stack.find((e) => e.route?.path === path && e.route?.methods?.[method]);
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = {
    params: { id: BASE_CUSTOMER.id },
    body,
    query,
    techRole,
    technicianId: techRole === 'technician' ? 'tech-1' : 'admin-1',
    ip: '127.0.0.1',
    get: jest.fn(() => 'jest'),
  };
  const result = { status: 200, body: null, error: null };
  const res = {
    status(code) { result.status = code; return res; },
    json(payload) { result.body = payload; return res; },
  };
  await handler(req, res, (err) => { result.error = err; });
  if (result.error) throw result.error;
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.customer = { ...BASE_CUSTOMER };
  mockState.locked = { ...BASE_CUSTOMER };
  mockState.patches = [];
});

describe('Technician response scoping for churn fields', () => {
  test('GET / directory strips churnReasonCode for technician tokens and includes it for admins', async () => {
    const techRes = await invoke('get', '/', { techRole: 'technician' });
    expect(techRes.status).toBe(200);
    expect(techRes.body.customers).toHaveLength(1);
    expect(techRes.body.customers[0]).not.toHaveProperty('churnReasonCode');
    expect(techRes.body.customers[0]).not.toHaveProperty('churnReason');

    const adminRes = await invoke('get', '/', { techRole: 'admin' });
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.customers[0].churnReasonCode).toBe('price');
  });

  test('GET /:id Customer 360 strips churnReasonCode for technicians and omits unused free-text churnReason for everyone', async () => {
    const techRes = await invoke('get', '/:id', { techRole: 'technician' });
    expect(techRes.status).toBe(200);
    expect(techRes.body.customer).not.toHaveProperty('churnReasonCode');
    expect(techRes.body.customer).not.toHaveProperty('churnReason');

    const adminRes = await invoke('get', '/:id', { techRole: 'admin' });
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.customer.churnReasonCode).toBe('price');
    expect(adminRes.body.customer).not.toHaveProperty('churnReason');
  });
});

describe('Server-side churnReasonCode enforcement on manual churn transitions', () => {
  test('PUT /:id and PUT /:id/stage reject fresh non-churned -> churned without a valid reason code', async () => {
    const putMissing = await invoke('put', '/:id', { body: { pipelineStage: 'churned' } });
    expect(putMissing.status).toBe(400);
    expect(putMissing.body.code).toBe('churn_reason_required');

    const putUnclassified = await invoke('put', '/:id', { body: { pipelineStage: 'churned', churnReasonCode: 'unclassified' } });
    expect(putUnclassified.status).toBe(400);

    const stageMissing = await invoke('put', '/:id/stage', { body: { stage: 'churned' } });
    expect(stageMissing.status).toBe(400);
    expect(stageMissing.body.code).toBe('churn_reason_required');

    const stageUnclassified = await invoke('put', '/:id/stage', { body: { stage: 'churned', churnReasonCode: 'unclassified' } });
    expect(stageUnclassified.status).toBe(400);
    expect(mockState.patches).toHaveLength(0);
  });

  test('PUT /:id and PUT /:id/stage accept fresh churn with a valid code and allow unrelated edits on already-churned records', async () => {
    mockState.customer = { ...BASE_CUSTOMER, pipeline_stage: 'dormant', churn_reason_code: null };
    mockState.locked = { ...mockState.customer };

    const freshStage = await invoke('put', '/:id/stage', { body: { stage: 'churned', churnReasonCode: 'moving' } });
    expect(freshStage.status).toBe(200);
    expect(mockState.locked.churn_reason_code).toBe('moving');

    // Already-churned customer: unrelated edit without churnReasonCode succeeds.
    mockState.customer = { ...BASE_CUSTOMER, pipeline_stage: 'churned', churn_reason_code: null };
    mockState.locked = { ...mockState.customer };
    const unrelatedEdit = await invoke('put', '/:id', { body: { firstName: 'Patricia', pipelineStage: 'churned' } });
    expect(unrelatedEdit.status).toBe(200);
    expect(mockState.locked.first_name).toBe('Patricia');

    // Concurrent reactivation before row lock: pre-lock read looked churned,
    // locked row is active_customer -> must still enforce churn_reason_required!
    mockState.customer = { ...BASE_CUSTOMER, pipeline_stage: 'churned', churn_reason_code: null };
    mockState.locked = { ...BASE_CUSTOMER, pipeline_stage: 'active_customer', churn_reason_code: null };
    const staleRace = await invoke('put', '/:id', { body: { pipelineStage: 'churned' } });
    expect(staleRace.status).toBe(400);
    expect(staleRace.body.code).toBe('churn_reason_required');
  });
});
