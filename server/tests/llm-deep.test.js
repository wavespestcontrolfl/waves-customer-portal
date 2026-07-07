/**
 * Contract tests for services/llm/deep.js — the DEEP-tier (fable-5) wrapper.
 *
 * fable-5 emits thinking blocks ahead of the text block (always-on thinking)
 * and can refuse benign-adjacent content via safety classifiers. Every DEEP
 * call site relies on this helper to hide both, so the contract is:
 *   - thinking blocks never reach the caller (content[0].text stays valid)
 *   - a refusal retries once on FLAGSHIP with the identical request
 *   - both calls share ONE deadline: when the client has a configured
 *     timeout, the retry only gets the time remaining on it (and is skipped
 *     entirely near the deadline) — a refusal can never hold a caller like
 *     the fact-check publish lock for ~2× its timeout
 *   - API errors throw exactly like client.messages.create
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ DEEP: 'deep-model', FLAGSHIP: 'flagship-model' }));

const { createDeepMessage, stripThinkingBlocks } = require('../services/llm/deep');

function clientReturning(...responses) {
  const create = jest.fn();
  responses.forEach((r) => create.mockResolvedValueOnce(r));
  return { messages: { create } };
}

describe('createDeepMessage', () => {
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

  test('a refusal retries once on FLAGSHIP with the identical request', async () => {
    const client = clientReturning(
      { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'fallback answer' }] },
    );
    const params = { max_tokens: 4096, system: 'sys', messages: [{ role: 'user', content: 'q' }] };
    const resp = await createDeepMessage(client, params);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(client.messages.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'deep-model', system: 'sys' }));
    expect(client.messages.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'flagship-model', system: 'sys', max_tokens: 4096 }));
    expect(resp.content[0].text).toBe('fallback answer');
  });

  test('a refusal on both models returns the second response without further retries', async () => {
    const client = clientReturning(
      { stop_reason: 'refusal', content: [] },
      { stop_reason: 'refusal', content: [] },
    );
    const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(resp.stop_reason).toBe('refusal');
  });

  describe('refusal fallback shares the client timeout budget', () => {
    afterEach(() => jest.restoreAllMocks());

    test('retry gets only the time remaining on the client timeout', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(10000);
      const client = clientReturning(
        { stop_reason: 'refusal', content: [] },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'fallback answer' }] },
      );
      client.timeout = 60000;
      const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
      expect(client.messages.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ model: 'flagship-model' }),
        { timeout: 50000 },
      );
      expect(resp.content[0].text).toBe('fallback answer');
    });

    test('near the deadline the fallback is skipped and the refusal is returned', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(58000);
      const client = clientReturning({ stop_reason: 'refusal', content: [] });
      client.timeout = 60000;
      const resp = await createDeepMessage(client, { max_tokens: 100, messages: [] });
      expect(client.messages.create).toHaveBeenCalledTimes(1);
      expect(resp.stop_reason).toBe('refusal');
    });

    test('a client with no configured timeout retries without a per-request override', async () => {
      const client = clientReturning(
        { stop_reason: 'refusal', content: [] },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
      );
      await createDeepMessage(client, { max_tokens: 100, messages: [] });
      expect(client.messages.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'flagship-model' }));
    });
  });

  test('API errors throw exactly like client.messages.create (callers keep their catch paths)', async () => {
    const create = jest.fn().mockRejectedValueOnce(new Error('api 529'));
    await expect(createDeepMessage({ messages: { create } }, { max_tokens: 100, messages: [] }))
      .rejects.toThrow('api 529');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('stripThinkingBlocks', () => {
  test('tolerates missing/non-array content', () => {
    expect(stripThinkingBlocks(null)).toBeNull();
    expect(stripThinkingBlocks({ content: 'nope' })).toEqual({ content: 'nope' });
  });
});
