// The default Anthropic client in llm/call.js is built with a client-level
// timeout. Without one, the SDK refuses a non-streaming request whose
// max_tokens implies over 10 minutes before it reaches the network
// ("Streaming is required"): every Opus 5.5 events-curation call (24,000
// max_tokens) failed that way in 1 ms (2026-10-04 audit). No live API calls:
// the real SDK runs against a stub fetch.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Anthropic = jest.requireActual('@anthropic-ai/sdk');

const okBody = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const stubFetch = jest.fn(async () => new Response(JSON.stringify(okBody), { status: 200, headers: { 'content-type': 'application/json' } }));
const req = { model: 'claude-opus-5-5', max_tokens: 24000, messages: [{ role: 'user', content: 'hi' }] };

test('the SDK refuses a 24,000-token non-streaming request on a client with no timeout', async () => {
  const bare = new Anthropic({ apiKey: 'test', fetch: stubFetch, maxRetries: 0 });
  await expect(Promise.resolve().then(() => bare.messages.create(req))).rejects.toThrow(/Streaming is required/);
});

test('the same request reaches the network on a client with a client-level timeout', async () => {
  stubFetch.mockClear();
  const timed = new Anthropic({ apiKey: 'test', fetch: stubFetch, maxRetries: 0, timeout: 10 * 60 * 1000 });
  const res = await timed.messages.create(req);
  expect(res.content[0].text).toBe('ok');
  expect(stubFetch).toHaveBeenCalledTimes(1);
});

test('llm/call.js builds its default Anthropic client with a client-level timeout', async () => {
  const ctor = jest.fn().mockImplementation(() => ({ messages: { create: jest.fn().mockResolvedValue(okBody) } }));
  let callAnthropic;
  jest.isolateModules(() => {
    jest.doMock('@anthropic-ai/sdk', () => ctor);
    ({ callAnthropic } = require('../services/llm/call'));
  });
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    await callAnthropic({ model: 'claude-opus-5-5', text: 'hi', maxTokens: 24000, jsonMode: false });
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
  expect(ctor).toHaveBeenCalledWith(expect.objectContaining({ timeout: 10 * 60 * 1000 }));
});
