/**
 * POST /admin/dispatch/:serviceId/fast-complete/voice-fill (Fast Complete voice
 * fill, dark behind GATE_FAST_COMPLETE_VOICE_FILL). The model call is mocked.
 *
 *  - Gate off answers 404 {enabled:false} without touching the database.
 *  - A technician only fills their own visit; admins any.
 *  - A visit whose live completion profile is not pest_re_service is a 409.
 *  - The body must be { sheet: 'pest_reservice', transcript: 1..4000 chars }.
 *  - The happy path answers the validated fill; a model failure is a 502.
 *  - The audit line carries ids and counts only: never the transcript or notes.
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/pest-recap', () => ({
  ...jest.requireActual('../services/pest-recap'),
  resolveEligibility: jest.fn(),
  loadRecapCatalogProducts: jest.fn(),
}));
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  callAnthropic: jest.fn(),
}));

const logger = require('../services/logger');
const { resolveEligibility, loadRecapCatalogProducts } = require('../services/pest-recap');
const { callAnthropic } = require('../services/llm/call');
const MODELS = require('../config/models');
const router = require('../routes/admin-dispatch');

const PATH = '/:serviceId/fast-complete/voice-fill';
const params = { serviceId: 'visit-1' };

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

function invoke({ body, actor = { techRole: 'admin', technicianId: 'admin-1' } } = {}) {
  const layer = routeLayer('post', PATH);
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

// scheduled_services -> the owning row (assertRecapOwnership); product_aliases -> one alias.
const dbWithOwner = (technician_id, calls = []) => (table) => {
  calls.push(table);
  const chain = {};
  for (const m of ['where', 'whereIn', 'select', 'leftJoin']) chain[m] = () => chain;
  chain.first = async () => (table === 'scheduled_services' ? { id: 'visit-1', technician_id } : null);
  chain.then = (resolve, reject) => Promise.resolve(table === 'product_aliases' ? [{ product_id: 'p-talak', alias_name: 'Talstar P' }] : []).then(resolve, reject);
  return chain;
};

const CATALOG = [
  { id: 'p-taurus', name: 'Taurus SC', category: 'insecticide', inventory_unit: 'fl_oz', formulation: 'SC' },
  { id: 'p-talak', name: 'Atticus Talak 7.9 F', category: 'insecticide', inventory_unit: 'fl_oz', formulation: 'SC' },
  { id: 'p-supply', name: 'Yard sign', category: 'supplies' },
];
const eligible = () => resolveEligibility.mockResolvedValue({ ok: true, svc: { id: 'visit-1' }, profile: { serviceKey: 'pest_re_service', category: 'pest_control' }, eligible: true });

const TRANSCRIPT = 'Did the perimeter outside for ants, 4 ounces of Taurus, light activity. Note for the office: gate code is 7731.';
const MODEL_ANSWER = {
  products: [{ productId: 'p-taurus', amount: 4, unit: 'oz', sameAsLast: false, method: 'perimeter_spray', heard: '4 ounces of Taurus' }],
  visit: { pests: ['Ants'], otherPest: '', areas: ['Outside'], method: 'perimeter_spray', linearFt: 0, activity: 'light', heard: 'perimeter outside for ants' },
  customerNote: 'Treated the perimeter outside for ants.',
  officeNote: 'Gate code is 7731.',
  unclear: [],
};

describe('POST fast-complete/voice-fill', () => {
  const savedGate = process.env.GATE_FAST_COMPLETE_VOICE_FILL;
  beforeEach(() => {
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    eligible();
    loadRecapCatalogProducts.mockResolvedValue(CATALOG);
    callAnthropic.mockResolvedValue({ ok: true, json: MODEL_ANSWER });
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_FAST_COMPLETE_VOICE_FILL; else process.env.GATE_FAST_COMPLETE_VOICE_FILL = savedGate;
    mockDbCurrent = null;
    jest.clearAllMocks();
  });

  test('is registered after the router-level auth, behind a rate limiter', () => {
    const layer = routeLayer('post', PATH);
    expect(layer).toBeTruthy();
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(authIdx).toBeGreaterThan(-1);
    expect(router.stack.indexOf(layer)).toBeGreaterThan(authIdx);
    // limiter, then the handler
    expect(layer.route.stack).toHaveLength(2);
  });

  test.each([undefined, '', 'false', '1', 'TRUE', 'on'])('gate %p answers 404 {enabled:false} and reads and calls nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_FAST_COMPLETE_VOICE_FILL; else process.env.GATE_FAST_COMPLETE_VOICE_FILL = value;
    const calls = [];
    mockDbCurrent = dbWithOwner('tech-1', calls);
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  test("a technician cannot fill another technician's visit", async () => {
    mockDbCurrent = dbWithOwner('tech-2');
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT }, actor: { techRole: 'technician', technicianId: 'tech-1' } });
    expect(res.statusCode).toBe(403);
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  test('a visit whose completion profile is not pest_re_service is a 409 and the model is never called', async () => {
    resolveEligibility.mockResolvedValue({ ok: true, svc: {}, profile: { serviceKey: 'lawn_re_service', category: 'lawn_care' }, eligible: false });
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'not_pest_re_service', code: 'not_pest_re_service' });
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  test('a pest re-service the short form cannot take (typed / project-backed) is a 409', async () => {
    resolveEligibility.mockResolvedValue({ ok: true, svc: {}, profile: { serviceKey: 'pest_re_service' }, eligible: false });
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('not_eligible');
  });

  test('a visit that disappears is 404', async () => {
    resolveEligibility.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
    expect(res.statusCode).toBe(404);
  });

  describe('body validation (400)', () => {
    const long = 'a'.repeat(4001);
    test.each([
      ['no body', undefined],
      ['no sheet', { transcript: 'hello' }],
      ['unknown sheet', { sheet: 'tree_shrub', transcript: 'hello' }],
      ['inherited sheet name', { sheet: 'constructor', transcript: 'hello' }],
      ['no transcript', { sheet: 'pest_reservice' }],
      ['empty transcript', { sheet: 'pest_reservice', transcript: '' }],
      ['blank transcript', { sheet: 'pest_reservice', transcript: '   ' }],
      ['non-string transcript', { sheet: 'pest_reservice', transcript: ['hello'] }],
      ['transcript over 4000 characters', { sheet: 'pest_reservice', transcript: long }],
    ])('%s', async (_name, body) => {
      const res = await invoke({ body });
      expect(res.statusCode).toBe(400);
      expect(callAnthropic).not.toHaveBeenCalled();
    });

    test('a transcript of exactly 4000 characters is accepted', async () => {
      const res = await invoke({ body: { sheet: 'pest_reservice', transcript: 'a'.repeat(4000) } });
      expect(res.statusCode).toBe(200);
    });
  });

  test('happy path: the model is asked on the FAST tier with a closed schema and the validated fill comes back', async () => {
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      products: [{ productId: 'p-taurus', amount: 4, unit: 'fl_oz', sameAsLast: false, method: 'perimeter_spray', heard: '4 ounces of Taurus' }],
      visit: { pests: ['Ants'], otherPest: '', areas: ['Outside'], method: 'perimeter_spray', linearFt: null, activity: 'light', heard: 'perimeter outside for ants' },
      customerNote: 'Treated the perimeter outside for ants.',
      officeNote: 'Gate code is 7731.',
      unclear: [],
    });
    const request = callAnthropic.mock.calls[0][0];
    expect(request.model).toBe(MODELS.FAST);
    expect(request.jsonMode).toBe(true);
    expect(request.jsonSchema.additionalProperties).toBe(false);
    // the choices came from the sheet's own catalog (hidden categories left out) with the alias list
    expect(request.text).toContain('p-taurus | Taurus SC');
    expect(request.text).toContain('p-talak | Atticus Talak 7.9 F | also called: Talstar P');
    expect(request.text).not.toContain('Yard sign');
    expect(request.text).toContain(TRANSCRIPT);
  });

  test('an off-list product from the model comes back as unclear, not as a tap', async () => {
    callAnthropic.mockResolvedValue({ ok: true, json: { ...MODEL_ANSWER, products: [{ productId: 'p-invented', amount: 0, unit: 'not_said', sameAsLast: false, method: 'not_said', heard: '4 ounces of Taurus' }] } });
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
    expect(res.statusCode).toBe(200);
    expect(res.body.products).toEqual([]);
    expect(res.body.unclear).toEqual([{ heard: '4 ounces of Taurus', reason: 'not_on_sheet' }]);
  });

  test.each([
    ['the adapter reports a failure', { ok: false, reason: 'anthropic_529' }],
    ['the adapter returns no JSON', { ok: true, json: null }],
  ])('model failure (%s) is a 502 and tells the client to keep typing', async (_name, result) => {
    callAnthropic.mockResolvedValue(result);
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Voice fill is unavailable right now. Keep typing.' });
  });

  test('a throwing model call is a 502 too', async () => {
    callAnthropic.mockRejectedValue(new Error('socket hang up'));
    const res = await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
    expect(res.statusCode).toBe(502);
  });

  describe('audit line', () => {
    const lines = () => logger.info.mock.calls.map((c) => String(c[0]));

    test('carries ids and counts, never the transcript or either note', async () => {
      await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT }, actor: { techRole: 'technician', technicianId: 'tech-1' } });
      const audit = lines().filter((l) => l.includes('[voice-fill]'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toContain('service=visit-1');
      expect(audit[0]).toContain('tech=tech-1');
      expect(audit[0]).toContain(`chars=${TRANSCRIPT.length}`);
      expect(audit[0]).toContain('products=1');
      expect(audit[0]).toContain('unclear=0');
      expect(audit[0]).toContain('officeNote=true');
    });

    test('nothing logged at any level holds a word of the transcript or the notes', async () => {
      callAnthropic.mockResolvedValueOnce({ ok: true, json: MODEL_ANSWER });
      await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
      callAnthropic.mockResolvedValueOnce({ ok: false, reason: 'anthropic_529' });
      await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
      callAnthropic.mockRejectedValueOnce(new Error('upstream said: Note for the office: gate code is 7731'));
      await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
      const everything = ['info', 'warn', 'error', 'debug'].flatMap((level) => logger[level].mock.calls.map((c) => c.join(' '))).join('\n');
      for (const secret of ['7731', 'Taurus', 'perimeter', 'Note for the office', 'gate code', 'ants']) {
        expect(everything).not.toContain(secret);
      }
    });

    test('a model failure is audited with ok=false and no counts of words', async () => {
      callAnthropic.mockResolvedValue({ ok: false, reason: 'anthropic_529' });
      await invoke({ body: { sheet: 'pest_reservice', transcript: TRANSCRIPT } });
      const audit = lines().find((l) => l.includes('[voice-fill]'));
      expect(audit).toContain('ok=false');
      expect(audit).toContain(`chars=${TRANSCRIPT.length}`);
    });
  });
});
