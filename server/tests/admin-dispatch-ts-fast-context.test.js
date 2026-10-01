/**
 * GET /admin/dispatch/:serviceId/tree-shrub/fast-context (T&S Fast Complete,
 * dark behind GATE_TS_FAST_COMPLETE) and the additive `suggestedCondition` on
 * POST .../tree-shrub/assess-preview.
 *
 *  - Gate off answers 404 {enabled:false} without touching the database.
 *  - The caller's ts_fast_complete user flag is rechecked here, not only on
 *    the schedule payload: unflagged answers 404 {enabled:false}.
 *  - A technician only reads their own visit; admins read any.
 *  - Gate on returns the context builder's body under {enabled:true}; a missing
 *    visit is 404 and an ineligible visit is a 200 with its reason.
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
jest.mock('../services/tree-shrub-fast-context', () => ({ buildTreeShrubFastContext: jest.fn() }));
jest.mock('../services/feature-flags', () => ({
  ...jest.requireActual('../services/feature-flags'),
  isUserFeatureEnabled: jest.fn(async () => true),
}));
jest.mock('../services/tree-shrub-assessment', () => ({
  ...jest.requireActual('../services/tree-shrub-assessment'),
  previewTreeShrubAssessment: jest.fn(),
}));

const router = require('../routes/admin-dispatch');
const { buildTreeShrubFastContext } = require('../services/tree-shrub-fast-context');
const { previewTreeShrubAssessment } = require('../services/tree-shrub-assessment');
const { isUserFeatureEnabled } = require('../services/feature-flags');

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

const FAST = '/:serviceId/tree-shrub/fast-context';
const params = { serviceId: 'visit-1' };

// A scripted db: scheduled_services -> the owning row (assertRecapOwnership).
const dbWithOwner = (technician_id, calls = []) => (table) => {
  calls.push(table);
  const chain = {};
  for (const m of ['where', 'select', 'leftJoin']) chain[m] = () => chain;
  chain.first = async () => (table === 'scheduled_services' ? { id: 'visit-1', technician_id, service_type: 'Tree & Shrub Care' } : null);
  return chain;
};

describe('GET tree-shrub/fast-context', () => {
  const savedGate = process.env.GATE_TS_FAST_COMPLETE;
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_TS_FAST_COMPLETE; else process.env.GATE_TS_FAST_COMPLETE = savedGate;
    mockDbCurrent = null;
    buildTreeShrubFastContext.mockReset();
  });

  test('is registered on the router after the router-level auth', () => {
    const layer = routeLayer('get', FAST);
    expect(layer).toBeTruthy();
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(authIdx).toBeGreaterThan(-1);
    expect(router.stack.indexOf(layer)).toBeGreaterThan(authIdx);
  });

  test.each([undefined, '', 'false', '1', 'TRUE', 'on'])('gate %p answers 404 {enabled:false} and reads nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_TS_FAST_COMPLETE; else process.env.GATE_TS_FAST_COMPLETE = value;
    const calls = [];
    mockDbCurrent = dbWithOwner('tech-1', calls);
    const res = await invoke('get', FAST, { params });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
    expect(buildTreeShrubFastContext).not.toHaveBeenCalled();
  });

  test('gate on: the owning technician gets the context under {enabled:true}', async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    buildTreeShrubFastContext.mockResolvedValue({ ok: true, eligible: true, reason: null, service: { id: 'visit-1' }, products: [], monthProducts: [], lastVisit: null, warnings: [] });
    const res = await invoke('get', FAST, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true, eligible: true, reason: null, service: { id: 'visit-1' }, products: [], monthProducts: [], lastVisit: null, warnings: [] });
    expect(buildTreeShrubFastContext).toHaveBeenCalledWith('visit-1');
  });

  test.each([
    ['without the ts_fast_complete flag', async () => false],
    ['when the flag read fails', async () => { throw new Error('flags down'); }],
  ])('gate on: a technician %s gets 404 {enabled:false} and no context', async (_label, impl) => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    isUserFeatureEnabled.mockImplementationOnce(impl);
    const res = await invoke('get', FAST, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(isUserFeatureEnabled).toHaveBeenCalledWith('tech-1', 'ts_fast_complete');
    expect(buildTreeShrubFastContext).not.toHaveBeenCalled();
  });

  test("gate on: a technician cannot read another technician's visit", async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-2');
    const res = await invoke('get', FAST, { params, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(403);
    expect(buildTreeShrubFastContext).not.toHaveBeenCalled();
  });

  test('gate on: an admin reads any visit', async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-2');
    buildTreeShrubFastContext.mockResolvedValue({ ok: true, eligible: false, reason: 'grouped_visit', service: { id: 'visit-1' } });
    const res = await invoke('get', FAST, { params });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true, eligible: false, reason: 'grouped_visit', service: { id: 'visit-1' } });
  });

  test('gate on: a visit that disappears is 404', async () => {
    process.env.GATE_TS_FAST_COMPLETE = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    buildTreeShrubFastContext.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await invoke('get', FAST, { params });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});

describe('POST tree-shrub/assess-preview suggestedCondition', () => {
  const PREVIEW = '/:serviceId/tree-shrub/assess-preview';
  const photos = [{ data: 'data:image/jpeg;base64,AAAA' }];
  const previewResult = (overallScore) => ({
    scores: { overallScore, foliageFullness: overallScore }, scoredCount: 1, photoCount: 1, observations: 'Looks fine.', findings: [],
  });
  beforeEach(() => {
    mockDbCurrent = (table) => {
      const chain = {};
      for (const m of ['where', 'select']) chain[m] = () => chain;
      chain.first = async () => ({ id: 'visit-1', technician_id: 'admin-1', service_type: 'Tree & Shrub Care' });
      return chain;
    };
  });
  afterEach(() => { mockDbCurrent = null; previewTreeShrubAssessment.mockReset(); });

  test.each([[90, 'Excellent'], [75, 'Good'], [60, 'Fair'], [30, 'Poor']])('score %i suggests %s beside the unchanged response', async (score, expected) => {
    previewTreeShrubAssessment.mockResolvedValue(previewResult(score));
    const res = await invoke('post', PREVIEW, { params, body: { photos } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'complete', suggestedCondition: expected, scores: { overallScore: score } });
    expect(res.body.signature).toBeTruthy();
    expect(res.body.photosHash).toBeTruthy();
  });

  test('a score-less preview suggests nothing', async () => {
    previewTreeShrubAssessment.mockResolvedValue(previewResult(null));
    const res = await invoke('post', PREVIEW, { params, body: { photos } });
    expect(res.body.suggestedCondition).toBeNull();
  });

  test('an unscorable preview stays a failed 200 with a null suggestion', async () => {
    previewTreeShrubAssessment.mockResolvedValue(null);
    const res = await invoke('post', PREVIEW, { params, body: { photos } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'failed', scores: null, suggestedCondition: null });
  });
});
