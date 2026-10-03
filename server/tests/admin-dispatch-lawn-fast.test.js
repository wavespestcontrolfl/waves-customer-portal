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

const CONTEXT = '/:lawnFastServiceId/lawn-fast/context';
const PREVIEW = '/:lawnFastServiceId/lawn-fast/watering-preview';
const VISIT = '00000000-0000-4000-8000-000000000001';
const params = { lawnFastServiceId: VISIT };

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
    expect(buildLawnFastContext).toHaveBeenCalledWith(VISIT, { technicianId: 'tech-1' });
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
    expect(buildLawnFastWateringPreview).toHaveBeenCalledWith({ serviceId: VISIT, productIds: ['p-1'] });
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

describe('lawn-fast path id (named :lawnFastServiceId so router.param(\'serviceId\') never runs its lookup first)', () => {
  const savedGate = process.env.GATE_LAWN_FAST_COMPLETE;
  beforeEach(() => { process.env.GATE_LAWN_FAST_COMPLETE = 'true'; });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = savedGate;
    mockDbCurrent = null;
    buildLawnFastContext.mockReset();
    buildLawnFastWateringPreview.mockReset();
  });

  test.each([['get', CONTEXT], ['post', PREVIEW]])('%s: the route does not use the :serviceId param (the router.param lookup would 500 on a malformed id)', (method, routePath) => {
    expect(routePath).not.toContain(':serviceId');
    expect(routeLayer(method, routePath).keys.map((k) => k.name)).toEqual(['lawnFastServiceId']);
  });

  test.each([['get', CONTEXT], ['post', PREVIEW]])('%s: gate off answers 404 {enabled:false} before the id is even looked at', async (method, routePath) => {
    delete process.env.GATE_LAWN_FAST_COMPLETE;
    const calls = [];
    mockDbCurrent = dbWithOwner('tech-1', calls);
    const res = await invoke(method, routePath, { params: { lawnFastServiceId: 'missing' }, body: { productIds: [] } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
  });

  test.each([
    ['get', CONTEXT, 'missing'], ['get', CONTEXT, '123'], ['get', CONTEXT, `${VISIT}x`],
    ['post', PREVIEW, 'missing'], ['post', PREVIEW, 'visit-1'],
  ])('%s %s with the malformed id %p: 404 not_found, never a 500, no database read', async (method, routePath, id) => {
    const calls = [];
    mockDbCurrent = dbWithOwner('tech-1', calls);
    for (const actor of [{ techRole: 'technician', technicianId: 'tech-1' }, { techRole: 'admin', technicianId: 'admin-1' }]) {
      const res = await invoke(method, routePath, { params: { lawnFastServiceId: id }, body: { productIds: [] }, actor });
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Service not found', code: 'not_found' });
    }
    expect(calls).toEqual([]);
    expect(buildLawnFastContext).not.toHaveBeenCalled();
    expect(buildLawnFastWateringPreview).not.toHaveBeenCalled();
  });

  test('a valid id reaches the service as the plain serviceId, after the ownership check the siblings use', async () => {
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnFastContext.mockResolvedValue({ ok: true, eligible: true, service: { id: VISIT } });
    await invoke('get', CONTEXT, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(buildLawnFastContext).toHaveBeenCalledWith(VISIT, { technicianId: 'tech-1' });
  });

  test("a technician is still refused another technician's visit (403), exactly as the sibling routes", async () => {
    mockDbCurrent = dbWithOwner('tech-2');
    const res = await invoke('get', CONTEXT, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(403);
    expect(buildLawnFastContext).not.toHaveBeenCalled();
  });

  test('both routes are registered after the router-level auth, which is what the route-surface scanner counts as their guard', () => {
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(authIdx).toBeGreaterThan(-1);
    for (const [method, routePath] of [['get', CONTEXT], ['post', PREVIEW]]) {
      expect(router.stack.indexOf(routeLayer(method, routePath))).toBeGreaterThan(authIdx);
    }
    expect(router.stack.some((l) => !l.route && l.regexp && String(l.regexp).includes('lawn-fast'))).toBe(false);
  });
});
