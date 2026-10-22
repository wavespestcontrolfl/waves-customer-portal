/**
 * GET /admin/dispatch/:serviceId/pest-recap/context is what the pest Fast Complete sheet opens with. With
 * GATE_FAST_COMPLETE_WRAP_UP exactly 'true' the answer also carries `wrapUp: true`; otherwise it is unchanged.
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
jest.mock('../services/pest-recap', () => ({ ...jest.requireActual('../services/pest-recap'), buildRecapContext: jest.fn() }));

const router = require('../routes/admin-dispatch');
const PestRecap = require('../services/pest-recap');

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


const CONTEXT_PATH = '/:serviceId/pest-recap/context';
const params = { serviceId: 'visit-1' };

// A scripted db: scheduled_services -> the owning row (assertRecapOwnership).
const dbWithOwner = (technician_id) => (table) => {
  const chain = {};
  for (const m of ['where', 'select', 'leftJoin']) chain[m] = () => chain;
  chain.first = async () => (table === 'scheduled_services' ? { id: 'visit-1', technician_id, status: 'confirmed', scheduled_date: require('../utils/datetime-et').etDateString(new Date()), service_type: 'Pest Control' } : null);
  return chain;
};

describe('GET pest-recap/context carries the Wrap-up gate (GATE_FAST_COMPLETE_WRAP_UP)', () => {
  const saved = process.env.GATE_FAST_COMPLETE_WRAP_UP;
  const CONTEXT = { ok: true, eligible: true, service: { id: 'visit-1' }, products: [] };
  beforeEach(() => {
    mockDbCurrent = dbWithOwner('tech-1');
    PestRecap.buildRecapContext.mockReset().mockResolvedValue(CONTEXT);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_FAST_COMPLETE_WRAP_UP; else process.env.GATE_FAST_COMPLETE_WRAP_UP = saved;
    mockDbCurrent = null;
  });

  test.each([undefined, '', 'false', '1', 'TRUE', 'on'])('gate %p: the answer is the context exactly as before, with no wrapUp key', async (value) => {
    if (value === undefined) delete process.env.GATE_FAST_COMPLETE_WRAP_UP; else process.env.GATE_FAST_COMPLETE_WRAP_UP = value;
    const res = await invoke('get', CONTEXT_PATH, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(CONTEXT);
    expect('wrapUp' in res.body).toBe(false);
  });

  test('gate on (exactly true): wrapUp is true beside the unchanged context', async () => {
    process.env.GATE_FAST_COMPLETE_WRAP_UP = 'true';
    const res = await invoke('get', CONTEXT_PATH, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ...CONTEXT, wrapUp: true });
  });

  test('gate on: a refused context carries no wrapUp, and a technician cannot read another technician\'s visit', async () => {
    process.env.GATE_FAST_COMPLETE_WRAP_UP = 'true';
    PestRecap.buildRecapContext.mockResolvedValue({ ok: false, reason: 'not_found' });
    const missing = await invoke('get', CONTEXT_PATH, { params });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
    mockDbCurrent = dbWithOwner('tech-2');
    const other = await invoke('get', CONTEXT_PATH, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(other.statusCode).toBe(403);
  });
});

describe('GET pest-recap/context carries the one-tap gate (GATE_ONE_TAP_REPORT)', () => {
  const saved = process.env.GATE_ONE_TAP_REPORT;
  const savedWrap = process.env.GATE_FAST_COMPLETE_WRAP_UP;
  // A visit of a recurring series: the one-tap report is the recurring pest sheet only.
  const CONTEXT = { ok: true, eligible: true, service: { id: 'visit-1', isRecurring: true }, products: [] };
  beforeEach(() => {
    delete process.env.GATE_FAST_COMPLETE_WRAP_UP;
    mockDbCurrent = dbWithOwner('tech-1');
    PestRecap.buildRecapContext.mockReset().mockResolvedValue(CONTEXT);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_ONE_TAP_REPORT; else process.env.GATE_ONE_TAP_REPORT = saved;
    if (savedWrap === undefined) delete process.env.GATE_FAST_COMPLETE_WRAP_UP; else process.env.GATE_FAST_COMPLETE_WRAP_UP = savedWrap;
    mockDbCurrent = null;
  });

  test.each([undefined, '', 'false', '1', 'TRUE', 'on'])('gate %p: no oneTap key, the context exactly as before', async (value) => {
    if (value === undefined) delete process.env.GATE_ONE_TAP_REPORT; else process.env.GATE_ONE_TAP_REPORT = value;
    const res = await invoke('get', CONTEXT_PATH, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(CONTEXT);
    expect('oneTap' in res.body).toBe(false);
  });

  test('gate on (exactly true): oneTap is true beside the unchanged context, and wrapUp stays its own key', async () => {
    process.env.GATE_ONE_TAP_REPORT = 'true';
    const res = await invoke('get', CONTEXT_PATH, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ...CONTEXT, oneTap: true });
    process.env.GATE_FAST_COMPLETE_WRAP_UP = 'true';
    const both = await invoke('get', CONTEXT_PATH, { params });
    expect(both.body).toEqual({ ...CONTEXT, wrapUp: true, oneTap: true });
  });

  test.each([false, undefined])('gate on, a visit outside a recurring series (isRecurring %p): no oneTap key', async (isRecurring) => {
    process.env.GATE_ONE_TAP_REPORT = 'true';
    const oneTime = { ...CONTEXT, service: { id: 'visit-1', ...(isRecurring === undefined ? {} : { isRecurring }) } };
    PestRecap.buildRecapContext.mockResolvedValue(oneTime);
    const res = await invoke('get', CONTEXT_PATH, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(oneTime);
  });

  test.each([
    ['the pest re-service', { isRecurring: false, serviceKey: 'pest_re_service' }],
    ['a free callback under a regular key', { isRecurring: false, isCallback: true, serviceKey: 'pest_general_quarterly' }],
  ])('gate on, %s (a re-service): oneTap is true', async (_label, visit) => {
    process.env.GATE_ONE_TAP_REPORT = 'true';
    const reservice = { ...CONTEXT, service: { id: 'visit-1', ...visit } };
    PestRecap.buildRecapContext.mockResolvedValue(reservice);
    const res = await invoke('get', CONTEXT_PATH, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ...reservice, oneTap: true });
  });

  test('gate on: a refused context carries no oneTap', async () => {
    process.env.GATE_ONE_TAP_REPORT = 'true';
    PestRecap.buildRecapContext.mockResolvedValue({ ok: false, reason: 'not_found' });
    const missing = await invoke('get', CONTEXT_PATH, { params });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });
});

describe('GET pest-recap/context carries the pest stock advisory (GATE_PEST_STOCK_ADVISORY)', () => {
  const saved = process.env.GATE_PEST_STOCK_ADVISORY;
  const savedOneTap = process.env.GATE_ONE_TAP_REPORT;
  const savedWrap = process.env.GATE_FAST_COMPLETE_WRAP_UP;
  const CONTEXT = { ok: true, eligible: true, service: { id: 'visit-1', serviceType: 'Quarterly Pest Control' }, products: [] };
  beforeEach(() => {
    delete process.env.GATE_ONE_TAP_REPORT;
    delete process.env.GATE_FAST_COMPLETE_WRAP_UP;
    mockDbCurrent = dbWithOwner('tech-1');
    PestRecap.buildRecapContext.mockReset().mockResolvedValue(CONTEXT);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_PEST_STOCK_ADVISORY; else process.env.GATE_PEST_STOCK_ADVISORY = saved;
    if (savedOneTap === undefined) delete process.env.GATE_ONE_TAP_REPORT; else process.env.GATE_ONE_TAP_REPORT = savedOneTap;
    if (savedWrap === undefined) delete process.env.GATE_FAST_COMPLETE_WRAP_UP; else process.env.GATE_FAST_COMPLETE_WRAP_UP = savedWrap;
    mockDbCurrent = null;
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: no stockAdvisory key, the context exactly as before', async (value) => {
    if (value === undefined) delete process.env.GATE_PEST_STOCK_ADVISORY; else process.env.GATE_PEST_STOCK_ADVISORY = value;
    const res = await invoke('get', CONTEXT_PATH, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(CONTEXT);
  });

  test('gate on (exactly true), a pest visit: stockAdvisory is true, on any pest sheet (not only one-tap)', async () => {
    process.env.GATE_PEST_STOCK_ADVISORY = 'true';
    const res = await invoke('get', CONTEXT_PATH, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ...CONTEXT, stockAdvisory: true });
  });

  test('gate on, a visit /complete still refuses below zero (mosquito): no stockAdvisory key', async () => {
    process.env.GATE_PEST_STOCK_ADVISORY = 'true';
    const mosquito = { ...CONTEXT, service: { id: 'visit-1', serviceType: 'Mosquito Control' } };
    PestRecap.buildRecapContext.mockResolvedValue(mosquito);
    const res = await invoke('get', CONTEXT_PATH, { params });
    expect(res.body).toEqual(mosquito);
  });
});
