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
  proxy.transaction = (fn) => Promise.resolve(typeof fn === 'function' ? fn(proxy) : undefined);
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
  buildLawnTreatmentGuide: jest.fn(),
  resolveLawnFastEligibility: jest.fn(),
}));
jest.mock('../services/lawn-trouble-areas', () => ({ clearArea: jest.fn(), propertyOf: jest.fn(async (_knex, visit) => visit.property_id || null) }));
jest.mock('../services/lawn-sod-sheet', () => ({ confirmSodRooted: jest.fn() }));

const router = require('../routes/admin-dispatch');
const { buildLawnFastContext, buildLawnFastWateringPreview, resolveLawnFastEligibility } = require('../services/lawn-fast-complete');
const { clearArea } = require('../services/lawn-trouble-areas');
const { confirmSodRooted } = require('../services/lawn-sod-sheet');

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

function invoke(method, routePath, { params = {}, body, query = {}, actor = { techRole: 'admin', technicianId: 'admin-1' } } = {}) {
  const layer = routeLayer(method, routePath);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, body, query, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const CONTEXT = '/:lawnFastServiceId/lawn-fast/context';
const PREVIEW = '/:lawnFastServiceId/lawn-fast/watering-preview';
const VISIT = '00000000-0000-4000-8000-000000000001';
const params = { lawnFastServiceId: VISIT };

// A visit table that judges the technician predicate (owner, dead status, completed, window) the way the SQL filter does, on a state the
// test can change between the ownership check and the lock: `state.sequence` serves successive reads, the last one repeating.
const dbWithVisit = (state, calls = []) => (table) => {
  calls.push(table);
  const filters = [];
  const chain = {};
  const add = (kind) => (...args) => { filters.push([kind, ...args]); return chain; };
  for (const m of ['select', 'leftJoin', 'forUpdate']) chain[m] = () => chain;
  chain.where = add('where');
  chain.whereNot = add('whereNot');
  chain.whereNotIn = add('whereNotIn');
  chain.first = async () => {
    if (table !== 'scheduled_services') return null;
    state.reads = (state.reads || 0) + 1;
    const row = state.sequence[Math.min(state.reads, state.sequence.length) - 1];
    if (!row) return undefined;
    const col = (name) => String(name).replace(/^scheduled_services\./, '');
    const ok = filters.every(([kind, name, a1, a2]) => {
      if (col(name) === 'id') return true;
      if (kind === 'where' && a2 !== undefined) return a1 === '>=' ? String(row[col(name)]).slice(0, 10) >= String(a2) : true;
      if (kind === 'where') return typeof name === 'object' ? true : row[col(name)] === a1;
      if (kind === 'whereNot') return row[col(name)] !== a1;
      if (kind === 'whereNotIn') return !a1.includes(row[col(name)]);
      return true;
    });
    return ok ? row : null;
  };
  chain.then = (resolve) => Promise.resolve([]).then(resolve);
  return chain;
};

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

  test('only a sheet that sends sodAware=1 asks for the new-sod context (the signal rides to the builder)', async () => {
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnFastContext.mockResolvedValue({ ok: true, eligible: true, reason: null, visitType: 'recurring', service: { id: 'visit-1' } });
    await invoke('get', CONTEXT, { params, query: { sodAware: '1' }, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(buildLawnFastContext).toHaveBeenLastCalledWith(VISIT, { technicianId: 'tech-1', sodAware: true });
    await invoke('get', CONTEXT, { params, query: { sodAware: 'true' }, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(buildLawnFastContext).toHaveBeenLastCalledWith(VISIT, { technicianId: 'tech-1' });
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

// POST lawn-fast/trouble-areas/:areaId/clear (GATE_LAWN_TROUBLE_AREAS, dark): the sheet's own gate and ownership, then the same
// eligibility the context applies, before anything is written.
describe('POST lawn-fast/trouble-areas/:areaId/clear', () => {
  const CLEAR = '/:lawnFastServiceId/lawn-fast/trouble-areas/:areaId/clear';
  const AREA = '00000000-0000-4000-8000-0000000000aa';
  const GATES = ['GATE_LAWN_FAST_COMPLETE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_V13', 'GATE_LAWN_TREATMENT_GUIDE'];
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  const callClear = (actor) => invoke('post', CLEAR, { params: { ...params, areaId: AREA }, actor });
  beforeEach(() => {
    for (const name of GATES) process.env[name] = 'true';
    mockDbCurrent = dbWithVisit({ sequence: [{ id: 'visit-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: require('../utils/datetime-et').etDateString(new Date()), service_type: 'Lawn Care' }] });
    resolveLawnFastEligibility.mockReset().mockResolvedValue({ ok: true, reason: null, svc: { id: VISIT, property_id: 'prop-1' } });
    clearArea.mockReset().mockResolvedValue({ id: AREA, place: 'back', type: 'fungus' });
  });
  afterEach(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    mockDbCurrent = null;
  });

  test('is registered after the router-level auth', () => {
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(router.stack.indexOf(routeLayer('post', CLEAR))).toBeGreaterThan(authIdx);
  });

  test.each(['GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_V13', 'GATE_LAWN_TREATMENT_GUIDE'])('without %s: 404 {enabled:false}, nothing read or written', async (name) => {
    delete process.env[name];
    const res = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(resolveLawnFastEligibility).not.toHaveBeenCalled();
    expect(clearArea).not.toHaveBeenCalled();
  });

  test("a technician cannot clear on another technician's visit", async () => {
    mockDbCurrent = dbWithOwner('tech-2');
    const res = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
    expect(res.statusCode).toBe(403);
    expect(clearArea).not.toHaveBeenCalled();
  });

  // The clear runs under the visit's row lock (lockOwnedLiveVisit, as the other technician mutations on this route do): a change that lands
  // after the first ownership check is caught under the lock, and nothing is read or written for the former technician.
  describe('the visit is locked before anything is cleared', () => {
    const today = require('../utils/datetime-et').etDateString(new Date());
    const visit = (extra = {}) => ({ id: 'visit-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: today, service_type: 'Lawn Care', ...extra });

    test('reassigned after the ownership check: 403 service_not_assigned, no eligibility read, nothing cleared', async () => {
      mockDbCurrent = dbWithVisit({ sequence: [visit(), visit({ technician_id: 'tech-2' })] });
      const res = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('service_not_assigned');
      expect(resolveLawnFastEligibility).not.toHaveBeenCalled();
      expect(clearArea).not.toHaveBeenCalled();
    });

    test.each(['cancelled', 'no_show', 'skipped', 'completed'])('turned %s after the ownership check: 403, nothing cleared', async (status) => {
      mockDbCurrent = dbWithVisit({ sequence: [visit(), visit({ status })] });
      const res = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
      expect(res.statusCode).toBe(403);
      expect(clearArea).not.toHaveBeenCalled();
    });

    test('still the technician\'s at the lock: eligibility and the clear run on the transaction handle, once', async () => {
      mockDbCurrent = dbWithVisit({ sequence: [visit()] });
      const res = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
      expect(res.statusCode).toBe(200);
      expect(resolveLawnFastEligibility).toHaveBeenCalledTimes(1);
      expect(clearArea).toHaveBeenCalledTimes(1);
    });

    test('an admin is not scoped by assignment, but a visit that is gone is a 404 under the lock', async () => {
      mockDbCurrent = dbWithVisit({ sequence: [visit({ technician_id: 'tech-9' })] });
      expect((await callClear({ techRole: 'admin', technicianId: 'admin-1' })).statusCode).toBe(200);
      clearArea.mockClear();
      resolveLawnFastEligibility.mockClear();
      // An administrator is never read before the lock, so the lock is the first read here: a visit deleted by then is a 404.
      mockDbCurrent = dbWithVisit({ sequence: [null] });
      const res = await callClear({ techRole: 'admin', technicianId: 'admin-1' });
      expect(res.statusCode).toBe(404);
      expect(res.body.code).toBe('not_found');
      expect(resolveLawnFastEligibility).not.toHaveBeenCalled();
      expect(clearArea).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['a pest visit', 'not_lawn'],
    ['a lawn re-service', 'lawn_re_service'],
    ['a Waves Assessment visit', 'assessment_visit'],
    ['a project-backed visit', 'project_backed'],
    ['a visit with companion sections', 'has_companions'],
    ['a grouped stop', 'grouped_visit'],
    ['a closed visit', 'terminal_status'],
    ['Tree & Shrub', 'tree_shrub'],
  ])('%s is refused with the sheet\'s own reason, and nothing is cleared', async (_label, reason) => {
    resolveLawnFastEligibility.mockResolvedValue({ ok: true, reason, svc: { id: VISIT, property_id: 'prop-1' } });
    const res = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'lawn_fast_not_eligible', reason });
    expect(clearArea).not.toHaveBeenCalled();
  });

  test('a visit that cannot be found is a 404', async () => {
    resolveLawnFastEligibility.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
    expect(res.statusCode).toBe(404);
    expect(clearArea).not.toHaveBeenCalled();
  });

  test('an eligible visit clears an active area of its own property; an area of another lawn is a 404', async () => {
    const ok = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toEqual({ enabled: true, cleared: { id: AREA, place: 'back', type: 'fungus' } });
    expect(clearArea).toHaveBeenCalledWith(expect.anything(), { areaId: AREA, propertyId: 'prop-1', technicianId: 'tech-1' });
    clearArea.mockResolvedValue(null);
    const other = await callClear({ techRole: 'technician', technicianId: 'tech-1' });
    expect(other.statusCode).toBe(404);
    expect(other.body.code).toBe('trouble_area_not_found');
  });
});

// POST lawn-fast/sod-rooted (GATE_LAWN_NEW_SOD_NOTE, dark): the sheet's own gate and ownership, the property-preferences advisory
// lock taken BEFORE the visit lock (writeAdminPreferences' order), the same eligibility the context applies, then the service's write.
describe('POST lawn-fast/sod-rooted', () => {
  const ROOTED = '/:lawnFastServiceId/lawn-fast/sod-rooted';
  const GATES = ['GATE_LAWN_FAST_COMPLETE', 'GATE_LAWN_NEW_SOD_NOTE'];
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  const today = require('../utils/datetime-et').etDateString(new Date());
  const visit = (extra = {}) => ({ id: 'visit-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: today, service_type: 'Lawn Care', ...extra });
  const tech = { techRole: 'technician', technicianId: 'tech-1' };
  const tick = (actor = tech, body = { sodLaidOn: '2026-09-05' }, query = { sodAware: '1' }) => invoke('post', ROOTED, { params, body, actor, query });
  let customerRow;
  const db = require('../models/db');
  const savedRaw = db.raw;
  let order;
  beforeEach(() => {
    for (const name of GATES) process.env[name] = 'true';
    order = [];
    db.raw = jest.fn((sql, binds) => { order.push(['raw', binds && binds[0]]); return { toString: () => sql }; });
    const base = dbWithVisit({ sequence: [visit()] }, []);
    customerRow = { id: 'cust-1' };
    // The customer row read (whereNull + forShare) is recorded in the same order list as the visit reads.
    mockDbCurrent = (table) => {
      order.push(['table', table]);
      if (table !== 'customers') return base(table);
      const chain = {};
      for (const m of ['where', 'whereNull']) chain[m] = () => chain;
      chain.forShare = () => { order.push(['lock', 'customers']); return chain; };
      chain.first = async () => customerRow;
      return chain;
    };
    resolveLawnFastEligibility.mockReset().mockResolvedValue({ ok: true, reason: null, svc: { id: VISIT, customer_id: 'cust-1' } });
    confirmSodRooted.mockReset().mockResolvedValue({ status: 200, body: { sodRootedOn: today, changed: true } });
  });
  afterEach(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    db.raw = savedRaw;
    mockDbCurrent = null;
  });

  test('is registered after the router-level auth', () => {
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(router.stack.indexOf(routeLayer('post', ROOTED))).toBeGreaterThan(authIdx);
  });

  test.each(['GATE_LAWN_NEW_SOD_NOTE', 'GATE_LAWN_FAST_COMPLETE'])('without %s: 404 {enabled:false}, nothing read or written', async (name) => {
    delete process.env[name];
    const res = await tick();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(order).toEqual([]);
    expect(confirmSodRooted).not.toHaveBeenCalled();
  });

  test("a technician cannot confirm sod on another technician's visit", async () => {
    mockDbCurrent = dbWithOwner('tech-2');
    const res = await tick();
    expect(res.statusCode).toBe(403);
    expect(confirmSodRooted).not.toHaveBeenCalled();
  });

  test('a sheet that does not send sodAware=1 gets 404 {enabled:false}, nothing read or written', async () => {
    const res = await tick(tech, { sodLaidOn: '2026-09-05' }, {});
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(order).toEqual([]);
    expect(confirmSodRooted).not.toHaveBeenCalled();
  });

  test('lock order: advisory lock, then the customer row FOR SHARE, then the visit row; the write follows them all', async () => {
    const res = await tick();
    expect(res.statusCode).toBe(200);
    const advisory = order.findIndex(([kind, value]) => kind === 'raw' && value === 'property-preferences');
    const customerLock = order.findIndex(([kind, value]) => kind === 'lock' && value === 'customers');
    // The visit row lock is the scheduled_services read after the customer lock (the earlier ones are the ownership read and the peek).
    const visitLock = order.findIndex(([kind, value], i) => kind === 'table' && value === 'scheduled_services' && i > customerLock);
    expect(advisory).toBeGreaterThan(-1);
    expect(customerLock).toBeGreaterThan(advisory);
    expect(visitLock).toBeGreaterThan(customerLock);
    expect(confirmSodRooted).toHaveBeenCalledTimes(1);
  });

  test('a deleted customer: 404, nothing written', async () => {
    customerRow = null;
    const res = await tick();
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ code: 'not_found' });
    expect(confirmSodRooted).not.toHaveBeenCalled();
  });

  test('the customer\'s preferences lock comes before the visit lock, and the write gets the rendered sod date', async () => {
    const res = await tick();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true, sodRootedOn: today, changed: true });
    const lockAt = order.findIndex(([kind, value]) => kind === 'raw' && value === 'property-preferences');
    const visitReads = order.map(([kind, value], i) => (kind === 'table' && value === 'scheduled_services' ? i : -1)).filter((i) => i >= 0);
    expect(lockAt).toBeGreaterThan(-1);
    // The ownership read and the peek come before the transaction; the row lock is the read after the advisory lock.
    expect(visitReads.some((i) => i > lockAt)).toBe(true);
    expect(confirmSodRooted).toHaveBeenCalledWith(expect.anything(), { svc: expect.objectContaining({ customer_id: 'cust-1' }), expectedLaidOn: '2026-09-05' });
  });

  test('the service\'s refusals pass through with their own status and plain message', async () => {
    confirmSodRooted.mockResolvedValue({ status: 409, body: { error: 'The sod record changed. Close this sheet and open the visit again.', code: 'sod_record_changed' } });
    const res = await tick();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'The sod record changed. Close this sheet and open the visit again.', code: 'sod_record_changed' });
  });

  test('reassigned after the ownership check: 403, nothing written', async () => {
    const base = dbWithVisit({ sequence: [visit(), visit(), visit({ technician_id: 'tech-2' })] });
    mockDbCurrent = (table) => {
      if (table !== 'customers') return base(table);
      const chain = {};
      for (const m of ['where', 'whereNull', 'forShare']) chain[m] = () => chain;
      chain.first = async () => customerRow;
      return chain;
    };
    const res = await tick();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('service_not_assigned');
    expect(confirmSodRooted).not.toHaveBeenCalled();
  });

  test.each([['a pest visit', 'not_lawn'], ['a lawn re-service', 'lawn_re_service'], ['a closed visit', 'terminal_status']])('%s is refused with the sheet\'s own reason', async (_label, reason) => {
    resolveLawnFastEligibility.mockResolvedValue({ ok: true, reason, svc: { id: VISIT, customer_id: 'cust-1' } });
    const res = await tick();
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'lawn_fast_not_eligible', reason });
    expect(confirmSodRooted).not.toHaveBeenCalled();
  });

  test('a visit that moved to another customer after the lock was taken writes nothing', async () => {
    resolveLawnFastEligibility.mockResolvedValue({ ok: true, reason: null, svc: { id: VISIT, customer_id: 'cust-2' } });
    const res = await tick();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('visit_identity_changed');
    expect(confirmSodRooted).not.toHaveBeenCalled();
  });
});

// ?productIds= on the context and the treatment-guide reads (GATE_LAWN_TROUBLE_AREAS): the products the sheet names after a refused place.
describe('the sheet names its spot products after a refused place', () => {
  const GUIDE = '/:lawnFastServiceId/lawn-fast/treatment-guide';
  const GATES = ['GATE_LAWN_FAST_COMPLETE', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_V13'];
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  const A = '00000000-0000-4000-8000-0000000000a1';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const { buildLawnTreatmentGuide } = require('../services/lawn-fast-complete');
  const admin = { techRole: 'admin', technicianId: 'admin-1' };
  beforeEach(() => {
    for (const name of GATES) process.env[name] = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    buildLawnFastContext.mockReset().mockResolvedValue({ ok: true, eligible: true });
    buildLawnTreatmentGuide.mockReset().mockResolvedValue({ ok: true, v: 1, cards: [] });
  });
  afterEach(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    mockDbCurrent = null;
  });

  test('uuids only, deduplicated, at most 20, handed to the context and the guide', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`);
    await invoke('get', CONTEXT, { params, actor: admin, query: { productIds: `${A}, ${B.toUpperCase()},${A},not-a-uuid,` } });
    expect(buildLawnFastContext).toHaveBeenCalledWith(VISIT, { technicianId: 'admin-1', productIds: [A, B] });
    await invoke('get', GUIDE, { params, actor: admin, query: { assessmentId: 'x', productIds: many.join(',') } });
    expect(buildLawnTreatmentGuide.mock.calls[0][0].productIds).toEqual(many.slice(0, 20));
  });

  test('no parameter, no uuid in it, or the places gate off: the builders are called exactly as before', async () => {
    await invoke('get', CONTEXT, { params, actor: admin, query: {} });
    await invoke('get', CONTEXT, { params, actor: admin, query: { productIds: 'nope' } });
    expect(buildLawnFastContext.mock.calls.map((call) => call[1])).toEqual([{ technicianId: 'admin-1' }, { technicianId: 'admin-1' }]);
    delete process.env.GATE_LAWN_TROUBLE_AREAS;
    await invoke('get', CONTEXT, { params, actor: admin, query: { productIds: A } });
    expect(buildLawnFastContext.mock.calls[2][1]).toEqual({ technicianId: 'admin-1' });
    await invoke('get', GUIDE, { params, actor: admin, query: { assessmentId: 'x', productIds: A } });
    expect(buildLawnTreatmentGuide.mock.calls[0][0]).toEqual({ serviceId: VISIT, assessmentId: 'x' });
  });
});

