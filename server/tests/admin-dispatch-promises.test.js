/**
 * GET /admin/dispatch/:serviceId/promises — the completion form's promise
 * check (owner "ok yes add these" 2026-10-01).
 *
 *  - With GATE_REPORT_WRITER_RULES off it answers unavailable without
 *    touching the database.
 *  - A technician reads only their own assigned visit.
 *  - Only visits the writer covers get the list (never lawn or tree, shrub
 *    & palm); the list is the customer's open promises, read-only.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.first = async () => null;
    chain.returning = async () => [];
    chain.count = async () => [{ count: 0 }];
    chain.columnInfo = async () => ({});
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(),
}));
jest.mock('../services/service-report/visit-promises', () => ({
  ...jest.requireActual('../services/service-report/visit-promises'),
  loadVisitPromises: jest.fn(),
}));

const router = require('../routes/admin-dispatch');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { loadVisitPromises } = require('../services/service-report/visit-promises');

function invoke(params = {}, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/promises' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const SERVICE = { id: 'svc-1', service_id: 'cat-1', service_type: 'Pest Re-Service', customer_id: 'cust-1', technician_id: 'tech-1' };
const PROMISES = [{ id: 'p-1', description: 'Check under the dishwasher', source: 'call', madeAt: '2026-09-29T15:00:00.000Z' }];

function serviceDb(service, calls) {
  return (table) => {
    calls.push(table);
    const chain = {};
    chain.where = () => chain;
    chain.first = async () => (table === 'scheduled_services' ? service : null);
    return chain;
  };
}

const ORIGINAL_GATE = process.env.GATE_REPORT_WRITER_RULES;
afterEach(() => {
  mockDbCurrent = null;
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
  else process.env.GATE_REPORT_WRITER_RULES = ORIGINAL_GATE;
  jest.clearAllMocks();
});

describe('GET /:serviceId/promises', () => {
  test('writer rules off: unavailable, with no database read', async () => {
    delete process.env.GATE_REPORT_WRITER_RULES;
    const calls = [];
    mockDbCurrent = serviceDb(SERVICE, calls);
    const res = await invoke({ serviceId: 'svc-1' });
    expect(res.body).toEqual({ available: false, promises: [] });
    expect(calls).toEqual([]);
    expect(loadVisitPromises).not.toHaveBeenCalled();
  });

  test('an unknown visit is a 404', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockDbCurrent = serviceDb(null, []);
    const res = await invoke({ serviceId: 'svc-x' });
    expect(res.statusCode).toBe(404);
  });

  test("a technician never reads another technician's visit", async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    const res = await invoke({ serviceId: 'svc-1' }, { techRole: 'technician', technicianId: 'tech-2' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(loadVisitPromises).not.toHaveBeenCalled();
  });

  test('a lawn visit is outside the writer: unavailable, nothing read', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockDbCurrent = serviceDb({ ...SERVICE, service_type: 'Lawn Care' }, []);
    resolveCompletionProfileForScheduledService.mockResolvedValue({ serviceKey: 'lawn_care_monthly', findingsType: null });
    const res = await invoke({ serviceId: 'svc-1' });
    expect(res.body).toEqual({ available: false, promises: [] });
    expect(loadVisitPromises).not.toHaveBeenCalled();
  });

  test("a covered visit lists its customer's open promises", async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    resolveCompletionProfileForScheduledService.mockResolvedValue({ serviceKey: 'pest_re_service', findingsType: null });
    loadVisitPromises.mockResolvedValue(PROMISES);
    const res = await invoke({ serviceId: 'svc-1' }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.body).toEqual({ available: true, promises: PROMISES });
    expect(loadVisitPromises).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust-1' });
  });
});
