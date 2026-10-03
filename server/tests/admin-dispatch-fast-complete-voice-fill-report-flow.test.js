/**
 * The report flow's two voice-fill reads (GATE_FAST_COMPLETE_VOICE_FILL), for any
 * untyped pest visit, a regular visit or a re-service. The transcriber and the
 * model are mocked.
 *
 *  POST /admin/dispatch/:serviceId/fast-complete/voice-fill/products  { note }
 *   - answers the products the note names, checked by the re-service fill's own
 *     product rules, and nothing else (no visit taps, no notes);
 *   - a failed read is { available: true, status: 'failed' }, never an error;
 *   - a typed or project-backed visit is refused (409) before any model call.
 *
 *  POST /admin/dispatch/:serviceId/fast-complete/voice-fill/dictation  (multipart)
 *   - answers the clip's words for the note box, heard with the sheet's product names.
 *
 *  Neither audit line carries a word the tech said.
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
jest.mock('../services/pest-recap', () => ({
  ...jest.requireActual('../services/pest-recap'),
  resolveEligibility: jest.fn(),
  loadRecapCatalogProducts: jest.fn(),
  loadCommonProducts: jest.fn(),
}));
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  callAnthropic: jest.fn(),
}));
jest.mock('../services/call-recording-processor', () => ({
  ...jest.requireActual('../services/call-recording-processor'),
  transcribeWithOpenAI: jest.fn(),
}));

const logger = require('../services/logger');
const { resolveEligibility, loadRecapCatalogProducts, loadCommonProducts } = require('../services/pest-recap');
const { callAnthropic } = require('../services/llm/call');
const { transcribeWithOpenAI } = require('../services/call-recording-processor');
const router = require('../routes/admin-dispatch');

const PRODUCTS_PATH = '/:serviceId/fast-complete/voice-fill/products';
const DICTATION_PATH = '/:serviceId/fast-complete/voice-fill/dictation';
const layer = (path) => router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
const newRes = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } });
const ADMIN = { techRole: 'admin', technicianId: 'admin-1' };

// The final handler of a route, as the layers before it would hand it the request.
function invoke(path, req) {
  const stack = layer(path).route.stack;
  const handler = stack[stack.length - 1].handle;
  const res = newRes();
  return new Promise((resolve, reject) => {
    handler({ params: { serviceId: 'visit-1' }, query: {}, ...ADMIN, ...req }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res)).catch(reject);
  });
}
const readProducts = (note, req = {}) => invoke(PRODUCTS_PATH, { body: { note }, ...req });
const dictate = (req = {}) => invoke(DICTATION_PATH, {
  body: { duration_seconds: '12' }, file: { buffer: Buffer.from('audio-bytes'), mimetype: 'audio/webm;codecs=opus' }, ...req,
});

const dbWithOwner = (technician_id) => (table) => {
  const chain = {};
  for (const m of ['where', 'whereIn', 'select', 'leftJoin']) chain[m] = () => chain;
  chain.first = async () => (table === 'scheduled_services' ? { id: 'visit-1', technician_id, status: 'scheduled', scheduled_date: new Date().toISOString().slice(0, 10) } : null);
  chain.then = (resolve, reject) => Promise.resolve(table === 'product_aliases' ? [{ product_id: 'p-talak', alias_name: 'Talstar P' }] : []).then(resolve, reject);
  return chain;
};
const CATALOG = [
  { id: 'p-taurus', name: 'Taurus SC', category: 'insecticide', inventory_unit: 'fl_oz', formulation: 'SC' },
  { id: 'p-talak', name: 'Atticus Talak 7.9 F', category: 'insecticide', inventory_unit: 'fl_oz', formulation: 'SC' },
];
// A regular quarterly visit: a pest_control profile that is not the re-service.
const regularVisit = () => resolveEligibility.mockResolvedValue({ ok: true, svc: { id: 'visit-1' }, profile: { serviceKey: 'quarterly_pest', category: 'pest_control' }, eligible: true });

const NOTE = 'Quarterly service. Sprayed the perimeter outside for ants, 6 ounces of Taurus, light activity. Gate code is 7731.';
const MODEL_ANSWER = {
  products: [{ productId: 'p-taurus', amount: 6, unit: 'oz', sameAsLast: false, method: 'perimeter_spray', heard: '6 ounces of Taurus' }],
  visit: { pests: ['Ants'], otherPest: '', areas: ['Outside'], method: 'perimeter_spray', linearFt: 0, activity: 'light', heard: 'perimeter outside for ants' },
  customerNote: 'Sprayed the perimeter outside for ants.',
  officeNote: 'Gate code is 7731.',
  unclear: [],
};
const everythingLogged = () => ['info', 'warn', 'error', 'debug'].flatMap((level) => logger[level].mock.calls.map((c) => c.join(' '))).join('\n');

describe('report flow voice fill', () => {
  const savedGate = process.env.GATE_FAST_COMPLETE_VOICE_FILL;
  beforeEach(() => {
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    regularVisit();
    loadRecapCatalogProducts.mockResolvedValue(CATALOG);
    loadCommonProducts.mockResolvedValue([]);
    callAnthropic.mockResolvedValue({ ok: true, json: MODEL_ANSWER });
    transcribeWithOpenAI.mockResolvedValue({ text: NOTE });
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_FAST_COMPLETE_VOICE_FILL; else process.env.GATE_FAST_COMPLETE_VOICE_FILL = savedGate;
    mockDbCurrent = null;
    jest.clearAllMocks();
  });

  test.each([
    [PRODUCTS_PATH, 3],
    [DICTATION_PATH, 5],
  ])('%s: the dark gate answers first, ahead of its limiter', (path, layers) => {
    const stack = layer(path).route.stack;
    expect(stack).toHaveLength(layers);
    delete process.env.GATE_FAST_COMPLETE_VOICE_FILL;
    const res = newRes();
    const next = jest.fn();
    stack[0].handle({}, res, next);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(next).not.toHaveBeenCalled();
  });

  describe('products from the note', () => {
    test('a regular pest visit: the products the note names come back, and nothing else', async () => {
      const res = await readProducts(NOTE);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        enabled: true,
        available: true,
        status: 'read',
        products: [{ productId: 'p-taurus', amount: 6, unit: 'fl_oz', sameAsLast: false, method: 'perimeter_spray', heard: '6 ounces of Taurus' }],
        unclear: [],
      });
      // the model is told it is a pest visit, not a re-service
      expect(callAnthropic.mock.calls[0][0].text).toContain('SHEET: pest visit');
    });

    test('a pest re-service is read the same way, under its own name', async () => {
      resolveEligibility.mockResolvedValue({ ok: true, svc: { id: 'visit-1' }, profile: { serviceKey: 'pest_re_service', category: 'pest_control' }, eligible: true });
      const res = await readProducts(NOTE);
      expect(res.body.products).toHaveLength(1);
      expect(callAnthropic.mock.calls[0][0].text).toContain('SHEET: pest re-service');
    });

    test('an amount with no spoken number is not a tap: the row comes back without one', async () => {
      callAnthropic.mockResolvedValue({ ok: true, json: { ...MODEL_ANSWER, products: [{ productId: 'p-talak', amount: 4, unit: 'fl_oz', sameAsLast: false, method: 'not_said', heard: 'Talstar P' }] } });
      const res = await readProducts('Used Talstar P around the back door.');
      expect(res.body.products).toEqual([expect.objectContaining({ productId: 'p-talak', amount: null })]);
    });

    test('only the model\'s Checks about a product are kept', async () => {
      callAnthropic.mockResolvedValue({ ok: true, json: {
        ...MODEL_ANSWER,
        unclear: [
          { heard: 'light activity', reason: 'unclear_other' },
          { heard: 'Quarterly service', reason: 'unknown_product' },
        ],
      } });
      const res = await readProducts(NOTE);
      expect(res.body.unclear).toEqual([{ heard: 'Quarterly service', reason: 'unknown_product' }]);
    });

    test('a product the tech said they did not use is a Check, never a row', async () => {
      callAnthropic.mockResolvedValue({ ok: true, json: { ...MODEL_ANSWER, products: [{ productId: 'p-taurus', amount: 0, unit: 'not_said', sameAsLast: false, method: 'not_said', heard: 'did not use Taurus' }] } });
      const res = await readProducts('I did not use Taurus today.');
      expect(res.body.products).toEqual([]);
      expect(res.body.unclear.map((u) => u.reason)).toContain('negated_product');
    });

    test('an empty note is an empty read and no model call', async () => {
      const res = await readProducts('   ');
      expect(res.body).toMatchObject({ available: true, status: 'read', products: [], unclear: [] });
      expect(callAnthropic).not.toHaveBeenCalled();
    });

    test('a note that is not text is a 400', async () => {
      expect((await readProducts(['hello'])).statusCode).toBe(400);
      expect(callAnthropic).not.toHaveBeenCalled();
    });

    test.each([
      ['the model fails', () => callAnthropic.mockResolvedValue({ ok: false, reason: 'anthropic_529' }), NOTE, 'model_failed'],
      ['the model throws', () => callAnthropic.mockRejectedValue(new Error('socket hang up')), NOTE, 'model_failed'],
      ['the catalog is empty', () => loadRecapCatalogProducts.mockResolvedValue([]), NOTE, 'catalog_unavailable'],
      ['the note is past the cap (never cut)', () => {}, 'a'.repeat(4001), 'note_too_long'],
    ])('%s: a failed read, never an error, so the sheet carries on', async (_name, arrange, note, reason) => {
      arrange();
      const res = await readProducts(note);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ enabled: true, available: true, status: 'failed', reason, products: [], unclear: [] });
    });

    test('a note past the cap never reaches the model', async () => {
      await readProducts('a'.repeat(4001));
      expect(callAnthropic).not.toHaveBeenCalled();
    });

    test.each([
      ['a typed or project-backed visit', { ok: true, svc: {}, profile: { serviceKey: 'cockroach', category: 'pest_control', findingsType: 'cockroach' }, eligible: false }, 409],
      ['a lawn visit', { ok: true, svc: {}, profile: { serviceKey: 'lawn', category: 'lawn_care' }, eligible: false }, 409],
      ['a visit that is gone', { ok: false, reason: 'not_found' }, 404],
    ])('%s is refused before any model call', async (_name, eligibility, status) => {
      resolveEligibility.mockResolvedValue(eligibility);
      const res = await readProducts(NOTE);
      expect(res.statusCode).toBe(status);
      expect(callAnthropic).not.toHaveBeenCalled();
    });

    test("a technician cannot read another technician's visit", async () => {
      mockDbCurrent = dbWithOwner('tech-2');
      const res = await readProducts(NOTE, { techRole: 'technician', technicianId: 'tech-1' });
      expect(res.statusCode).toBe(403);
      expect(callAnthropic).not.toHaveBeenCalled();
    });

    test('the audit line carries counts, never the note', async () => {
      await readProducts(NOTE, { techRole: 'technician', technicianId: 'tech-1' });
      callAnthropic.mockRejectedValueOnce(new Error('upstream said: Gate code is 7731'));
      await readProducts(NOTE);
      const everything = everythingLogged();
      const audit = everything.split('\n').filter((l) => l.includes('[voice-fill] products'));
      expect(audit).toHaveLength(2);
      expect(audit[0]).toContain('service=visit-1');
      expect(audit[0]).toContain('tech=tech-1');
      expect(audit[0]).toContain(`chars=${NOTE.length}`);
      expect(audit[0]).toContain('products=1');
      expect(audit[1]).toContain('ok=false reason=model_failed');
      for (const secret of ['7731', 'Taurus', 'perimeter', 'Gate code', 'ants']) expect(everything).not.toContain(secret);
    });
  });

  describe('the note mic', () => {
    test('the clip comes back as words, heard with the sheet\'s product names', async () => {
      const res = await dictate();
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ text: NOTE });
      const [audio, opts] = transcribeWithOpenAI.mock.calls[0];
      expect(Buffer.isBuffer(audio)).toBe(true);
      expect(opts).toMatchObject({ model: 'gpt-transcribe', mimeType: 'audio/webm', filename: 'clip.webm', emptyOk: true });
      for (const name of ['Taurus SC', 'Atticus Talak 7.9 F', 'Talstar P']) expect(opts.prompt).toContain(name);
      // words only: no model fills anything here
      expect(callAnthropic).not.toHaveBeenCalled();
    });

    test('silence is an empty note, not a failure', async () => {
      transcribeWithOpenAI.mockResolvedValue({ text: '' });
      const res = await dictate();
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ text: '' });
    });

    test.each([
      ['the transcriber returns nothing', () => transcribeWithOpenAI.mockResolvedValue(null)],
      ['the transcriber throws', () => transcribeWithOpenAI.mockRejectedValue(new Error('upstream'))],
      ['the transcript is implausibly long for the clip', () => transcribeWithOpenAI.mockResolvedValue({ text: 'word '.repeat(400) })],
    ])('%s: 502, type your notes', async (_name, arrange) => {
      arrange();
      const res = await dictate({ body: { duration_seconds: '3' } });
      expect(res.statusCode).toBe(502);
      expect(res.body).toEqual({ error: 'Transcription unavailable. Type your notes instead.' });
    });

    test.each([
      ['no audio', { file: null }, 400],
      ['an unsupported audio type', { file: { buffer: Buffer.from('x'), mimetype: 'video/mp4' } }, 415],
    ])('%s is refused without transcribing', async (_name, over, status) => {
      const res = await dictate(over);
      expect(res.statusCode).toBe(status);
      expect(transcribeWithOpenAI).not.toHaveBeenCalled();
    });

    test('a visit the sheet does not take is refused without transcribing', async () => {
      resolveEligibility.mockResolvedValue({ ok: true, svc: {}, profile: { serviceKey: 'lawn', category: 'lawn_care' }, eligible: false });
      const res = await dictate();
      expect(res.statusCode).toBe(409);
      expect(transcribeWithOpenAI).not.toHaveBeenCalled();
    });

    test('a technician who does not own the visit is refused before the upload is parsed', async () => {
      mockDbCurrent = dbWithOwner('someone-else');
      const res = newRes();
      const next = jest.fn();
      await layer(DICTATION_PATH).route.stack[2].handle({ params: { serviceId: 'visit-1' }, techRole: 'technician', technicianId: 'tech-1' }, res, next);
      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    test('the audit line carries sizes, never the words', async () => {
      await dictate({ techRole: 'technician', technicianId: 'tech-1' });
      const everything = everythingLogged();
      const audit = everything.split('\n').filter((l) => l.includes('[voice-fill] dictation'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toContain('tech=tech-1');
      expect(audit[0]).toContain('type=audio/webm');
      expect(audit[0]).toContain(`chars=${NOTE.length}`);
      for (const secret of ['7731', 'Taurus', 'perimeter', 'Gate code', 'ants']) expect(everything).not.toContain(secret);
    });
  });
});
