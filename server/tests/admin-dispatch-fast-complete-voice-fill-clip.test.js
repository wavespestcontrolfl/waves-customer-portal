/**
 * POST /api/admin/dispatch/:serviceId/fast-complete/voice-fill/clip — voice fill
 * from a recorded clip (owner ruling 2026-10-03, "always our transcriber"; dark
 * behind GATE_FAST_COMPLETE_VOICE_FILL). The transcriber and the model are mocked.
 *
 *  - Dark gate, limiter and ownership fence, all ahead of the body parse.
 *  - The clip is transcribed with the sheet's own product names and aliases.
 *  - A transcriber or model failure is a 502; an unsupported audio type is a 415.
 *  - The audit line carries sizes and counts only: never the transcript or notes.
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

const PATH = '/:serviceId/fast-complete/voice-fill/clip';
const layer = () => router.stack.find((l) => l.route && l.route.path === PATH && l.route.methods.post);
const newRes = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } });

// The final handler, as multer would hand it the parsed request.
function invoke({ body = { sheet: 'pest_reservice', duration_seconds: '12' }, file = { buffer: Buffer.from('audio-bytes'), mimetype: 'audio/webm;codecs=opus' }, actor = { techRole: 'admin', technicianId: 'admin-1' } } = {}) {
  const stack = layer().route.stack;
  const handler = stack[stack.length - 1].handle;
  const res = newRes();
  return new Promise((resolve, reject) => {
    handler({ params: { serviceId: 'visit-1' }, body, file, query: {}, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res)).catch(reject);
  });
}

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
const SAID = 'Did the perimeter outside for ants, 4 ounces of Taurus, light activity. Note for the office: gate code is 7731.';
const MODEL_ANSWER = {
  products: [{ productId: 'p-taurus', amount: 4, unit: 'oz', sameAsLast: false, method: 'perimeter_spray', heard: '4 ounces of Taurus' }],
  visit: { pests: ['Ants'], otherPest: '', areas: ['Outside'], method: 'perimeter_spray', linearFt: 0, activity: 'light', heard: 'perimeter outside for ants' },
  customerNote: 'Did the perimeter outside for ants.',
  officeNote: 'Gate code is 7731.',
  unclear: [],
};

describe('POST fast-complete/voice-fill/clip', () => {
  const savedGate = process.env.GATE_FAST_COMPLETE_VOICE_FILL;
  beforeEach(() => {
    process.env.GATE_FAST_COMPLETE_VOICE_FILL = 'true';
    mockDbCurrent = dbWithOwner('tech-1');
    resolveEligibility.mockResolvedValue({ ok: true, svc: { id: 'visit-1' }, profile: { serviceKey: 'pest_re_service', category: 'pest_control' }, eligible: true });
    loadRecapCatalogProducts.mockResolvedValue(CATALOG);
    loadCommonProducts.mockResolvedValue([]);
    callAnthropic.mockResolvedValue({ ok: true, json: MODEL_ANSWER });
    transcribeWithOpenAI.mockResolvedValue({ text: SAID });
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_FAST_COMPLETE_VOICE_FILL; else process.env.GATE_FAST_COMPLETE_VOICE_FILL = savedGate;
    delete process.env.OPENAI_VOICE_FILL_TRANSCRIBE_MODEL;
    mockDbCurrent = null;
    jest.clearAllMocks();
  });

  test('dark gate, limiter, ownership, then the body parse, then the handler', () => {
    const stack = layer().route.stack;
    expect(stack).toHaveLength(5);
    // gate off: the first layer answers 404 and nothing after it runs
    delete process.env.GATE_FAST_COMPLETE_VOICE_FILL;
    const res = newRes();
    const next = jest.fn();
    stack[0].handle({}, res, next);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(next).not.toHaveBeenCalled();
  });

  test('a technician who does not own the visit is refused before the upload is parsed', async () => {
    mockDbCurrent = dbWithOwner('someone-else');
    const res = newRes();
    const next = jest.fn();
    await layer().route.stack[2].handle({ params: { serviceId: 'visit-1' }, techRole: 'technician', technicianId: 'tech-1' }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('the clip is transcribed with the sheet\'s product names and filled like a transcript', async () => {
    const res = await invoke();
    expect(res.statusCode).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.products).toEqual([expect.objectContaining({ productId: 'p-taurus', amount: 4, unit: 'fl_oz' })]);
    expect(res.body.officeNote).toBe('Gate code is 7731.');
    expect(res.body.customerNote).not.toContain('7731');
    const [audio, opts] = transcribeWithOpenAI.mock.calls[0];
    expect(Buffer.isBuffer(audio)).toBe(true);
    expect(opts).toMatchObject({ model: 'gpt-transcribe', mimeType: 'audio/webm', filename: 'clip.webm' });
    for (const name of ['Taurus SC', 'Atticus Talak 7.9 F', 'Talstar P', 'perimeter']) expect(opts.prompt).toContain(name);
    // the response never carries the transcript
    expect(JSON.stringify(res.body)).not.toContain('Note for the office');
  });

  test('the transcription model can be switched by env', async () => {
    process.env.OPENAI_VOICE_FILL_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
    await invoke();
    expect(transcribeWithOpenAI.mock.calls[0][1].model).toBe('gpt-4o-transcribe');
  });

  test.each([
    ['no audio', { file: null }, 400],
    ['an unknown sheet', { body: { sheet: 'lawn' } }, 400],
    ['an unsupported audio type', { file: { buffer: Buffer.from('x'), mimetype: 'video/mp4' } }, 415],
  ])('%s is refused without transcribing', async (_name, over, status) => {
    const res = await invoke(over);
    expect(res.statusCode).toBe(status);
    expect(transcribeWithOpenAI).not.toHaveBeenCalled();
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  test.each([
    ['the transcriber returns nothing', () => transcribeWithOpenAI.mockResolvedValue(null)],
    ['the transcriber throws', () => transcribeWithOpenAI.mockRejectedValue(new Error('upstream'))],
    ['the transcript is implausibly long for the clip', () => transcribeWithOpenAI.mockResolvedValue({ text: 'word '.repeat(400) })],
    ['the model fails', () => callAnthropic.mockResolvedValue({ ok: false, reason: 'anthropic_529' })],
  ])('%s: 502, keep typing', async (_name, arrange) => {
    arrange();
    const res = await invoke({ body: { sheet: 'pest_reservice', duration_seconds: '3' } });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Voice fill is unavailable right now. Keep typing.' });
  });

  test('the audit line carries sizes and counts, never the words', async () => {
    await invoke({ actor: { techRole: 'technician', technicianId: 'tech-1' } });
    const everything = ['info', 'warn', 'error', 'debug'].flatMap((level) => logger[level].mock.calls.map((c) => c.join(' '))).join('\n');
    const audit = everything.split('\n').filter((l) => l.includes('[voice-fill] clip'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('service=visit-1');
    expect(audit[0]).toContain('tech=tech-1');
    expect(audit[0]).toContain('type=audio/webm');
    expect(audit[0]).toContain(`chars=${SAID.length}`);
    expect(audit[0]).toContain('products=1');
    for (const secret of ['7731', 'Taurus', 'perimeter', 'gate code', 'ants']) expect(everything).not.toContain(secret);
  });

  test('a transcript past the cap is refused, never cut: say it in shorter pieces', async () => {
    transcribeWithOpenAI.mockResolvedValue({ text: `${'Treated the garage. '.repeat(260)}Actually it was five ounces of Taurus.` });
    const res = await invoke({ body: { sheet: 'pest_reservice', duration_seconds: '900' } });
    expect(res.statusCode).toBe(413);
    expect(res.body.code).toBe('clip_too_long');
    expect(callAnthropic).not.toHaveBeenCalled();
  });
});

