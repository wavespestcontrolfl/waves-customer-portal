/**
 * voice-relay-replay.js's installHarness() — OpenAI adapter instrumentation.
 *
 * The harness patches a provider client's Messages-like `.stream()`
 * prototype method so model telemetry (modelCalls/modelRounds/modelErrors/
 * modelAborts) and fixtures.modelFailures fault injection work identically
 * whichever provider a session's pinned model resolves to
 * (GATE_VOICE_RELAY_OPENAI can put a benchmark candidate on
 * relay-openai-client.js instead of the Anthropic SDK — see
 * relay-conversation.js). This file exercises that patch directly against
 * the REAL relay-openai-client.js module (no live API calls — every
 * `.stream()` here is invoked by hand, never through a real fetch), the same
 * level voice-relay-eval.test.js's harness suite exercises the Anthropic SDK
 * double at.
 *
 * Same minimal mock set voice-relay-eval.test.js uses so installHarness()
 * (which loads the full relay-conversation.js module graph) can succeed with
 * no live DB/network — never a new evaluation harness.
 */

jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async ({ sendEmail }) => sendEmail()) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 1) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('db called'); });
  fn.raw = jest.fn(() => { throw new Error('db.raw called'); });
  fn.transaction = jest.fn(() => { throw new Error('db.transaction called'); });
  fn.destroy = jest.fn();
  fn.fn = { now: () => 'now()' };
  return fn;
});
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(async () => { throw new Error('capture floor called'); }),
  stampCustomerPreferredLanguage: jest.fn(async () => false),
}));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-profile-distiller', () => ({ MAX_PROFILE_CHARS: 4000, getApprovedVoiceProfile: jest.fn(async () => null) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || 'none') }));

beforeEach(() => { jest.resetModules(); });

/** events (plain objects) -> one SSE-formatted string (data: JSON\n\n per event). */
function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** A fetchImpl stub returning one SSE payload built from `events`. */
function fetchStub(events) {
  return async () => ({ ok: true, status: 200, body: (async function* gen() { yield sse(events); }()) });
}

describe('installHarness — OpenAI relay client instrumentation', () => {
  test('patches relay-openai-client.js\'s Messages prototype (openaiFaultInjection: true)', () => {
    const replay = require('../services/eval/voice-relay-replay');
    const h = replay.installHarness();
    expect(h.openaiFaultInjection).toBe(true);
    expect(h.modelFaultInjection).toBe(true); // the Anthropic patch is unaffected by adding the OpenAI one
  });

  test.each([
    ['cached', { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 5 },
      { input_tokens: 30, output_tokens: 5, cached_input_tokens: 20, cacheReadRounds: 1 }],
    ['uncached', { input_tokens: 50, output_tokens: 5 },
      { input_tokens: 50, output_tokens: 5, cached_input_tokens: 0, cacheReadRounds: 0 }],
    ['measured zero', { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 },
      { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cacheReadRounds: 0 }],
  ])('a real OpenAI %s round built AFTER installHarness() retains complete measured usage', async (_label, providerUsage, measured) => {
    const replay = require('../services/eval/voice-relay-replay');
    const h = replay.installHarness();
    const { OpenAIRelayClient } = require('../services/voice-agent/relay-openai-client');
    // A real (mocked-fetch) round — proves the harness's wrapper composes
    // with relay-openai-client's OWN finalMessage, not a stand-in that
    // bypasses it.
    const client = new OpenAIRelayClient({
      apiKey: 'x',
      fetchImpl: fetchStub([
        { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: providerUsage } },
      ]),
    });

    const record = {
      modelCalls: 0, modelRounds: 0, modelErrors: [], modelAborts: 0, injected: [], interruptInFlight: false,
      usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, rounds: 0, cacheReadRounds: 0, incompleteRounds: 0 },
    };
    h.state.record = record;
    h.state.modelFailuresLeft = 0;

    const stream = client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {});
    expect(record.modelCalls).toBe(1); // counted the instant .stream() was called
    const msg = await stream.finalMessage();
    expect(msg.content[0].text).toBe('hi');
    expect(record.modelRounds).toBe(1);
    expect(record.modelErrors).toEqual([]);
    expect(record.usage).toEqual({
      ...measured, cache_write_tokens: 0, rounds: 1, incompleteRounds: 0,
    });
  });

  test('a completed OpenAI round with a malformed usage object is marked incomplete, not free', async () => {
    const replay = require('../services/eval/voice-relay-replay');
    const h = replay.installHarness();
    const { OpenAIRelayClient } = require('../services/voice-agent/relay-openai-client');
    const client = new OpenAIRelayClient({
      apiKey: 'x',
      fetchImpl: fetchStub([
        { type: 'response.completed', response: { id: 'r-bad-usage', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: {} } },
      ]),
    });
    const record = {
      modelCalls: 0, modelRounds: 0, modelErrors: [], modelAborts: 0, injected: [], interruptInFlight: false,
      usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, rounds: 0, cacheReadRounds: 0, incompleteRounds: 0 },
    };
    h.state.record = record;
    h.state.modelFailuresLeft = 0;

    const msg = await client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage();

    expect(msg.usage).toEqual({
      input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens: null,
    });
    expect(record.modelRounds).toBe(1);
    expect(record.usage).toEqual({
      input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0,
      rounds: 0, cacheReadRounds: 0, incompleteRounds: 1,
    });
  });

  test('fixtures.modelFailures fault injection works on the OpenAI client exactly like the Anthropic one', () => {
    const replay = require('../services/eval/voice-relay-replay');
    const h = replay.installHarness();
    const { OpenAIRelayClient } = require('../services/voice-agent/relay-openai-client');
    const client = new OpenAIRelayClient({ apiKey: 'x' });

    const record = { modelCalls: 0, modelRounds: 0, modelErrors: [], modelAborts: 0, injected: [], interruptInFlight: false };
    h.state.record = record;
    h.state.modelFailuresLeft = 1;

    expect(() => client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {})).toThrow(/injected model failure/);
    expect(record.modelCalls).toBe(1);
    expect(record.injected).toEqual(['model_failure']);
    expect(h.state.modelFailuresLeft).toBe(0); // consumed — the next call runs for real
  });

  test('a real provider error (finalMessage rejects) is recorded in modelErrors, not modelAborts', async () => {
    const replay = require('../services/eval/voice-relay-replay');
    const h = replay.installHarness();
    const { OpenAIRelayClient } = require('../services/voice-agent/relay-openai-client');
    const client = new OpenAIRelayClient({ apiKey: 'x', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'server error' }) });
    const record = { modelCalls: 0, modelRounds: 0, modelErrors: [], modelAborts: 0, injected: [], interruptInFlight: false };
    h.state.record = record;
    h.state.modelFailuresLeft = 0;

    await expect(client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {}).finalMessage()).rejects.toThrow(/HTTP 500/);
    expect(record.modelErrors).toEqual(['OpenAI Responses API HTTP 500']); // status only — never the body (Codex r4 P1)
    expect(record.modelAborts).toBe(0);
    expect(record.modelRounds).toBe(0);
  });

  test('an AbortError while a barge-in is in flight counts as modelAborts, not modelErrors', async () => {
    const replay = require('../services/eval/voice-relay-replay');
    const h = replay.installHarness();
    const { OpenAIRelayClient } = require('../services/voice-agent/relay-openai-client');
    const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        reject(err);
      });
    });
    const client = new OpenAIRelayClient({ apiKey: 'x', fetchImpl });
    const record = { modelCalls: 0, modelRounds: 0, modelErrors: [], modelAborts: 0, injected: [], interruptInFlight: true };
    h.state.record = record;
    h.state.modelFailuresLeft = 0;

    const controller = new AbortController();
    const promise = client.messages.stream({ model: 'gpt-6-sol', messages: [] }, { signal: controller.signal }).finalMessage();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(record.modelAborts).toBe(1);
    expect(record.modelErrors).toEqual([]);
  });

  test('a throw from the real stream() method (request construction) is a modelError, never reaching finalMessage', () => {
    // Patch the REAL module's prototype to throw synchronously BEFORE
    // installHarness runs, so the harness's own patch wraps this throwing
    // version as its `realStream` — proving the try/catch around
    // `realStream.apply(...)` in patchStreamProto, not just the
    // finalMessage-rejection path the earlier tests cover.
    const { OpenAIRelayMessages } = require('../services/voice-agent/relay-openai-client');
    OpenAIRelayMessages.prototype.stream = () => { throw new Error('400 invalid request'); };

    const replay = require('../services/eval/voice-relay-replay');
    const h = replay.installHarness();
    const { OpenAIRelayClient } = require('../services/voice-agent/relay-openai-client');
    const client = new OpenAIRelayClient({ apiKey: 'x' });
    const record = { modelCalls: 0, modelRounds: 0, modelErrors: [], modelAborts: 0, injected: [], interruptInFlight: false };
    h.state.record = record;
    h.state.modelFailuresLeft = 0;

    expect(() => client.messages.stream({ model: 'gpt-6-sol', messages: [] }, {})).toThrow('400 invalid request');
    expect(record.modelCalls).toBe(1);
    expect(record.modelErrors).toEqual(['400 invalid request']);
  });
});

// Codex r4 P2: OpenAI candidates resolve only in a sandbox or eval-harness
// session, so the replay must mark its conversations as the harness — or
// every benchmark candidate condition would silently run on Claude.
describe('runScenario — the replay is an eval-harness session', () => {
  const KEYS = ['GATE_VOICE_RELAY_OPENAI', 'VOICE_RELAY_INBOUND_MODEL'];
  let saved;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('a gated OpenAI inbound candidate is the model the scenario record pins', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = 'gpt-6-sol';
    const replay = require('../services/eval/voice-relay-replay');
    const record = await replay.runScenario({ id: 'harness-context', caller: {}, turns: [], checks: [] });
    expect(record.model).toBe('gpt-6-sol');
    expect(record.modelFallbackReason).toBeNull();
  });
});
