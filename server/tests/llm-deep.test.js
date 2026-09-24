/**
 * Contract tests for services/llm/deep.js — Opus primary, OpenAI backup.
 *
 * fable-5 emits thinking blocks ahead of the text block (always-on thinking)
 * and can refuse benign-adjacent content via safety classifiers. Every DEEP
 * call site relies on this helper to hide both, so the contract is:
 *   - thinking blocks never reach the caller (content[0].text stays valid)
 *   - a refusal or API error crosses providers to OpenAI
 *   - both calls share ONE deadline: when the client has a configured
 *     timeout, the retry only gets the time remaining on it (and is skipped
 *     entirely near the deadline) — a refusal can never hold a caller like
 *     the fact-check publish lock for ~2× its timeout
 *   - API errors throw when the OpenAI backup also misses
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({
  DEEP: 'deep-model',
  TEXT_POLICIES: {
    deepAnalysis: {
      name: 'deepAnalysis',
      primary: { provider: 'anthropic', model: 'deep-model' },
      fallback: { provider: 'openai', model: 'openai-backup' },
    },
  },
}));
const mockCallOpenAI = jest.fn();
const mockDispatchWithFallback = jest.fn();
jest.mock('../services/llm/call', () => ({
  callOpenAI: (...args) => mockCallOpenAI(...args),
  dispatchWithFallback: (...args) => mockDispatchWithFallback(...args),
}));

const { createDeepMessage, stripThinkingBlocks } = require('../services/llm/deep');

function clientReturning(...responses) {
  const create = jest.fn();
  responses.forEach((r) => create.mockResolvedValueOnce(r));
  return { messages: { create } };
}

describe('createDeepMessage', () => {
  beforeEach(() => {
    mockCallOpenAI.mockReset();
    mockDispatchWithFallback.mockReset();
  });
  test('defaults model to DEEP and passes params through', async () => {
    const client = clientReturning({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
    await createDeepMessage(client, { max_tokens: 4096, messages: [{ role: 'user', content: 'q' }] });
    expect(client.messages.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deep-model',
      max_tokens: 4096,
    }));
  });

  test('respects an explicit params.model (per-feature env overrides)', async () => {
    const client = clientReturning({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
    await createDeepMessage(client, { model: 'custom-model', max_tokens: 100, messages: [] });
    expect(client.messages.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'custom-model' }));
  });

  test('uses the registered DEEP policy for schema-constrained calls', async () => {
    const normalized = {
      ok: true,
      json: { verdict: 'pass' },
      model: 'deep-model',
      provider: 'anthropic',
      fallbackUsed: false,
      failures: [],
    };
    mockDispatchWithFallback.mockResolvedValue(normalized);
    const schema = { type: 'object', required: ['verdict'] };
    const result = await createDeepMessage(null, {
      laneId: 'editorial_review',
      max_tokens: 1200,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'review this' }],
      temperature: 0,
    }, {
      jsonSchema: schema,
      timeoutMs: 45000,
      promptVersion: 'editorial-v1',
    });

    expect(mockDispatchWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({ primary: expect.objectContaining({ model: 'deep-model' }) }),
      {
        anthropicClient: null,
        laneId: 'editorial_review',
        system: 'system prompt',
        text: 'user: review this',
        jsonMode: true,
        jsonSchema: schema,
        maxTokens: 1200,
        timeoutMs: 45000,
        promptVersion: 'editorial-v1',
        temperature: 0,
      },
      { validate: undefined },
    );
    expect(result).toBe(normalized);
  });

  test('uses a params model override only for the structured primary route', async () => {
    mockDispatchWithFallback.mockResolvedValue({ ok: true, json: {} });
    await createDeepMessage(null, { model: 'custom-model', messages: [] }, { jsonSchema: {} });

    const policy = mockDispatchWithFallback.mock.calls[0][0];
    expect(policy.primary).toEqual(expect.objectContaining({ provider: 'anthropic', model: 'custom-model' }));
    expect(policy.fallback).toEqual({ provider: 'openai', model: 'openai-backup' });
  });

  test('adapts semantic JSON validation so a rejected primary can fall back', async () => {
    const validate = jest.fn((json) => (json.accepted ? null : 'semantic_mismatch'));
    mockDispatchWithFallback.mockImplementation(async (policy, payload, options) => {
      const primary = { ok: true, json: { accepted: false }, model: policy.primary.model };
      const rejection = options.validate(primary, policy.primary);
      expect(rejection).toBe('semantic_mismatch');
      return {
        ok: true,
        json: { accepted: true },
        model: policy.fallback.model,
        provider: policy.fallback.provider,
        fallbackUsed: true,
        failures: [{ provider: policy.primary.provider, reason: rejection, validator: true }],
      };
    });

    const result = await createDeepMessage(null, { messages: [] }, { jsonSchema: {}, validate });

    expect(validate).toHaveBeenCalledWith(
      { accepted: false },
      expect.objectContaining({ ok: true, json: { accepted: false } }),
    );
    expect(result).toMatchObject({
      ok: true,
      json: { accepted: true },
      fallbackUsed: true,
      failures: [expect.objectContaining({ reason: 'semantic_mismatch', validator: true })],
    });
  });

  test('returns a structured all-provider failure unchanged', async () => {
    const failure = {
      ok: false,
      reason: 'all_providers_failed',
      failures: [
        { provider: 'anthropic', reason: 'semantic_mismatch', validator: true },
        { provider: 'openai', reason: 'openai_503' },
      ],
    };
    mockDispatchWithFallback.mockResolvedValue(failure);

    const result = await createDeepMessage(null, { messages: [] }, { jsonSchema: {} });

    expect(result).toBe(failure);
  });

  test('structured calls inherit the client deadline unless options override it', async () => {
    mockDispatchWithFallback.mockResolvedValue({ ok: true, json: {} });
    const client = { timeout: 60000 };

    await createDeepMessage(client, { messages: [] }, { jsonSchema: {} });
    await createDeepMessage(client, { messages: [] }, { jsonSchema: {}, timeoutMs: 30000 });

    expect(mockDispatchWithFallback.mock.calls[0][1].timeoutMs).toBe(60000);
    expect(mockDispatchWithFallback.mock.calls[1][1].timeoutMs).toBe(30000);
  });

  test('strips thinking blocks so content[0] is the text block again', async () => {
    const client = clientReturning({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'redacted_thinking', data: 'x' },
        { type: 'text', text: '{"ok":true}' },
      ],
    });
    const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
    expect(resp.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    expect(resp.content[0].text).toBe('{"ok":true}');
  });

  test('keeps typeless blocks (test fixtures) and non-thinking block types', async () => {
    const client = clientReturning({ content: [{ text: 'fixture-style' }, { type: 'tool_use', id: 't1' }] });
    const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
    expect(resp.content).toHaveLength(2);
  });

  test('a refusal crosses providers to OpenAI with the same prompt', async () => {
    const client = clientReturning({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
    mockCallOpenAI.mockResolvedValue({ ok: true, model: 'openai-backup', text: 'fallback answer' });
    const params = { max_tokens: 4096, system: 'sys', messages: [{ role: 'user', content: 'q' }] };
    const resp = await createDeepMessage(client, params);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(mockCallOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai-backup', system: 'sys', text: 'user: q', maxTokens: 4096,
    }));
    expect(resp.content[0].text).toBe('fallback answer');
  });

  test('a refusal on both providers returns the original refusal', async () => {
    const client = clientReturning({ stop_reason: 'refusal', content: [] });
    mockCallOpenAI.mockResolvedValue({ ok: false, reason: 'openai_503' });
    const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(resp.stop_reason).toBe('refusal');
  });

  describe('refusal fallback shares the client timeout budget', () => {
    afterEach(() => jest.restoreAllMocks());

    test('OpenAI backup gets only the time remaining on the client timeout', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(10000);
      const client = clientReturning({ stop_reason: 'refusal', content: [] });
      client.timeout = 60000;
      mockCallOpenAI.mockResolvedValue({ ok: true, model: 'openai-backup', text: 'fallback answer' });
      const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
      expect(mockCallOpenAI).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 50000 }));
      expect(resp.content[0].text).toBe('fallback answer');
    });

    test('near the deadline the fallback is skipped and the refusal is returned', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(58000);
      const client = clientReturning({ stop_reason: 'refusal', content: [] });
      client.timeout = 60000;
      const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
      expect(client.messages.create).toHaveBeenCalledTimes(1);
      expect(mockCallOpenAI).not.toHaveBeenCalled();
      expect(resp.stop_reason).toBe('refusal');
    });

    test('a client with no configured timeout uses no OpenAI timeout override', async () => {
      const client = clientReturning({ stop_reason: 'refusal', content: [] });
      mockCallOpenAI.mockResolvedValue({ ok: true, model: 'openai-backup', text: 'ok' });
      await createDeepMessage(client, { max_tokens: 100, messages: [] });
      expect(mockCallOpenAI.mock.calls[0][0].timeoutMs).toBeUndefined();
    });
  });

  // The error path must share the client's timeout budget exactly like the
  // refusal path — otherwise an Anthropic request that THROWS after burning
  // its budget passes a non-positive remaining number, which maps to
  // undefined and lets callOpenAI apply its 10-minute default (holding
  // 60s-budget callers like the quarantine arbiter ~10 extra minutes).
  describe('error fallback shares the client timeout budget', () => {
    afterEach(() => jest.restoreAllMocks());

    test('OpenAI backup gets only the time remaining on the client timeout', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(10000);
      const create = jest.fn().mockRejectedValueOnce(new Error('api 529'));
      const client = { messages: { create }, timeout: 60000 };
      mockCallOpenAI.mockResolvedValue({ ok: true, model: 'openai-backup', text: 'ok' });
      const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
      expect(mockCallOpenAI).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 50000 }));
      expect(resp.content[0].text).toBe('ok');
    });

    test('near the deadline the backup is skipped and the error rethrows', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(58000);
      const create = jest.fn().mockRejectedValueOnce(new Error('api 529'));
      const client = { messages: { create }, timeout: 60000 };
      await expect(createDeepMessage(client, { max_tokens: 100, messages: [] })).rejects.toThrow('api 529');
      expect(mockCallOpenAI).not.toHaveBeenCalled();
    });

    test('an exhausted budget (negative remaining) never becomes the 10-minute default', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(70000);
      const create = jest.fn().mockRejectedValueOnce(new Error('Request timed out'));
      const client = { messages: { create }, timeout: 60000 };
      await expect(createDeepMessage(client, { max_tokens: 100, messages: [] })).rejects.toThrow('Request timed out');
      expect(mockCallOpenAI).not.toHaveBeenCalled();
    });
  });

  test('API errors fall back to OpenAI', async () => {
    const create = jest.fn().mockRejectedValueOnce(new Error('api 529'));
    mockCallOpenAI.mockResolvedValue({ ok: true, model: 'openai-backup', text: 'ok' });
    const response = await createDeepMessage({ messages: { create } }, { max_tokens: 100, messages: [] });
    expect(response.content[0].text).toBe('ok');
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('API errors throw when the OpenAI backup also misses', async () => {
    const create = jest.fn().mockRejectedValueOnce(new Error('api 529'));
    mockCallOpenAI.mockResolvedValue({ ok: false, reason: 'openai_503' });
    await expect(createDeepMessage({ messages: { create } }, { max_tokens: 100, messages: [] }))
      .rejects.toThrow('api 529');
  });
});

describe('stripThinkingBlocks', () => {
  test('tolerates missing/non-array content', () => {
    expect(stripThinkingBlocks(null)).toBeNull();
    expect(stripThinkingBlocks({ content: 'nope' })).toEqual({ content: 'nope' });
  });
});
