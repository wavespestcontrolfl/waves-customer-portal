// TypeSafe Jev adapter (llm/call.js#callTypeSafe) and its dispatch() case.
// No live API calls: global fetch is mocked.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockRecordCall = jest.fn(() => 42);
const mockRecordTrace = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, recordCall: (...a) => mockRecordCall(...a), recordTrace: (...a) => mockRecordTrace(...a), recordDispatch: jest.fn() };
});

const { callTypeSafe, dispatch, TYPESAFE_SYSTEMONE_API } = require('../services/llm/call');
const MODELS = require('../config/models');
const { PROVIDER, ROUTES, TEXT_POLICIES, MODEL_CATALOG } = MODELS;
const { classifyFailure } = require('../services/agent-control/taxonomy');
const { extractUsage } = jest.requireActual('../services/llm-dispatch-metrics');

const QUESTIONS = { is_lead: { type: 'noul', instructions: 'Is the caller a new prospect?' } };
const STATE = { call_direction: 'inbound', duration_seconds: 61, transcript: 'synthetic transcript' };
const ANSWERS = { is_lead: { type: 'noul', noul: 0.93 } };
const okResponse = (over = {}) => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: ANSWERS, usage: { input_tokens: 120, output_tokens: 7 }, ...over }) });

describe('callTypeSafe', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.TYPESAFE_API_KEY;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    mockRecordCall.mockClear();
    mockRecordTrace.mockClear();
  });
  afterAll(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
  });

  test('success returns the answers, records servedModel, and ledgers a typesafe call with tokens', async () => {
    const result = await callTypeSafe({ model: 'jev-1.13.0', state: STATE, questions: QUESTIONS, laneId: 'typed_decisions', promptVersion: 'call_judge.v2' });
    expect(result).toEqual({
      ok: true,
      json: ANSWERS,
      text: JSON.stringify(ANSWERS),
      model: 'jev-1.13.0',
      servedModel: 'jev-1.13.0',
      usage: { input_tokens: 120, cached_input_tokens: null, cache_write_tokens: null, output_tokens: 7, reasoning_tokens: null },
    });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(TYPESAFE_SYSTEMONE_API);
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({ model: 'jev-1.13.0', state: STATE, questions: QUESTIONS });
    expect(mockRecordCall).toHaveBeenCalledTimes(1);
    expect(mockRecordCall.mock.calls[0][0]).toMatchObject({
      provider: 'typesafe',
      requestedModel: 'jev-1.13.0',
      servedModel: 'jev-1.13.0',
      laneId: 'typed_decisions',
      promptVersion: 'call_judge.v2',
      ok: true,
      usage: { input_tokens: 120, output_tokens: 7 },
    });
    // an opted-in trace sees the state as the prompt text
    expect(mockRecordTrace).toHaveBeenCalledWith(42, expect.objectContaining({ prompt: JSON.stringify(STATE), response: JSON.stringify(ANSWERS), laneId: 'typed_decisions' }));
  });

  test.each([[401], [422], [429], [529]])('HTTP %i -> typesafe_%i, ledgered as a failed call', async (status) => {
    global.fetch.mockResolvedValue({ ok: false, status });
    const result = await callTypeSafe({ model: 'jev-1.13.0', state: STATE, questions: QUESTIONS });
    expect(result).toEqual({ ok: false, reason: `typesafe_${status}` });
    expect(mockRecordCall.mock.calls[0][0]).toMatchObject({ provider: 'typesafe', ok: false, errorCode: `typesafe_${status}` });
  });

  test('timeout -> typesafe_timeout', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    global.fetch.mockRejectedValue(err);
    expect(await callTypeSafe({ model: 'jev-1.13.0', state: STATE, questions: QUESTIONS, timeoutMs: 5 })).toEqual({ ok: false, reason: 'typesafe_timeout' });
  });

  test('a network failure -> error, never thrown', async () => {
    global.fetch.mockRejectedValue(new Error('socket hang up'));
    expect(await callTypeSafe({ model: 'jev-1.13.0', state: STATE, questions: QUESTIONS })).toEqual({ ok: false, reason: 'error' });
  });

  test('missing key -> no_key without a network call', async () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(await callTypeSafe({ model: 'jev-1.13.0', state: STATE, questions: QUESTIONS })).toMatchObject({ ok: false, reason: 'no_key' });
    expect(mockRecordCall).toHaveBeenCalledWith(expect.objectContaining({ provider: 'typesafe', ok: false, errorCode: 'no_key' }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([['jev-latest'], ['jev-1.13'], ['jev-1.13.0-beta'], ['claude-sonnet-5'], [undefined]])('unpinned model %p -> typesafe_unpinned_model without a network call', async (model) => {
    expect(await callTypeSafe({ model, state: STATE, questions: QUESTIONS })).toMatchObject({ ok: false, reason: 'typesafe_unpinned_model' });
    expect(global.fetch).not.toHaveBeenCalled();
    // Codex #5476 r3: the dark lane's refusals still file a failed ledger row.
    expect(mockRecordCall).toHaveBeenCalledWith(expect.objectContaining({ provider: 'typesafe', ok: false, errorCode: 'typesafe_unpinned_model' }));
  });

  test.each([[{ answers: {} }], [{ answers: undefined }], [{ answers: [] }], [{ answers: 'nope' }]])('no answers (%j) -> empty_json, billed usage kept', async (over) => {
    global.fetch.mockResolvedValue(okResponse(over));
    expect(await callTypeSafe({ model: 'jev-1.13.0', state: STATE, questions: QUESTIONS })).toEqual({
      ok: false,
      reason: 'empty_json',
      usage: { input_tokens: 120, cached_input_tokens: null, cache_write_tokens: null, output_tokens: 7, reasoning_tokens: null },
    });
    expect(mockRecordCall.mock.calls[0][0]).toMatchObject({ provider: 'typesafe', ok: false, errorCode: 'empty_json' });
  });

  test('omits servedModel when the provider reports none', async () => {
    global.fetch.mockResolvedValue(okResponse({ model: undefined }));
    const result = await callTypeSafe({ model: 'jev-1.13.0', state: STATE, questions: QUESTIONS });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('servedModel');
  });
});

describe('dispatch -> typesafe', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { process.env.TYPESAFE_API_KEY = 'test-key'; global.fetch = jest.fn().mockResolvedValue(okResponse()); });
  afterAll(() => { global.fetch = originalFetch; delete process.env.TYPESAFE_API_KEY; });

  test('ROUTES.typedDecision is the pinned Jev model on the typesafe provider', () => {
    expect(ROUTES.typedDecision).toEqual({ provider: PROVIDER.TYPESAFE, model: MODELS.TYPESAFE_JEV });
    expect(MODELS.TYPESAFE_JEV).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(MODEL_CATALOG[MODELS.DEFAULTS.TYPESAFE_JEV]).toEqual({ label: 'TypeSafe Jev 1.13', provider: 'typesafe', caps: ['decision'], status: 'current' });
    expect(Object.isFrozen(ROUTES.typedDecision)).toBe(true);
  });

  test('routes a questions payload to the Jev adapter', async () => {
    const result = await dispatch(ROUTES.typedDecision, { state: STATE, questions: QUESTIONS });
    expect(result.ok).toBe(true);
    expect(result.json).toEqual(ANSWERS);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe(MODELS.TYPESAFE_JEV);
  });

  test('a payload without questions is refused before any network call', async () => {
    for (const payload of [{ state: STATE }, { state: STATE, questions: 'x' }, { state: STATE, questions: null }]) {
      expect(await dispatch(ROUTES.typedDecision, payload)).toEqual({ ok: false, reason: 'typesafe_requires_questions' });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an alias route is refused through dispatch too', async () => {
    expect(await dispatch({ provider: PROVIDER.TYPESAFE, model: 'jev-latest' }, { state: STATE, questions: QUESTIONS })).toEqual({ ok: false, reason: 'typesafe_unpinned_model' });
  });

  test('no TEXT_POLICIES leg uses the typesafe provider (typed decisions are single-leg ROUTES only)', () => {
    for (const [name, policy] of Object.entries(TEXT_POLICIES)) {
      expect({ name, provider: policy.primary.provider }).not.toEqual({ name, provider: PROVIDER.TYPESAFE });
      expect({ name, provider: policy.fallback.provider }).not.toEqual({ name, provider: PROVIDER.TYPESAFE });
    }
  });
});

describe('ledger vocabulary for typesafe', () => {
  test('extractUsage reads the {input_tokens, output_tokens} block', () => {
    expect(extractUsage('typesafe', { usage: { input_tokens: 9, output_tokens: 2 } })).toMatchObject({ input_tokens: 9, output_tokens: 2 });
    expect(extractUsage('typesafe', {})).toMatchObject({ input_tokens: null, output_tokens: null });
  });
  test('failure codes classify: rate limits and auth are provider, validation and unpinned are bad_input, timeout is timeout', () => {
    expect(classifyFailure('typesafe_429')).toBe('provider');
    expect(classifyFailure('typesafe_529')).toBe('provider');
    expect(classifyFailure('typesafe_401')).toBe('provider');
    expect(classifyFailure('typesafe_422')).toBe('bad_input');
    expect(classifyFailure('typesafe_unpinned_model')).toBe('bad_input');
    expect(classifyFailure('typesafe_timeout')).toBe('timeout');
    expect(classifyFailure('empty_json')).toBe('incomplete');
  });
});
