/**
 * GET /admin/dispatch/:serviceId/lawn-fast/context and
 * POST /admin/dispatch/:serviceId/lawn-fast/watering-preview (lawn Fast
 * Complete, dark behind GATE_LAWN_FAST_COMPLETE).
 *
 *  - Gate off answers 404 {enabled:false} without touching the database.
 *  - A technician only reads their own visit; admins read any.
 *  - Gate on returns the service's body under {enabled:true}; a missing visit is
 *    404, an ineligible visit a 200 with its reason, a bad preview request 400.
 *  - Both routes sit behind the router-level tech-or-admin auth.
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
jest.mock('../services/lawn-fast-complete', () => ({
  isUuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value)),
  buildLawnFastContext: jest.fn(),
  buildLawnFastWateringPreview: jest.fn(),
}));

const router = require('../routes/admin-dispatch');
const { buildLawnFastContext, buildLawnFastWateringPreview } = require('../services/lawn-fast-complete');

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

const CONTEXT = '/:serviceId/lawn-fast/context';
const PREVIEW = '/:serviceId/lawn-fast/watering-preview';
const params = { serviceId: 'visit-1' };

const dbWithOwner = (technician_id, calls = []) => (table) => {
  calls.push(table);
  const chain = {};
  for (const m of ['where', 'select', 'leftJoin']) chain[m] = () => chain;
  chain.first = async () => (table === 'scheduled_services' ? { id: 'visit-1', technician_id, status: 'confirmed', scheduled_date: require('../utils/datetime-et').etDateString(new Date()), service_type: 'Lawn Care' } : null);
  return chain;
};

describe.each([
  ['get', CONTEXT, buildLawnFastContext],
  ['post', PREVIEW, buildLawnFastWateringPreview],
])('lawn-fast %s %s', (method, routePath, service) => {
  const savedGate = process.env.GATE_LAWN_FAST_COMPLETE;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = savedGate;
    mockDbCurrent = null;
    buildLawnFastContext.mockReset();
    buildLawnFastWateringPreview.mockReset();
  });

  test('is registered on the router after the router-level auth', () => {
    const layer = routeLayer(method, routePath);
    expect(layer).toBeTruthy();
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(authIdx).toBeGreaterThan(-1);
    expect(router.stack.indexOf(layer)).toBeGreaterThan(authIdx);
  });

  test.each([undefined, '', 'false', '1', 'TRUE', 'on'])('gate %p answers 404 {enabled:false} and reads nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = value;
    const calls = [];
    mockDbCurrent = dbWithOwner('tech-1', calls);
    const res = await invoke(method, routePath, { params, body: { productIds: [] } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
    expect(service).not.toHaveBeenCalled();
  });

  test("gate on: a technician cannot reach another technician's visit", async () => {
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-2');
    const res = await invoke(method, routePath, { params, body: { productIds: [] }, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(403);
    expect(service).not.toHaveBeenCalled();
  });
});

describe('GET lawn-fast/context', () => {
  const savedGate = process.env.GATE_LAWN_FAST_COMPLETE;
  beforeEach(() => { process.env.GATE_LAWN_FAST_COMPLETE = 'true'; });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = savedGate;
    mockDbCurrent = null;
    buildLawnFastContext.mockReset();
  });

  test('the owning technician gets the context under {enabled:true}, with their id passed down', async () => {
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnFastContext.mockResolvedValue({ ok: true, eligible: true, reason: null, visitType: 'recurring', service: { id: 'visit-1' } });
    const res = await invoke('get', CONTEXT, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true, eligible: true, reason: null, visitType: 'recurring', service: { id: 'visit-1' } });
    expect(buildLawnFastContext).toHaveBeenCalledWith('visit-1', { technicianId: 'tech-1' });
  });

  test('an admin reads any visit; an ineligible visit is a 200 with its reason', async () => {
    mockDbCurrent = dbWithOwner('tech-2');
    buildLawnFastContext.mockResolvedValue({ ok: true, eligible: false, reason: 'lawn_re_service', service: { id: 'visit-1' } });
    const res = await invoke('get', CONTEXT, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true, eligible: false, reason: 'lawn_re_service', service: { id: 'visit-1' } });
  });

  test('a visit that disappears is 404', async () => {
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnFastContext.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await invoke('get', CONTEXT, { params });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', code: 'not_found' });
  });
});

describe('POST lawn-fast/watering-preview', () => {
  const savedGate = process.env.GATE_LAWN_FAST_COMPLETE;
  beforeEach(() => { process.env.GATE_LAWN_FAST_COMPLETE = 'true'; });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = savedGate;
    mockDbCurrent = null;
    buildLawnFastWateringPreview.mockReset();
  });

  test('passes the chosen product ids and answers under {enabled:true}', async () => {
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnFastWateringPreview.mockResolvedValue({ ok: true, wateringRuleLive: true, products: [], lines: ['Skip your turf watering until Tue.'], sentence: 'Skip your turf watering until Tue.' });
    const res = await invoke('post', PREVIEW, { params, body: { productIds: ['p-1'] }, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, sentence: 'Skip your turf watering until Tue.' });
    expect(buildLawnFastWateringPreview).toHaveBeenCalledWith({ serviceId: 'visit-1', productIds: ['p-1'] });
  });

  test.each([
    ['invalid_product_ids', 400],
    ['too_many_products', 400],
    ['not_found', 404],
  ])('%s is a %i', async (reason, status) => {
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnFastWateringPreview.mockResolvedValue({ ok: false, reason });
    const res = await invoke('post', PREVIEW, { params, body: { productIds: 'x' } });
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({ error: reason, code: reason });
  });
});

describe('lawn-fast path guard (runs before router.param\'s ownership lookup)', () => {
  const savedGate = process.env.GATE_LAWN_FAST_COMPLETE;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = savedGate;
  });
  const guard = router.stack.find((l) => !l.route && l.keys.length === 1 && l.keys[0].name === 0 && l.regexp.test('/abc/lawn-fast/context'));
  const GOOD = '00000000-0000-4000-8000-000000000001';
  const run = (id) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
    let nexted = false;
    guard.handle({ params: { 0: id } }, res, () => { nexted = true; });
    return { res, nexted };
  };

  test('is registered, has no :serviceId param (so router.param does not run first), and matches only lawn-fast paths', () => {
    expect(guard).toBeTruthy();
    expect(guard.keys.map((k) => k.name)).toEqual([0]);
    expect(guard.regexp.test('/abc/pest-recap/context')).toBe(false);
    expect(guard.regexp.test('/abc/lawn-fastx')).toBe(false);
  });

  test('gate off: 404 {enabled:false} before anything is read', () => {
    delete process.env.GATE_LAWN_FAST_COMPLETE;
    const { res, nexted } = run(GOOD);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(nexted).toBe(false);
  });

  test.each(['missing', 'visit-1', '123', `${GOOD}x`])('gate on, malformed id %p: 404, never reaches a uuid column', (id) => {
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    const { res, nexted } = run(id);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Service not found', code: 'not_found' });
    expect(nexted).toBe(false);
  });

  test('gate on, a uuid passes on to the routes', () => {
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    expect(run(GOOD).nexted).toBe(true);
  });
});
