/**
 * GET /admin/dispatch/:serviceId/lawn-reservice/fast-context (lawn re-service
 * Fast Complete, dark behind GATE_LAWN_RESERVICE_FAST_COMPLETE; no per-tech flag).
 *
 *  - Gate off answers 404 {enabled:false} without touching the database.
 *  - A technician only reads their own visit; admins read any.
 *  - Gate on returns the context builder's body under {enabled:true}; a missing
 *    visit is 404, a visit that is not a lawn re-service is a 409 refusal, and
 *    an otherwise ineligible visit is a 200 with its reason.
 *  - The route is registered behind the router-level tech-or-admin auth.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const chain = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'leftJoin', 'join', 'select', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.first = async () => null;
  chain.then = (resolve) => Promise.resolve([]).then(resolve);
  chain.catch = () => chain;
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : chain);
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
jest.mock('../services/lawn-reservice-fast-context', () => ({ buildLawnReserviceFastContext: jest.fn() }));

const router = require('../routes/admin-dispatch');
const { buildLawnReserviceFastContext } = require('../services/lawn-reservice-fast-context');

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

function invoke(method, routePath, { params = {}, body, actor = { techRole: 'admin', technicianId: 'admin-1' } } = {}) {
  const layer = routeLayer(method, routePath);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, body, query: {}, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const FAST = '/:serviceId/lawn-reservice/fast-context';
const params = { serviceId: 'visit-1' };

// A scripted db: scheduled_services -> the owning row (assertRecapOwnership).
const dbWithOwner = (technician_id, calls = []) => (table) => {
  calls.push(table);
  const chain = {};
  for (const m of ['where', 'select', 'leftJoin']) chain[m] = () => chain;
  chain.first = async () => (table === 'scheduled_services' ? { id: 'visit-1', technician_id, status: 'confirmed', scheduled_date: require('../utils/datetime-et').etDateString(new Date()), service_type: 'Lawn Care Re-Service' } : null);
  return chain;
};

describe('GET lawn-reservice/fast-context', () => {
  const savedGate = process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE; else process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = savedGate;
    mockDbCurrent = null;
    buildLawnReserviceFastContext.mockReset();
  });

  test('is registered on the router after the router-level auth', () => {
    const layer = routeLayer('get', FAST);
    expect(layer).toBeTruthy();
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(authIdx).toBeGreaterThan(-1);
    expect(router.stack.indexOf(layer)).toBeGreaterThan(authIdx);
  });

  test.each([undefined, '', 'false', '1', 'TRUE', 'on'])('gate %p answers 404 {enabled:false} and reads nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE; else process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = value;
    const calls = [];
    mockDbCurrent = dbWithOwner('tech-1', calls);
    const res = await invoke('get', FAST, { params });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
    expect(buildLawnReserviceFastContext).not.toHaveBeenCalled();
  });

  test('gate on: the owning technician gets the context under {enabled:true}', async () => {
    process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnReserviceFastContext.mockResolvedValue({ ok: true, eligible: true, reason: null, service: { id: 'visit-1' }, customerRequest: null, products: [], lastVisit: null });
    const res = await invoke('get', FAST, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true, eligible: true, reason: null, service: { id: 'visit-1' }, customerRequest: null, products: [], lastVisit: null });
    expect(buildLawnReserviceFastContext).toHaveBeenCalledWith('visit-1');
  });

  test("gate on: a technician cannot read another technician's visit", async () => {
    process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-2');
    const res = await invoke('get', FAST, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(403);
    expect(buildLawnReserviceFastContext).not.toHaveBeenCalled();
  });

  test('gate on: an admin reads any visit; an ineligible visit is a 200 with its reason', async () => {
    process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-2');
    buildLawnReserviceFastContext.mockResolvedValue({ ok: true, eligible: false, reason: 'grouped_visit', service: { id: 'visit-1' } });
    const res = await invoke('get', FAST, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true, eligible: false, reason: 'grouped_visit', service: { id: 'visit-1' } });
  });

  test('gate on: a visit whose completion profile is not lawn_re_service is refused with a 409', async () => {
    process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnReserviceFastContext.mockResolvedValue({ ok: false, reason: 'not_lawn_re_service' });
    const res = await invoke('get', FAST, { params });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'not_lawn_re_service', code: 'not_lawn_re_service' });
  });

  test('gate on: a visit that disappears is 404', async () => {
    process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnReserviceFastContext.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await invoke('get', FAST, { params });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', code: 'not_found' });
  });
});
