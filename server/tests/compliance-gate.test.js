// Locks the semantic compliance gate's contract: it blocks on P0 violations of
// the two hard codes, treats P1/P2 as advisory, drops codes the model invented,
// and FAILS OPEN on every unavailable/error/garbage path (the regex layer in
// content-guardrails is the fail-closed primary; this is defense in depth, so a
// model hiccup must never stall the publish pipeline).

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: (...args) => mockDispatch(...args),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const MODELS = require('../config/models');

const ORIGINAL_ENV = { ...process.env };

function load() {
  let mod;
  jest.isolateModules(() => { mod = require('../services/content/compliance-gate'); });
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

const DRAFT = {
  title: 'Mosquito Control in Venice',
  body: 'x'.repeat(200),
  city: 'Venice',
  keyword: 'mosquito control',
  tag: 'Mosquito',
};

describe('semantic compliance gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The gate ships DARK (opt-in), so every behavioural test must arm it
    // explicitly; the default-off case is asserted separately below.
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'sk-test', GATE_COMPLIANCE: 'true' };
    delete process.env.MODEL_COMPLIANCE;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  test('passes compliant content (no findings)', async () => {
    reply([]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.checked).toBe(true);
    expect(r.findings).toEqual([]);
  });

  test('crosses providers and bounds both legs with a finite timeout', async () => {
    reply([]);
    await load().evaluate(DRAFT);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: expect.objectContaining({ provider: 'anthropic' }),
        fallback: expect.objectContaining({ provider: 'openai' }),
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number), jsonMode: true }),
      expect.objectContaining({ validate: expect.any(Function) }),
    );
    const payload = mockDispatch.mock.calls.at(-1)[1];
    expect(payload.timeoutMs).toBeGreaterThan(0);
    expect(payload.timeoutMs).toBeLessThanOrEqual(60000);
  });

  test('BLOCKS on a P0 REENTRY_SAFETY_CLAIM', async () => {
    reply([{
      severity: 'P0',
      code: 'REENTRY_SAFETY_CLAIM',
      claim: 'The treatment is safe for pets and works after it dries.',
      issue: '"after it dries" governs "works"; the safety claim is unconditional',
      fix: 'The treatment is safe once dry.',
    }]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(false);
    expect(r.findings[0].code).toBe('REENTRY_SAFETY_CLAIM');
    expect(r.findings[0].message).toMatch(/unconditional/);
  });

  test('BLOCKS on a P0 BANNED_TOPIC', async () => {
    reply([{
      severity: 'P0',
      code: 'BANNED_TOPIC',
      claim: 'We handle raccoon removal across Sarasota.',
      issue: 'wildlife removal presented as our service',
      fix: 'refer to a licensed trapper',
    }]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(false);
    expect(r.findings[0].code).toBe('BANNED_TOPIC');
  });

  test('P1 is ADVISORY — a judgment call does NOT block', async () => {
    reply([{ severity: 'P1', code: 'REENTRY_SAFETY_CLAIM', claim: 'gentle formula', issue: 'borderline', fix: 'reword' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.findings[0].severity).toBe('P1');
  });

  test('P2 is advisory — does NOT block', async () => {
    reply([{ severity: 'P2', code: 'BANNED_TOPIC', claim: 'fumigation explained', issue: 'informational', fix: 'none' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.findings).toHaveLength(1);
  });

  test('emits the EXISTING codes so retry directives and reviewer notes resolve', async () => {
    reply([
      { severity: 'P0', code: 'REENTRY_SAFETY_CLAIM', claim: 'a', issue: 'b', fix: 'c' },
      { severity: 'P1', code: 'BANNED_TOPIC', claim: 'd', issue: 'e', fix: 'f' },
    ]);
    const { GATE_RETRY_INSTRUCTIONS } = require('../services/content/gate-retry-directives');
    const r = await load().evaluate(DRAFT);
    for (const f of r.findings) {
      expect(GATE_RETRY_INSTRUCTIONS[f.code]).toEqual(expect.any(String));
    }
  });

  // Malformed / mis-coded output must REJECT the route so the second provider
  // gets a turn — never be read as "no findings", which would return
  // checked:true/pass:true and publish while reporting a check happened.
  describe('response validation (runs inside the dispatcher)', () => {
    const v = () => load()._internals.validateResponse;

    test('accepts a well-formed response', () => {
      expect(v()({ json: { findings: [{ severity: 'P0', code: 'BANNED_TOPIC' }] } })).toBeNull();
      expect(v()({ json: { findings: [] } })).toBeNull();
    });

    test('rejects a missing or non-object json', () => {
      expect(v()({})).toBe('no_json');
      expect(v()({ json: 'nope' })).toBe('no_json');
    });

    test('rejects findings that are not an array — the silent-empty-list trap', () => {
      expect(v()({ json: { findings: 'none' } })).toBe('findings_not_array');
      expect(v()({ json: {} })).toBe('findings_not_array');
    });

    test('rejects a finding that is not an object', () => {
      expect(v()({ json: { findings: ['just a string'] } })).toBe('finding_not_object');
    });

    test('rejects an invented code instead of dropping the finding', () => {
      expect(v()({ json: { findings: [{ severity: 'P0', code: 'MADE_UP' }] } })).toBe('unknown_code:MADE_UP');
      expect(v()({ json: { findings: [{ severity: 'P0' }] } })).toBe('unknown_code:missing');
    });
  });

  test('hands the validator to dispatchWithFallback so a bad route fails over', async () => {
    reply([]);
    await load().evaluate(DRAFT);
    const opts = mockDispatch.mock.calls.at(-1)[2];
    expect(typeof opts.validate).toBe('function');
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

  test('is OFF by default — ships dark until calibrated', async () => {
    delete process.env.GATE_COMPLIANCE;
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('disabled');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('stays OFF for any value other than the explicit "true"', async () => {
    for (const v of ['false', '1', 'yes', 'TRUE', '']) {
      jest.clearAllMocks();
      process.env.GATE_COMPLIANCE = v;
      const r = await load().evaluate(DRAFT);
      expect(r.skipped).toBe('disabled');
      expect(mockDispatch).not.toHaveBeenCalled();
    }
  });

  test('GATE_COMPLIANCE=false is the revoke once enabled', async () => {
    process.env.GATE_COMPLIANCE = 'false';
    const r = await load().evaluate(DRAFT);
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('disabled');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('skips an empty/too-short body without calling the model', async () => {
    const r = await load().evaluate({ ...DRAFT, body: 'tiny' });
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('empty_body');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('CHECKS a short metadata-only payload — the floor is 12, not 50', async () => {
    // The metadata-rewrite lane has no body: its whole payload is a title plus
    // a meta description. A short violating title is a real P0, and a 50-char
    // floor would have skipped it silently (Codex PR #3295 r2).
    reply([{ severity: 'P0', code: 'REENTRY_SAFETY_CLAIM', claim: 'Pet-safe lawn care', issue: 'pet-safe compound', fix: 'reword' }]);
    const r = await load().evaluate({ ...DRAFT, body: 'Pet-safe lawn care' });
    expect(r.checked).toBe(true);
    expect(r.pass).toBe(false);
    expect(mockDispatch).toHaveBeenCalled();
  });

  test('coerces an unknown severity to P2 (non-blocking)', async () => {
    reply([{ severity: 'banana', code: 'BANNED_TOPIC', claim: 'x', issue: 'y' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.findings[0].severity).toBe('P2');
    expect(r.pass).toBe(true);
  });

  test('normalizes a lowercase/padded severity rather than demoting it to P2', async () => {
    reply([{ severity: ' p0 ', code: 'REENTRY_SAFETY_CLAIM', claim: 'x', issue: 'y' }]);
    const r = await load().evaluate(DRAFT);
    expect(r.findings[0].severity).toBe('P0');
    expect(r.pass).toBe(false);
  });

  test('MODEL_COMPLIANCE swaps only the Anthropic leg and keeps the cross-provider fallback', async () => {
    process.env.MODEL_COMPLIANCE = 'some-pinned-model';
    reply([]);
    await load().evaluate(DRAFT);
    const policy = mockDispatch.mock.calls.at(-1)[0];
    expect(policy.primary).toEqual({ provider: 'anthropic', model: 'some-pinned-model' });
    expect(policy.fallback.provider).toBe('openai');
  });

  test('the prompt carries the rule text from gate-retry-directives (no second source of truth)', () => {
    const { GATE_RETRY_INSTRUCTIONS } = require('../services/content/gate-retry-directives');
    const { SYSTEM_PROMPT } = load()._internals;
    expect(SYSTEM_PROMPT).toContain(GATE_RETRY_INSTRUCTIONS.REENTRY_SAFETY_CLAIM);
    expect(SYSTEM_PROMPT).toContain(GATE_RETRY_INSTRUCTIONS.BANNED_TOPIC);
  });

  test('the prompt states the governs-the-safety-predicate rule the regex could not express', () => {
    const { SYSTEM_PROMPT } = load()._internals;
    // The r23 case is the reason this gate exists — keep it pinned in the
    // prompt so a future prompt edit cannot quietly drop it.
    expect(SYSTEM_PROMPT).toMatch(/works after it dries/i);
    expect(SYSTEM_PROMPT).toMatch(/GOVERNS THE SAFETY PREDICATE/i);
  });

  test('the prompt qualifies the negation exemption so negated FIGURES still block', () => {
    const { SYSTEM_PROMPT } = load()._internals;
    // "Do not re-enter until 30 minutes have passed" is negated AND carries a
    // prohibited fixed figure; content-guardrails blocks it, so an unqualified
    // "negated copy is compliant" instruction would tell the model to pass a
    // known P0 (Codex PR #3295 r1).
    expect(SYSTEM_PROMPT).toMatch(/PROHIBITED IN EVERY POLARITY/i);
    expect(SYSTEM_PROMPT).toMatch(/Do not re-enter until 30 minutes have passed/i);
    // And the exemption must still be scoped to claims, not withdrawn entirely.
    expect(SYSTEM_PROMPT).toMatch(/we do not offer wildlife trapping/i);
  });
});
