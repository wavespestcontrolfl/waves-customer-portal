// Locks the fact-check gate's contract: it blocks on P0/P1 factual findings,
// passes clean content, treats P2 as advisory (non-blocking), and FAILS OPEN
// on every unavailable/error/garbage path (a model hiccup must never stall the
// publish pipeline).

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: (...args) => mockDispatch(...args),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const MODELS = require('../config/models');

const ORIGINAL_ENV = { ...process.env };

function load() {
  let mod;
  jest.isolateModules(() => { mod = require('../services/content/fact-check-gate'); });
  return mod;
}

function reply(findings) {
  mockDispatch.mockResolvedValue({
    ok: true,
    json: { findings },
    provider: 'anthropic',
    model: MODELS.DEEP,
    fallbackUsed: false,
  });
}

const DRAFT = { title: 'Dollar Spot in Venice', body: 'x'.repeat(200), city: 'Venice', keyword: 'dollar spot', tag: 'Lawn Disease' };

describe('fact-check gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'sk-test', GATE_FACTCHECK: undefined };
    delete process.env.GATE_FACTCHECK;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  test('passes clean content (no findings)', async () => {
    reply([]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.checked).toBe(true);
    expect(r.findings).toEqual([]);
  });

  test('bounds both providers with a finite timeout (fail-open fast on a stall)', async () => {
    reply([]);
    await load().evaluate(DRAFT);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: expect.objectContaining({ provider: 'anthropic' }),
        fallback: expect.objectContaining({ provider: 'openai' }),
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number), jsonMode: true }),
    );
    const payload = mockDispatch.mock.calls.at(-1)[1];
    expect(payload.timeoutMs).toBeGreaterThan(0);
    expect(payload.timeoutMs).toBeLessThanOrEqual(60000);
  });

  test('BLOCKS on a P0 (objective error: reversed pathogen)', async () => {
    reply([{ severity: 'P0', claim: 'C. jacksonii on warm-season turf', issue: 'reversed; warm-season FL turf is C. monteithiana', fix: 'use C. monteithiana' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(false);
    expect(r.findings[0].severity).toBe('P0');
    expect(r.findings[0].code).toBe('FACTUAL_ERROR');
    expect(r.findings[0].message).toMatch(/monteithiana/);
  });

  test('P1 is ADVISORY now — a debatable judgment does NOT block', async () => {
    reply([{ severity: 'P1', claim: 'dollar spot on St. Augustine', issue: 'uncommon host; debatable prevalence', fix: 'note bermuda/zoysia' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.findings[0].severity).toBe('P1');
  });

  test('P2 is advisory — does NOT block', async () => {
    reply([{ severity: 'P2', claim: 'humidity above 75%', issue: 'imprecise', fix: 'cite a range' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(1);
  });

  test('fails OPEN when the API throws', async () => {
    mockDispatch.mockRejectedValue(new Error('both providers unavailable'));
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.checked).toBe(false);
    expect(r.skipped).toBe('api_error');
  });

  test('fails OPEN when neither provider returns valid JSON', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('api_error');
  });

  test('skips (pass) when GATE_FACTCHECK=false', async () => {
    process.env.GATE_FACTCHECK = 'false';
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('disabled');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('still checks when one provider key is absent so the other can serve the request', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    reply([]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.checked).toBe(true);
    expect(mockDispatch).toHaveBeenCalled();
  });

  test('skips an empty/too-short body without calling the model', async () => {
    const r = await load().evaluate({ ...DRAFT, body: 'tiny' });
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('empty_body');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('coerces an unknown severity to P2 (non-blocking)', async () => {
    reply([{ severity: 'banana', claim: 'x', issue: 'y' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.findings[0].severity).toBe('P2');
    expect(r.pass).toBe(true);
  });

  test('normalizes casing/whitespace so "p0" / "P0 " still BLOCK', async () => {
    for (const variant of ['p0', 'P0 ', ' p0']) {
      reply([{ severity: variant, claim: 'x', issue: 'y' }]);
      const r = await load().evaluate(DRAFT);
      expect(r.findings[0].severity).toBe('P0');
      expect(r.pass).toBe(false);
    }
  });

  test('normalized "p1" is advisory (does NOT block)', async () => {
    reply([{ severity: 'p1 ', claim: 'x', issue: 'y' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.findings[0].severity).toBe('P1');
    expect(r.pass).toBe(true);
  });
});
