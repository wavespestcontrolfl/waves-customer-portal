// Cloudflare Clef adapter (llm/call.js#callWorkersAIDecision) and its
// dispatch() case. No live API calls: global fetch is mocked. The success
// fixture is the live endpoint's own reply to Cloudflare's docs example
// (captured 2026-10-02 from @cf/cloudflare/clef-flash), so the contract here
// is the provider's, not a guess.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockRecordCall = jest.fn(() => 77);
const mockRecordTrace = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, recordCall: (...a) => mockRecordCall(...a), recordTrace: (...a) => mockRecordTrace(...a), recordDispatch: jest.fn() };
});

const { callWorkersAIDecision, dispatch, WORKERS_AI_ACCOUNTS_API, workersAiDecisionModel } = require('../services/llm/call');
const MODELS = require('../config/models');
const { PROVIDER, ROUTES, TEXT_POLICIES, MODEL_CATALOG } = MODELS;
const { classifyFailure } = require('../services/agent-control/taxonomy');
const { normaliseAnswer } = require('../services/typed-decisions/jev');

const QUESTIONS = {
  urgent: { type: 'noul', instructions: 'Is this support request urgent?' },
  team: { type: 'choice', instructions: 'Which team should handle this request?', criteria: { billing: 'Payments, invoices, and refunds', technical: 'Outages, errors, and configuration', sales: 'Plans and upgrades' } },
  severity: { type: 'score', instructions: 'How severe is the customer impact?', criteria: ['No impact', 'Minor', 'Major', 'Critical'] },
};
const STATE = 'Checkout has been failing for every customer for the last hour.';
// Verbatim from the live endpoint.
const LIVE_ENVELOPE = {
  result: {
    model: 'clef-flash',
    answers: {
      urgent: { type: 'noul', noul: 0.9551 },
      team: { type: 'choice', choice: 'technical', probabilities: { billing: 0.0505, technical: 0.9355, sales: 0.014 }, confidence: 0.817 },
      severity: { type: 'score', score: 2.7182, legend: { 0: 'No impact', 1: 'Minor', 2: 'Major', 3: 'Critical' }, probabilities: { 0: 0.0151, 1: 0.0144, 2: 0.2077, 3: 0.7628 }, confidence: 0.5005 },
    },
    usage: { input_tokens: 346, output_tokens: 0 },
  },
  success: true,
  errors: [],
  messages: [],
};
const okResponse = (envelope = LIVE_ENVELOPE) => ({ ok: true, status: 200, json: async () => envelope });

describe('callWorkersAIDecision', () => {
  const originalFetch = global.fetch;
  const saved = { token: process.env.CF_WORKERS_AI_TOKEN, api: process.env.CF_API_TOKEN, account: process.env.CF_ACCOUNT_ID };
  beforeEach(() => {
    process.env.CF_WORKERS_AI_TOKEN = 'wai-token';
    delete process.env.CF_API_TOKEN;
    process.env.CF_ACCOUNT_ID = 'acct123';
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    mockRecordCall.mockClear();
    mockRecordTrace.mockClear();
  });
  afterAll(() => {
    global.fetch = originalFetch;
    for (const [key, env] of [['token', 'CF_WORKERS_AI_TOKEN'], ['api', 'CF_API_TOKEN'], ['account', 'CF_ACCOUNT_ID']]) {
      if (saved[key] === undefined) delete process.env[env]; else process.env[env] = saved[key];
    }
  });

  test('success unwraps the Workers AI envelope, returns the answers, and ledgers a cloudflare call with tokens and the served model', async () => {
    const result = await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS, laneId: 'typed_decisions_clef', promptVersion: 'call_judge.v2' });
    expect(result).toEqual({
      ok: true,
      json: LIVE_ENVELOPE.result.answers,
      text: JSON.stringify(LIVE_ENVELOPE.result.answers),
      model: 'clef-flash',
      servedModel: 'clef-flash',
      usage: { input_tokens: 346, cached_input_tokens: null, cache_write_tokens: null, output_tokens: 0, reasoning_tokens: null },
    });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(`${WORKERS_AI_ACCOUNTS_API}/acct123/ai/run/@cf/cloudflare/clef-flash`);
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer wai-token');
    // state and questions only: the model rides the URL, never the body
    expect(JSON.parse(init.body)).toEqual({ state: STATE, questions: QUESTIONS });
    expect(mockRecordCall).toHaveBeenCalledTimes(1);
    expect(mockRecordCall.mock.calls[0][0]).toMatchObject({
      provider: 'cloudflare', requestedModel: 'clef-flash', servedModel: 'clef-flash', laneId: 'typed_decisions_clef', promptVersion: 'call_judge.v2', ok: true,
      usage: { input_tokens: 346, output_tokens: 0 },
    });
    expect(mockRecordTrace).toHaveBeenCalledWith(77, expect.objectContaining({ prompt: STATE, laneId: 'typed_decisions_clef' }));
  });

  test("the live answers are Jev's shape: typed-decisions normalises all three types unchanged", () => {
    const thresholds = { confident_low: 0.15, confident_high: 0.85 };
    const { answers } = LIVE_ENVELOPE.result;
    expect(normaliseAnswer(QUESTIONS.urgent, answers.urgent, thresholds)).toEqual({ p: 0.9551, yes: true, confident: true });
    expect(normaliseAnswer(QUESTIONS.team, answers.team, thresholds)).toMatchObject({ choice: 'technical', confidence: 0.817, confident: false });
    expect(normaliseAnswer(QUESTIONS.severity, answers.severity, thresholds)).toMatchObject({ score: 2.7182, confidence: 0.5005 });
  });

  test('falls back to CF_API_TOKEN when no dedicated Workers AI token is set', async () => {
    delete process.env.CF_WORKERS_AI_TOKEN;
    process.env.CF_API_TOKEN = 'zone-token';
    await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS });
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer zone-token');
  });

  test.each([[401], [403], [422], [429], [529]])('HTTP %i -> cloudflare_%i, ledgered as a failed call', async (status) => {
    global.fetch.mockResolvedValue({ ok: false, status });
    const result = await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS });
    expect(result).toEqual({ ok: false, reason: `cloudflare_${status}` });
    expect(mockRecordCall.mock.calls[0][0]).toMatchObject({ provider: 'cloudflare', ok: false, errorCode: `cloudflare_${status}` });
  });

  test('a 200 whose envelope reports failure, or carries no answers, is a miss and never an answer', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ success: false, errors: [{ message: 'model overloaded' }], result: null }));
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS })).toEqual({ ok: false, reason: 'cloudflare_unsuccessful' });
    global.fetch.mockResolvedValueOnce(okResponse({ success: true, result: { model: 'clef-flash', answers: {}, usage: { input_tokens: 9, output_tokens: 0 } } }));
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS })).toMatchObject({ ok: false, reason: 'empty_json' });
    global.fetch.mockResolvedValueOnce(okResponse({ success: true, result: { model: 'clef-flash', answers: ['not', 'a', 'map'] } }));
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS })).toMatchObject({ ok: false, reason: 'empty_json' });
  });

  test('a missing credential or account, or a model the catalog does not register as a Cloudflare decision model, is refused before any network call and still ledgered', async () => {
    delete process.env.CF_WORKERS_AI_TOKEN;
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS })).toEqual({ ok: false, reason: 'no_key' });
    process.env.CF_WORKERS_AI_TOKEN = 'wai-token';
    delete process.env.CF_ACCOUNT_ID;
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS })).toEqual({ ok: false, reason: 'no_key' });
    process.env.CF_ACCOUNT_ID = 'acct123';
    for (const model of ['jev-1.13.0', 'gpt-6-sol', 'clef-latest', '', undefined]) {
       
      expect(await callWorkersAIDecision({ model, state: STATE, questions: QUESTIONS })).toEqual({ ok: false, reason: 'cloudflare_unknown_model' });
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockRecordCall.mock.calls.map((c) => c[0].errorCode)).toEqual(['no_key', 'no_key', ...Array(5).fill('cloudflare_unknown_model')]);
  });

  test('a timeout and a thrown fetch never throw out of the adapter', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    global.fetch.mockRejectedValueOnce(timeout);
    expect(await callWorkersAIDecision({ model: 'clef-flash', state: STATE, questions: QUESTIONS })).toEqual({ ok: false, reason: 'cloudflare_timeout' });
    global.fetch.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await callWorkersAIDecision({ model: 'clef', state: STATE, questions: QUESTIONS })).toEqual({ ok: false, reason: 'error' });
  });

  test('failure reasons classify into the existing taxonomy families', () => {
    expect(classifyFailure('cloudflare_unknown_model')).toBe('bad_input');
    expect(classifyFailure('cloudflare_422')).toBe('bad_input');
    expect(classifyFailure('cloudflare_401')).toBe('provider');
    expect(classifyFailure('cloudflare_429')).toBe('provider');
    expect(classifyFailure('cloudflare_unsuccessful')).toBe('provider');
    expect(classifyFailure('cloudflare_timeout')).toBe('timeout');
  });
});

describe('registry and dispatch', () => {
  const originalFetch = global.fetch;
  afterAll(() => { global.fetch = originalFetch; });

  test('the route, the provider and the catalog agree; both Clef ids are decision-only', () => {
    expect(PROVIDER.CLOUDFLARE).toBe('cloudflare');
    expect(ROUTES.typedDecisionClef).toEqual({ provider: 'cloudflare', model: MODELS.CLOUDFLARE_CLEF });
    expect(workersAiDecisionModel(MODELS.CLOUDFLARE_CLEF)).toBe(true);
    for (const id of ['clef-flash', 'clef']) expect(MODEL_CATALOG[id]).toMatchObject({ provider: 'cloudflare', caps: ['decision'] });
  });

  test('the integrations entry accepts either token and its health line names both (Codex r1 on #5557)', () => {
    const { ADMIN_INTEGRATIONS } = require('../config/integration-registry');
    const entry = ADMIN_INTEGRATIONS.find((i) => i.id === 'cloudflare_workers_ai');
    expect(entry.env).toMatchObject({ required: ['CF_ACCOUNT_ID'], oneOfRequired: ['CF_WORKERS_AI_TOKEN', 'CF_API_TOKEN'] });
    expect(entry.health).toMatchObject({ type: 'token-health', key: 'cloudflare_workers_ai', primaryEnvKey: 'CF_WORKERS_AI_TOKEN or CF_API_TOKEN' });
    expect(entry.gates).toEqual([{ key: 'typedDecisionsClef', label: 'Typed decisions (Clef)' }]);
  });

  test('no TEXT_POLICIES leg may carry the decision-only provider', () => {
    for (const [name, policy] of Object.entries(TEXT_POLICIES)) {
      for (const leg of [policy.primary, policy.fallback].filter(Boolean)) {
        expect([name, leg.provider]).not.toEqual([name, 'cloudflare']);
      }
    }
  });

  test('dispatch routes the cloudflare provider to the adapter, and refuses a payload without questions before any network call', async () => {
    process.env.CF_WORKERS_AI_TOKEN = 'wai-token';
    process.env.CF_ACCOUNT_ID = 'acct123';
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    const ok = await dispatch(ROUTES.typedDecisionClef, { state: STATE, questions: QUESTIONS, laneId: 'typed_decisions_clef' });
    expect(ok).toMatchObject({ ok: true, servedModel: 'clef-flash' });
    global.fetch.mockClear();
    expect(await dispatch(ROUTES.typedDecisionClef, { state: STATE })).toEqual({ ok: false, reason: 'cloudflare_requires_questions' });
    expect(global.fetch).not.toHaveBeenCalled();
    delete process.env.CF_WORKERS_AI_TOKEN;
    delete process.env.CF_ACCOUNT_ID;
  });
});
