/**
 * Voice relay — GATE_VOICE_RELAY_OPENAI (the OpenAI voice-relay adapter).
 *
 * Three things this file pins:
 *  1. The session allowlist (isAllowedOverrideModel / resolveSessionModel)
 *     rejects a voice-eligible OpenAI override with the gate off (unchanged
 *     production default) and accepts it with the gate on — never a partial
 *     substitution.
 *  2. A full turn loop — a tool-call round then a text round — completes end
 *     to end on `relay-openai-client.js` with a MOCKED `global.fetch` SSE
 *     stream (no live API call). `client.fetchImpl` defaults to a bare
 *     `fetch(...)` call resolved at INVOCATION time, so overriding
 *     `global.fetch` after this module already loaded (and built its
 *     module-level `openaiClient` singleton) still reaches it.
 *  3. No silent Claude fallback: an OpenAI leg that errors surfaces as an
 *     ordinary model failure (the same copy/telemetry an Anthropic outage
 *     produces) — it never substitutes a real or mocked Anthropic call.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-agent/relay-tools', () => {
  const actual = jest.requireActual('../services/voice-agent/relay-tools');
  return { ...actual, executeTool: jest.fn(async () => 'Found: Pat Sample.') };
});

const MODELS = require('../config/models');
const relayTools = require('../services/voice-agent/relay-tools');
const {
  RelayConversation, resolveSessionModel, isAllowedOverrideModel, providerFor, MODEL,
} = require('../services/voice-agent/relay-conversation');

const OVERRIDE_ENV_KEYS = ['VOICE_RELAY_INBOUND_MODEL', 'VOICE_RELAY_SANDBOX_MODEL', 'GATE_VOICE_RELAY_OPENAI'];
let SAVED_ENV;
let SAVED_FETCH;

beforeEach(() => {
  jest.clearAllMocks();
  SAVED_ENV = {};
  for (const k of OVERRIDE_ENV_KEYS) { SAVED_ENV[k] = process.env[k]; delete process.env[k]; }
  SAVED_FETCH = global.fetch;
});

afterEach(() => {
  for (const k of OVERRIDE_ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k];
  }
  global.fetch = SAVED_FETCH;
});

const OPENAI_CANDIDATE = 'gpt-6-sol';

describe('gate — production default unchanged, opt-in only', () => {
  test('provider defaults to anthropic for the shared MODEL default', () => {
    expect(providerFor(MODEL)).toBe('anthropic');
  });

  test('an OpenAI id is rejected with the gate unset (production default)', () => {
    expect(isAllowedOverrideModel(OPENAI_CANDIDATE)).toBe(false);
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    const result = resolveSessionModel({ sandbox: false });
    expect(result.model).toBe(MODEL); // falls back — never silently substituted
    expect(result.fallbackReason).toBe(`unknown_model_override:VOICE_RELAY_INBOUND_MODEL=${OPENAI_CANDIDATE}`);
  });

  test('an OpenAI id is rejected with the gate set to anything other than exactly "true"', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'TRUE';
    expect(isAllowedOverrideModel(OPENAI_CANDIDATE)).toBe(false);
    process.env.GATE_VOICE_RELAY_OPENAI = '1';
    expect(isAllowedOverrideModel(OPENAI_CANDIDATE)).toBe(false);
  });

  test('an OpenAI id is accepted once GATE_VOICE_RELAY_OPENAI is exactly "true"', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    expect(isAllowedOverrideModel(OPENAI_CANDIDATE)).toBe(true);
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    const result = resolveSessionModel({ sandbox: false });
    expect(result).toEqual({ model: OPENAI_CANDIDATE, fallbackReason: null });
  });

  test('a non-voice-eligible OpenAI id is rejected even with the gate on (e.g. gpt-5.6-sol carries no `voice` entry)', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    expect(MODELS.MODEL_CATALOG['gpt-5.6-sol']).toBeTruthy();
    expect(isAllowedOverrideModel('gpt-5.6-sol')).toBe(false);
  });

  test('resolveSessionModel/isAllowedOverrideModel apply the same way to a sandbox session', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_SANDBOX_MODEL = OPENAI_CANDIDATE;
    expect(resolveSessionModel({ sandbox: true })).toEqual({ model: OPENAI_CANDIDATE, fallbackReason: null });
  });
});

/** events (plain objects) -> one SSE-formatted string. */
function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

function mockFetchSequence(responses) {
  let call = 0;
  return jest.fn(async () => {
    const events = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: true, status: 200, body: (async function* gen() { yield sse(events); }()) };
  });
}

describe('a full turn loop on the OpenAI adapter — tool-call round then text round', () => {
  test('completes end to end with a mocked fetch SSE stream, no Anthropic call', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;

    global.fetch = mockFetchSequence([
      // Round 1 — a tool call.
      [
        { type: 'response.output_item.added', item: { type: 'function_call' } },
        {
          type: 'response.completed',
          response: {
            id: 'r1', model: OPENAI_CANDIDATE, status: 'completed',
            output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup_customer', arguments: '{"phone":"+19415551234"}' }],
            usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 50 }, output_tokens: 20 },
          },
        },
      ],
      // Round 2 — the model's reply after seeing the tool result.
      [
        { type: 'response.output_item.added', item: { type: 'message' } },
        { type: 'response.output_text.delta', delta: 'Thanks, Pat — how can I help today?' },
        {
          type: 'response.completed',
          response: {
            id: 'r2', model: OPENAI_CANDIDATE, status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Thanks, Pat — how can I help today?' }] }],
            usage: { input_tokens: 260, input_tokens_details: { cached_tokens: 200 }, output_tokens: 12 },
          },
        },
      ],
    ]);

    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-openai-1', from: '+19415551234', send: (t) => spoken.push(t) });
    expect(convo.model).toBe(OPENAI_CANDIDATE);
    expect(convo._provider).toBe('openai');

    await convo._runLoop('hi there, this is Pat calling about ants');

    // Two model rounds, both against the OpenAI adapter — never the Anthropic SDK.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');

    // The tool actually ran (mocked relay-tools.executeTool), and its result
    // reached the model as a function_call_output in round 2's request body.
    expect(relayTools.executeTool).toHaveBeenCalledWith('lookup_customer', { phone: '+19415551234' }, expect.anything());
    const round2Body = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(round2Body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1' && item.output === 'Found: Pat Sample.')).toBe(true);

    // The final reply was actually spoken (block renderer — default).
    expect(spoken).toContain('Thanks, Pat — how can I help today?');

    // History carries the round's tool_use/tool_result pairing and the final
    // text — the same Anthropic-shaped blocks a Claude session would leave,
    // so downstream readers (transcript, next round) need no provider case.
    const assistantToolMsg = convo.messages.find((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
    expect(assistantToolMsg.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'lookup_customer', input: { phone: '+19415551234' } }]);
    const toolResultMsg = convo.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
    expect(toolResultMsg.content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: 'Found: Pat Sample.' }]);

    // Version stamps say what actually ran.
    const stamps = convo._versionStamps();
    expect(stamps.model).toBe(OPENAI_CANDIDATE);
    expect(stamps.provider).toBe('openai');
    expect(stamps.effort).toBeNull(); // voiceEffortFor never sends output_config to a non-Anthropic model
  });

  test('an OpenAI HTTP failure is an ordinary model failure — no silent Claude fallback', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));

    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-openai-fail', from: '+19415551234', send: (t) => spoken.push(t) });
    await convo._runLoop('hello?');

    expect(global.fetch).toHaveBeenCalledTimes(1); // exactly one attempt — no fallback retry on another provider
    expect(convo._modelFailures).toBe(1);
    expect(relayTools.executeTool).not.toHaveBeenCalled(); // never reached a tool round
    // The generic model-error copy was spoken — never a fabricated success.
    expect(spoken.some((t) => /say that again|trouble|sorry/i.test(t))).toBe(true);
  });
});
