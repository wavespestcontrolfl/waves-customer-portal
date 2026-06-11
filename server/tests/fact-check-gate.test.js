// Locks the fact-check gate's contract: it blocks on P0/P1 factual findings,
// passes clean content, treats P2 as advisory (non-blocking), and FAILS OPEN
// on every unavailable/error/garbage path (a model hiccup must never stall the
// publish pipeline).

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});
const AnthropicMock = require('@anthropic-ai/sdk');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ORIGINAL_ENV = { ...process.env };

function load() {
  let mod;
  jest.isolateModules(() => { mod = require('../services/content/fact-check-gate'); });
  return mod;
}

function reply(findings) {
  mockCreate.mockResolvedValue({ content: [{ text: JSON.stringify({ findings }) }] });
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

  test('bounds the client: no retries + a finite timeout (fail-open fast on a stall)', async () => {
    reply([]);
    await load().evaluate(DRAFT);
    expect(AnthropicMock).toHaveBeenCalledWith(expect.objectContaining({
      maxRetries: 0,
      timeout: expect.any(Number),
    }));
    const opts = AnthropicMock.mock.calls.at(-1)[0];
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.timeout).toBeLessThanOrEqual(60000);
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
    mockCreate.mockRejectedValue(new Error('429 overloaded'));
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.checked).toBe(false);
    expect(r.skipped).toBe('api_error');
  });

  test('fails OPEN on unparseable model output', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'not json at all' }] });
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('parse_error');
  });

  test('skips (pass) when GATE_FACTCHECK=false', async () => {
    process.env.GATE_FACTCHECK = 'false';
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('disabled');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('skips (pass) when no API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('no_api');
  });

  test('skips an empty/too-short body without calling the model', async () => {
    const r = await load().evaluate({ ...DRAFT, body: 'tiny' });
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('empty_body');
    expect(mockCreate).not.toHaveBeenCalled();
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
