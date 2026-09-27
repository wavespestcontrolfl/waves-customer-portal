/**
 * Voice relay — GATE_VOICE_RELAY_OPENAI (the OpenAI voice-relay adapter).
 *
 * Three things this file pins:
 *  1. The session allowlist (isAllowedOverrideModel / resolveSessionModel)
 *     rejects a voice-eligible OpenAI override with the gate off (unchanged
 *     production default) and accepts it with the gate on only for a sandbox
 *     or eval-harness session — an ordinary production inbound session stays
 *     Anthropic-only either way (Codex r4). Never a partial substitution.
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

const OVERRIDE_ENV_KEYS = ['VOICE_RELAY_INBOUND_MODEL', 'VOICE_RELAY_SANDBOX_MODEL', 'VOICE_RELAY_MODEL', 'GATE_VOICE_RELAY_OPENAI'];
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

  test('an OpenAI id is accepted once GATE_VOICE_RELAY_OPENAI is exactly "true" — in an eval-harness session', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    expect(isAllowedOverrideModel(OPENAI_CANDIDATE, { openaiContext: true })).toBe(true);
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    const result = resolveSessionModel({ sandbox: false, evalHarness: true });
    expect(result).toEqual({ model: OPENAI_CANDIDATE, fallbackReason: null });
  });

  // Codex r4 P2: the gate alone never moves a real caller — production
  // inbound stays on Claude (docs/sandy-benchmark.md "OpenAI candidates").
  test('an ordinary production inbound session rejects an OpenAI override even with the gate on', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    expect(isAllowedOverrideModel(OPENAI_CANDIDATE)).toBe(false); // no context = production inbound
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    const result = resolveSessionModel({ sandbox: false });
    expect(result.model).toBe(MODEL);
    expect(result.fallbackReason).toBe(`unknown_model_override:VOICE_RELAY_INBOUND_MODEL=${OPENAI_CANDIDATE}`);

    const convo = new RelayConversation({ callSid: 'CA-prod-inbound', from: '+19415551234', send: () => {} });
    expect(convo.model).toBe(MODEL);
    expect(convo._provider).toBe('anthropic');
  });

  test('a sandbox session may take an OpenAI id from the inbound override too (gate on)', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    expect(resolveSessionModel({ sandbox: true })).toEqual({ model: OPENAI_CANDIDATE, fallbackReason: null });
  });

  test('a non-voice-eligible OpenAI id is rejected even with the gate on (e.g. gpt-5.6-sol carries no `voice` entry)', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    expect(MODELS.MODEL_CATALOG['gpt-5.6-sol']).toBeTruthy();
    expect(isAllowedOverrideModel('gpt-5.6-sol', { openaiContext: true })).toBe(false);
  });

  test('resolveSessionModel/isAllowedOverrideModel apply the same way to a sandbox session', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_SANDBOX_MODEL = OPENAI_CANDIDATE;
    expect(resolveSessionModel({ sandbox: true })).toEqual({ model: OPENAI_CANDIDATE, fallbackReason: null });
  });

  // Many suites replace '../config/feature-gates' wholesale with a narrow
  // `{ isEnabled, gateEnvValue }` stub that predates this gate — a session
  // resolved under one must not throw, and must apply the same strict rule.
  test('a narrow feature-gates stub (no voiceRelayOpenaiLive export) neither throws nor loosens the gate', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => undefined }));
      const fresh = require('../services/voice-agent/relay-conversation');
      const ctx = { openaiContext: true };
      expect(fresh.isAllowedOverrideModel(OPENAI_CANDIDATE, ctx)).toBe(false);
      process.env.GATE_VOICE_RELAY_OPENAI = 'TRUE';
      expect(fresh.isAllowedOverrideModel(OPENAI_CANDIDATE, ctx)).toBe(false);
      process.env.GATE_VOICE_RELAY_OPENAI = 'true';
      expect(fresh.isAllowedOverrideModel(OPENAI_CANDIDATE, ctx)).toBe(true);
    });
    jest.dontMock('../config/feature-gates');
  });

});

// Codex r1 P1: the resolved model no longer only shapes request params — it
// now SELECTS THE PROVIDER CLIENT (providerFor). A shared VOICE_RELAY_MODEL/
// MODEL_VOICE value bypasses the override-specific allowlist entirely (it is
// read once at module load, into the `MODEL` constant — see the file
// header), so it must be validated too, never let it reach the OpenAI client
// with the gate off (or any unrecognized id at all) with no override ever
// having been rejected. VOICE_RELAY_MODEL is boot-time config (same
// convention as every other tier default in config/models.js), so each test
// sets the env and loads a FRESH module instance inside jest.isolateModules
// — scoped to the callback only, so the file's shared top-level
// `resolveSessionModel`/`RelayConversation`/`relay-tools` mock bindings
// (captured once, before any test ran, and reused via a lazy `require`
// inside relay-conversation.js's own methods) are never disturbed for any
// other describe block in this file.
describe('a shared VOICE_RELAY_MODEL/MODEL_VOICE value is validated too (Codex r1 P1)', () => {
  test('an OpenAI id fails closed to the Anthropic default when the gate is off', () => {
    process.env.VOICE_RELAY_MODEL = OPENAI_CANDIDATE;
    let result;
    let fresh;
    jest.isolateModules(() => {
      fresh = require('../services/voice-agent/relay-conversation');
      result = fresh.resolveSessionModel({ sandbox: false });
    });
    expect(result.model).toBe(MODELS.DEFAULTS.VOICE);
    expect(fresh.providerFor(result.model)).toBe('anthropic');
    expect(result.fallbackReason).toBe(`unknown_shared_model:VOICE_RELAY_MODEL=${OPENAI_CANDIDATE}`);
  });

  // Codex r3 P1: VOICE_RELAY_MODEL is shared with collections-conversation.js,
  // which only speaks Anthropic — so the gate never widens the shared fallback.
  test('an OpenAI id still fails closed with the gate on (shared with collections)', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_MODEL = OPENAI_CANDIDATE;
    let result;
    jest.isolateModules(() => {
      result = require('../services/voice-agent/relay-conversation').resolveSessionModel({ sandbox: false });
    });
    expect(result.model).toBe(MODELS.DEFAULTS.VOICE);
    expect(result.fallbackReason).toBe(`unknown_shared_model:VOICE_RELAY_MODEL=${OPENAI_CANDIDATE}`);
  });

  test('with the gate on, an eval-harness session reaches an OpenAI id through the inbound override instead', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_MODEL = OPENAI_CANDIDATE;
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    let result;
    jest.isolateModules(() => {
      result = require('../services/voice-agent/relay-conversation').resolveSessionModel({ sandbox: false, evalHarness: true });
    });
    expect(result).toEqual({ model: OPENAI_CANDIDATE, fallbackReason: null });
  });

  test('a garbage id fails closed even with the gate on', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_MODEL = 'not-a-real-model-at-all';
    let result;
    jest.isolateModules(() => {
      result = require('../services/voice-agent/relay-conversation').resolveSessionModel({ sandbox: false });
    });
    expect(result.model).toBe(MODELS.DEFAULTS.VOICE);
    expect(result.fallbackReason).toBe('unknown_shared_model:VOICE_RELAY_MODEL=not-a-real-model-at-all');
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
    const convo = new RelayConversation({ callSid: 'CA-openai-1', from: '+19415551234', evalHarness: true, send: (t) => spoken.push(t) });
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

  // Codex r5 P1: the round-1 reasoning item reaches round 2's request,
  // immediately before the call it preceded — through the relay's own history.
  test('a reasoning item before a tool call is passed back in the next round of the same turn', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    global.fetch = mockFetchSequence([
      [
        {
          type: 'response.completed',
          response: {
            id: 'r1', model: OPENAI_CANDIDATE, status: 'completed',
            output: [
              { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' },
              { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup_customer', arguments: '{"phone":"+19415551234"}', status: 'completed' },
            ],
          },
        },
      ],
      [
        {
          type: 'response.completed',
          response: { id: 'r2', model: OPENAI_CANDIDATE, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Thanks, Pat.' }] }] },
        },
      ],
    ]);

    const convo = new RelayConversation({ callSid: 'CA-openai-rs', from: '+19415551234', evalHarness: true, send: () => {} });
    await convo._runLoop('hi, this is Pat');

    expect(JSON.parse(global.fetch.mock.calls[0][1].body).include).toEqual(['reasoning.encrypted_content']);
    const input = JSON.parse(global.fetch.mock.calls[1][1].body).input;
    const at = input.findIndex((i) => i.type === 'reasoning');
    expect(input[at]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' });
    expect(input[at + 1]).toMatchObject({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup_customer' });
    expect(input[at + 2]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
  });

  test('an OpenAI HTTP failure is an ordinary model failure — no silent Claude fallback', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));

    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-openai-fail', from: '+19415551234', evalHarness: true, send: (t) => spoken.push(t) });
    await convo._runLoop('hello?');

    expect(global.fetch).toHaveBeenCalledTimes(1); // exactly one attempt — no fallback retry on another provider
    expect(convo._modelFailures).toBe(1);
    expect(relayTools.executeTool).not.toHaveBeenCalled(); // never reached a tool round
    // The generic model-error copy was spoken — never a fabricated success.
    expect(spoken.some((t) => /say that again|trouble|sorry/i.test(t))).toBe(true);
  });
});
