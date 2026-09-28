/**
 * Voice relay — GATE_VOICE_RELAY_OPENAI (the OpenAI voice-relay adapter).
 *
 * Four things this file pins:
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
 *  3. GATE_VOICE_RELAY_OPENAI_INBOUND (owner ruling 2026-09-28, GPT-6 Luna):
 *     a SEPARATE, dark-by-default gate that lets an ordinary production
 *     inbound session (never sandbox, never eval-harness) resolve
 *     VOICE_RELAY_INBOUND_MODEL to a voice-eligible OpenAI id.
 *     GATE_VOICE_RELAY_OPENAI being live in prod for the sandbox/eval lane
 *     never opens this on its own.
 *  4. The mid-call OpenAI provider-failure fallback: production inbound AND
 *     sandbox sessions (never eval-harness) switch to Claude and retry a
 *     round once on a provider-reason failure, unless the round already
 *     spoke — see the dedicated describe block near the bottom of this file.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-agent/relay-tools', () => {
  const actual = jest.requireActual('../services/voice-agent/relay-tools');
  return { ...actual, executeTool: jest.fn(async () => 'Found: Pat Sample.') };
});

// Stream-capturing Anthropic mock — inert for every test that never
// switches provider (this file's Anthropic client is otherwise untouched).
// Needed for the provider-failure fallback describe block near the bottom,
// where a switched-to-Claude retry actually calls client.messages.stream.
const mockAnthropicStreamCalls = [];
const mockAnthropicScriptedMessages = [];
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({
  messages: {
    stream: jest.fn((params) => {
      mockAnthropicStreamCalls.push(params);
      return { finalMessage: async () => mockAnthropicScriptedMessages.shift() };
    }),
  },
})));

const MODELS = require('../config/models');
const logger = require('../services/logger');
const relayTools = require('../services/voice-agent/relay-tools');
const {
  RelayConversation, resolveSessionModel, isAllowedOverrideModel, providerFor, MODEL,
} = require('../services/voice-agent/relay-conversation');

const OVERRIDE_ENV_KEYS = ['VOICE_RELAY_INBOUND_MODEL', 'VOICE_RELAY_SANDBOX_MODEL', 'VOICE_RELAY_MODEL', 'GATE_VOICE_RELAY_OPENAI', 'GATE_VOICE_RELAY_OPENAI_INBOUND', 'VOICE_RELAY_RENDERER'];
let SAVED_ENV;
let SAVED_FETCH;

beforeEach(() => {
  jest.clearAllMocks();
  mockAnthropicStreamCalls.length = 0;
  mockAnthropicScriptedMessages.length = 0;
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
// Owner-chosen production inbound candidate (2026-09-28) — text-only, no
// vision leg, distinct catalog entry from OPENAI_CANDIDATE above.
const LUNA = 'gpt-6-luna';

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

  // Codex r13 P2: the gate is feature-gates' canonical voiceRelayOpenaiLive()
  // alone — a stubbed value governs, never the ambient env (no second reader).
  test('the gate is read only through feature-gates voiceRelayOpenaiLive — a stub governs, not the env', () => {
    const ctx = { openaiContext: true };
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => undefined, voiceRelayOpenaiLive: () => false }));
      process.env.GATE_VOICE_RELAY_OPENAI = 'true';
      expect(require('../services/voice-agent/relay-conversation').isAllowedOverrideModel(OPENAI_CANDIDATE, ctx)).toBe(false);
    });
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => undefined, voiceRelayOpenaiLive: () => true }));
      delete process.env.GATE_VOICE_RELAY_OPENAI;
      expect(require('../services/voice-agent/relay-conversation').isAllowedOverrideModel(OPENAI_CANDIDATE, ctx)).toBe(true);
    });
    jest.dontMock('../config/feature-gates');
  });

  test('a no-context isAllowedOverrideModel call never reads any gate (a stub missing both still resolves)', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => undefined }));
      const fresh = require('../services/voice-agent/relay-conversation');
      // No opts = neither context flag — this specific call must never touch
      // feature-gates at all, gate module shape notwithstanding.
      expect(fresh.isAllowedOverrideModel(OPENAI_CANDIDATE)).toBe(false);
    });
    jest.dontMock('../config/feature-gates');
  });

  // GATE_VOICE_RELAY_OPENAI_INBOUND read at construction — same convention as
  // GATE_VOICE_RELAY_OPENAI's stub-governs test above, for the new gate.
  test('a production inbound session reads ONLY GATE_VOICE_RELAY_OPENAI_INBOUND, never GATE_VOICE_RELAY_OPENAI', () => {
    jest.isolateModules(() => {
      // The stub deliberately omits voiceRelayOpenaiLive (the sandbox/eval
      // gate) — a production inbound resolution with an OpenAI candidate
      // must never reach it, only voiceRelayOpenaiInboundLive.
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => undefined, voiceRelayOpenaiInboundLive: () => false }));
      const fresh = require('../services/voice-agent/relay-conversation');
      process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
      expect(fresh.resolveSessionModel({ sandbox: false }).model).toBe(MODELS.DEFAULTS.VOICE);
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

  // Codex r8 P2: the shared chain is VOICE_RELAY_MODEL, then MODEL_VOICE —
  // each validated — and only then the code default, matching the Models tab.
  test('a rejected VOICE_RELAY_MODEL falls to a valid MODEL_VOICE, not straight to the code default', () => {
    const saved = process.env.MODEL_VOICE;
    process.env.VOICE_RELAY_MODEL = OPENAI_CANDIDATE;
    process.env.MODEL_VOICE = 'claude-haiku-4-5-20251001';
    try {
      let result;
      jest.isolateModules(() => {
        result = require('../services/voice-agent/relay-conversation').resolveSessionModel({ sandbox: false });
      });
      expect(result).toEqual({ model: 'claude-haiku-4-5-20251001', fallbackReason: `unknown_shared_model:VOICE_RELAY_MODEL=${OPENAI_CANDIDATE}` });
    } finally {
      if (saved === undefined) delete process.env.MODEL_VOICE; else process.env.MODEL_VOICE = saved;
    }
  });

  test('a MODEL_VOICE the relay refuses falls to the code default, stamped with its own env name', () => {
    const saved = process.env.MODEL_VOICE;
    process.env.MODEL_VOICE = OPENAI_CANDIDATE;
    try {
      let result;
      jest.isolateModules(() => {
        result = require('../services/voice-agent/relay-conversation').resolveSessionModel({ sandbox: false });
      });
      expect(result).toEqual({ model: MODELS.DEFAULTS.VOICE, fallbackReason: `unknown_shared_model:MODEL_VOICE=${OPENAI_CANDIDATE}` });
    } finally {
      if (saved === undefined) delete process.env.MODEL_VOICE; else process.env.MODEL_VOICE = saved;
    }
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
    // Codex r9 P2: the stamp records the reasoning effort the OpenAI request
    // actually carried (MODEL_CATALOG voice.reasoning), never output_config.
    expect(stamps.effort).toBe('low');
    expect(convo._effort).toBeNull(); // voiceEffortFor never sends output_config to a non-Anthropic model
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).reasoning).toEqual({ effort: 'low' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).not.toHaveProperty('output_config');
  });

  test('each turn stamps the reasoning effort its OpenAI requests carried', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    global.fetch = mockFetchSequence([[
      { type: 'response.completed', response: { id: 'r1', model: OPENAI_CANDIDATE, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi, how can I help?' }] }] } },
    ]]);
    const convo = new RelayConversation({ callSid: 'CA-openai-effort', from: '+19415551234', evalHarness: true, send: () => {} });
    await convo.handlePrompt('hello');
    expect(convo._turnStats).toHaveLength(1);
    expect(convo._turnStats[0].effort).toBe('low');
  });

  test('an Anthropic session still stamps its output_config effort', () => {
    const convo = new RelayConversation({ callSid: 'CA-anthropic-effort', from: '+19415551234', send: () => {} });
    expect(convo._provider).toBe('anthropic');
    expect(convo._versionStamps().effort).toBe(convo._effort);
  });

  // Codex r5/r6 P1: the round-1 reasoning item reaches round 2's request in
  // its original order — through the relay's own history.
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
              { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Let me pull that up.' }] },
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
    // The round's original order survives the relay's history: reasoning,
    // the spoken preamble (with its item id), then the call.
    const at = input.findIndex((i) => i.type === 'reasoning');
    expect(input[at]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' });
    expect(input[at + 1]).toEqual({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Let me pull that up.', annotations: [] }] });
    expect(input[at + 2]).toMatchObject({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup_customer' });
    expect(input[at + 3]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
  });

  // Codex r6 P1: on a write-tool turn the relay withholds the preamble text
  // (never spoken ahead of the write's result). The replay keeps the round's
  // order with that message EMPTY — reasoning still paired, and the model is
  // never told the caller heard it.
  test('a write-tool round replays its withheld preamble as an empty, still-paired message', async () => {
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
              { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: "You're all set!" }] },
              { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'capture_lead', arguments: '{"name":"Pat Sample"}', status: 'completed' },
            ],
          },
        },
      ],
      [
        {
          type: 'response.completed',
          response: { id: 'r2', model: OPENAI_CANDIDATE, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Got it — someone will call you back.' }] }] },
        },
      ],
    ]);

    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-openai-write', from: '+19415551234', evalHarness: true, send: (t) => spoken.push(t) });
    await convo._runLoop('please have someone call me back');

    expect(spoken.join(' ')).not.toMatch(/all set/); // the relay withheld it
    const input = JSON.parse(global.fetch.mock.calls[1][1].body).input;
    const at = input.findIndex((i) => i.type === 'reasoning');
    expect(input.slice(at, at + 3)).toEqual([
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'capture_lead', arguments: '{"name":"Pat Sample"}' },
    ]);
    expect(JSON.stringify(input)).not.toMatch(/all set/);
  });

  // Codex r12 P1: a barge-in during a reasoning tool round stores the round's
  // tool results with no model round after them (_abortStreamToolLoop). The
  // caller's next turn must still carry that round's reasoning, paired.
  test('after a barge-in cuts a reasoning tool round, the next caller turn still sends its reasoning', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    const savedRenderer = process.env.VOICE_RELAY_RENDERER;
    process.env.VOICE_RELAY_RENDERER = 'stream';
    try {
      global.fetch = mockFetchSequence([
        [
          { type: 'response.output_item.added', item: { type: 'message' } },
          { type: 'response.output_text.delta', delta: 'Let me check.' },
          {
            type: 'response.completed',
            response: {
              id: 'r1', model: OPENAI_CANDIDATE, status: 'completed',
              output: [
                { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' },
                { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Let me check.' }] },
                { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup_customer', arguments: '{"phone":"+19415551234"}', status: 'completed' },
              ],
            },
          },
        ],
        [
          { type: 'response.completed', response: { id: 'r2', model: OPENAI_CANDIDATE, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'No problem.' }] }] } },
        ],
      ]);
      const convo = new RelayConversation({ callSid: 'CA-openai-barge', from: '+19415551234', evalHarness: true, send: () => {} });
      expect(convo.renderer).toBe('stream');
      // Barge in right after the round finalizes, before its tool loop runs
      // (the same injection voice-relay-stream-renderer.test.js uses).
      const original = convo._finalizeStreamedRound.bind(convo);
      convo._finalizeStreamedRound = async (...args) => {
        const result = await original(...args);
        convo.interrupt({ utteranceUntilInterrupt: 'Let me check.' });
        return result;
      };
      await convo._runLoop('hi, this is Pat');
      expect(global.fetch).toHaveBeenCalledTimes(1); // no post-tool model round after the barge-in
      convo._finalizeStreamedRound = original;

      await convo._runLoop('actually, never mind');
      const input = JSON.parse(global.fetch.mock.calls[1][1].body).input;
      const at = input.findIndex((i) => i.type === 'reasoning');
      expect(at).toBeGreaterThan(-1);
      expect(input[at]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' });
      expect(input[at + 1]).toMatchObject({ type: 'message', id: 'msg_1' });
      expect(input[at + 2]).toMatchObject({ type: 'function_call', id: 'fc_1', call_id: 'call_1' });
      expect(input[at + 3]).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: expect.stringMatching(/^Not run/) });
      expect(input[input.length - 1]).toMatchObject({ role: 'user' });
      expect(JSON.stringify(input[input.length - 1])).toMatch(/never mind/);
    } finally {
      if (savedRenderer === undefined) delete process.env.VOICE_RELAY_RENDERER; else process.env.VOICE_RELAY_RENDERER = savedRenderer;
    }
  });

  // evalHarness:true — the benchmark must measure the pure model, so this is
  // the ONE session kind that keeps the old no-fallback behavior even after
  // the provider-failure fallback below exists for every other session kind.
  test('an OpenAI HTTP failure on an EVAL-HARNESS session is an ordinary model failure — no silent Claude fallback', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = OPENAI_CANDIDATE;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));

    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-openai-fail', from: '+19415551234', evalHarness: true, send: (t) => spoken.push(t) });
    await convo._runLoop('hello?');

    expect(global.fetch).toHaveBeenCalledTimes(1); // exactly one attempt — no fallback retry on another provider
    expect(mockAnthropicStreamCalls).toHaveLength(0); // never touched Claude either
    expect(convo._modelFailures).toBe(1);
    expect(convo._modelSwitch).toBeNull();
    expect(convo._provider).toBe('openai'); // never switched
    expect(relayTools.executeTool).not.toHaveBeenCalled(); // never reached a tool round
    // The generic model-error copy was spoken — never a fabricated success.
    expect(spoken.some((t) => /say that again|trouble|sorry/i.test(t))).toBe(true);
  });
});

describe('GATE_VOICE_RELAY_OPENAI_INBOUND — production inbound (owner ruling 2026-09-28, GPT-6 Luna)', () => {
  test('off ⇒ production inbound rejects a voice-eligible OpenAI id (unchanged default)', () => {
    expect(isAllowedOverrideModel(LUNA)).toBe(false); // no context = production inbound reporting
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    const result = resolveSessionModel({ sandbox: false });
    expect(result.model).toBe(MODEL);
    expect(result.fallbackReason).toBe(`unknown_model_override:VOICE_RELAY_INBOUND_MODEL=${LUNA}`);
  });

  test('off ⇒ GATE_VOICE_RELAY_OPENAI (the sandbox/eval gate) alone does not open production inbound to Luna', () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    expect(isAllowedOverrideModel(LUNA)).toBe(false); // still no context = production inbound reporting
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    const result = resolveSessionModel({ sandbox: false });
    expect(result.model).toBe(MODEL);
    expect(result.fallbackReason).toBe(`unknown_model_override:VOICE_RELAY_INBOUND_MODEL=${LUNA}`);
  });

  test('on ⇒ production inbound accepts Luna — resolveSessionModel and a real session both pick it up, provider openai', () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    expect(isAllowedOverrideModel(LUNA, { inboundOpenaiContext: true })).toBe(true);
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    const result = resolveSessionModel({ sandbox: false });
    expect(result).toEqual({ model: LUNA, fallbackReason: null });

    const convo = new RelayConversation({ callSid: 'CA-luna-inbound', from: '+19415551234', send: () => {} });
    expect(convo.model).toBe(LUNA);
    expect(convo._provider).toBe('openai');
    expect(providerFor(LUNA)).toBe('openai');
  });

  // Sandbox/eval eligibility runs on its OWN (openaiContext) allowlist under
  // GATE_VOICE_RELAY_OPENAI — the new inbound-only gate has no effect on it
  // either direction. GATE_VOICE_RELAY_OPENAI on alone already covers
  // sandbox acceptance ("a sandbox session may take an OpenAI id..." above);
  // this proves the INBOUND gate alone does not substitute for it.
  test('on ⇒ GATE_VOICE_RELAY_OPENAI_INBOUND alone does not admit a sandbox session — that still needs GATE_VOICE_RELAY_OPENAI', () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_SANDBOX_MODEL = LUNA;
    const result = resolveSessionModel({ sandbox: true });
    expect(result.model).not.toBe(LUNA);
    expect(result.fallbackReason).toBe(`unknown_model_override:VOICE_RELAY_SANDBOX_MODEL=${LUNA}`);
  });

  // The shared chain (VOICE_RELAY_MODEL, then MODEL_VOICE) is Anthropic-only
  // regardless of either gate — collections-conversation.js reads the same env.
  test('the shared VOICE_RELAY_MODEL/MODEL_VOICE chain still rejects an OpenAI id even with the inbound gate on', () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_MODEL = LUNA;
    let result;
    jest.isolateModules(() => {
      result = require('../services/voice-agent/relay-conversation').resolveSessionModel({ sandbox: false });
    });
    expect(result.model).toBe(MODELS.DEFAULTS.VOICE);
    expect(result.fallbackReason).toBe(`unknown_shared_model:VOICE_RELAY_MODEL=${LUNA}`);
  });

  // Same convention as GATE_VOICE_RELAY_OPENAI's own "stub governs" test —
  // the new gate must be read through feature-gates' canonical
  // voiceRelayOpenaiInboundLive() alone, never a second ambient-env reader.
  test('the gate is read only through feature-gates voiceRelayOpenaiInboundLive — a stub governs, not the env', () => {
    const ctx = { inboundOpenaiContext: true };
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => undefined, voiceRelayOpenaiInboundLive: () => false }));
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      expect(require('../services/voice-agent/relay-conversation').isAllowedOverrideModel(LUNA, ctx)).toBe(false);
    });
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => undefined, voiceRelayOpenaiInboundLive: () => true }));
      delete process.env.GATE_VOICE_RELAY_OPENAI_INBOUND;
      expect(require('../services/voice-agent/relay-conversation').isAllowedOverrideModel(LUNA, ctx)).toBe(true);
    });
    jest.dontMock('../config/feature-gates');
  });
});

// The mid-call OpenAI provider-failure fallback (owner ruling 2026-09-28):
// production inbound AND sandbox sessions (never eval-harness) switch to
// Claude and retry a round once on a provider-reason failure — a request
// error, a non-2xx, a stream error, or the STREAM_TIMEOUT_MS timeout —
// unless the round already spoke (streamed a piece) or a caller barge-in is
// what actually ended it. See relay-conversation.js's file header and
// _runModelRound's doc comment for the full design.
describe('OpenAI provider-failure fallback (mid-call switch to Claude)', () => {
  test('a non-2xx OpenAI response switches the session to Claude and retries the SAME round once', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
    mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Sorry about that — how can I help?' }], stop_reason: 'end_turn' });

    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-fallback-1', from: '+19415551234', send: (t) => spoken.push(t) });
    expect(convo._provider).toBe('openai');
    expect(convo.model).toBe(LUNA);
    // handlePrompt (not a bare _runLoop) so this is a real caller turn —
    // stat.turn comes from _userTurns.length, which only handlePrompt seeds.
    await convo.handlePrompt('hello?');

    expect(global.fetch).toHaveBeenCalledTimes(1); // one failed OpenAI attempt
    expect(mockAnthropicStreamCalls).toHaveLength(1); // one retry, same round, on Claude
    expect(convo._provider).toBe('anthropic');
    expect(convo.model).toBe(MODELS.DEFAULTS.VOICE); // the shared chain's own resolution
    expect(convo._modelFailures).toBe(0); // the switch-and-retry succeeded — never counted as a failure
    expect(convo._modelSwitch).toEqual({ from: LUNA, to: MODELS.DEFAULTS.VOICE, reason: 'provider_error', turn: 1 }); // the first caller turn
    expect(convo._turnStats[0].modelSwitched).toBe(true);
    expect(spoken).toContain('Sorry about that — how can I help?');
    // The version stamp carries the switch record alongside the post-switch model/provider.
    const stamps = convo._versionStamps();
    expect(stamps.model).toBe(MODELS.DEFAULTS.VOICE);
    expect(stamps.provider).toBe('anthropic');
    expect(stamps.model_switch).toEqual(convo._modelSwitch);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('provider-failure fallback'));
  });

  test('a sandbox session gets the same fallback (production inbound AND sandbox, per the ruling)', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI = 'true';
    process.env.VOICE_RELAY_SANDBOX_MODEL = OPENAI_CANDIDATE;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
    mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Sandbox reply after the switch.' }], stop_reason: 'end_turn' });

    const convo = new RelayConversation({ callSid: 'CA-fallback-sandbox', from: '+19415551234', sandbox: true, send: () => {} });
    expect(convo._provider).toBe('openai');
    await convo._runLoop('hello?');

    expect(mockAnthropicStreamCalls).toHaveLength(1);
    expect(convo._provider).toBe('anthropic');
    expect(convo._modelSwitch.reason).toBe('provider_error');
  });

  test('the STREAM_TIMEOUT_MS timeout is a provider-reason failure too — same switch-and-retry', async () => {
    jest.useFakeTimers();
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      // A fetch that hangs until the abort signal fires, then rejects like a
      // real aborted fetch would — the same shape STREAM_TIMEOUT_MS's
      // `this._controller.abort()` produces against the live SDK.
      global.fetch = jest.fn((url, opts) => new Promise((_resolve, reject) => {
        const signal = opts && opts.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }
      }));
      mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Sorry — reconnecting.' }], stop_reason: 'end_turn' });

      const convo = new RelayConversation({ callSid: 'CA-fallback-timeout', from: '+19415551234', send: () => {} });
      const runPromise = convo._runLoop('hello?');
      await Promise.resolve();
      jest.advanceTimersByTime(20000); // STREAM_TIMEOUT_MS
      await runPromise;

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mockAnthropicStreamCalls).toHaveLength(1);
      expect(convo._provider).toBe('anthropic');
      expect(convo._modelSwitch.reason).toBe('stream_timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a caller barge-in is never treated as a provider failure — no switch, no retry', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    // A fetch whose signal aborts (a genuine caller barge-in, simulated by
    // aborting the controller mid-request) BEFORE any timeout fires.
    global.fetch = jest.fn((url, opts) => new Promise((_resolve, reject) => {
      const signal = opts && opts.signal;
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      if (signal.aborted) reject(err);
      else signal.addEventListener('abort', () => reject(err));
    }));

    const convo = new RelayConversation({ callSid: 'CA-fallback-bargein', from: '+19415551234', send: () => {} });
    const runPromise = convo._runLoop('hello?');
    await Promise.resolve(); // let fetch() be called and register its listener
    convo.interrupt({ utteranceUntilInterrupt: '' }); // aborts convo._controller — a real barge-in
    await runPromise;

    expect(mockAnthropicStreamCalls).toHaveLength(0); // never switched
    expect(convo._provider).toBe('openai');
    expect(convo._modelSwitch).toBeNull();
    expect(convo._modelFailures).toBe(0); // a barge-in is not a model failure either
  });

  test('history after the switch has no _openai extras, and tool_use/tool_result pairing stays intact', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    // Round 1 succeeds on OpenAI with a reasoning + tool call (carries
    // `_openai` on its tool_use block once in history). Round 2 (the
    // follow-up after the tool result) fails for a provider reason.
    let fetchCall = 0;
    global.fetch = jest.fn(async () => {
      fetchCall += 1;
      if (fetchCall === 1) {
        return {
          ok: true, status: 200,
          body: (async function* gen() {
            yield `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'r1', model: LUNA, status: 'completed',
                output: [
                  { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' },
                  // A blank message item beside the call — legal for OpenAI,
                  // but an empty text block 400s on the Anthropic API.
                  { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
                  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup_customer', arguments: '{"phone":"+19415551234"}', status: 'completed' },
                ],
              },
            })}\n\n`;
          }()),
        };
      }
      return { ok: false, status: 500, text: async () => 'server error' };
    });
    mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Thanks — how can I help?' }], stop_reason: 'end_turn' });

    const convo = new RelayConversation({ callSid: 'CA-fallback-history', from: '+19415551234', send: () => {} });
    await convo._runLoop('hi, this is Pat');

    expect(convo._provider).toBe('anthropic'); // switched after round 2's failure
    const toolUseMsg = convo.messages.find((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
    const toolUseBlock = toolUseMsg.content.find((b) => b.type === 'tool_use');
    expect(toolUseBlock).not.toHaveProperty('_openai'); // stripped at the switch
    expect(toolUseBlock).toMatchObject({ id: 'call_1', name: 'lookup_customer' });
    const toolResultMsg = convo.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
    expect(toolResultMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' }); // pairing intact
    // The retried round's request carries the SAME (now-stripped) history.
    const claudeRequest = mockAnthropicStreamCalls.at(-1);
    const claudeToolUse = claudeRequest.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b && b.type === 'tool_use');
    expect(claudeToolUse).not.toHaveProperty('_openai');
    const blankText = claudeRequest.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b && b.type === 'text' && !String(b.text).trim());
    expect(blankText).toEqual([]); // dropped at the switch
    expect(claudeRequest.messages.every((m) => typeof m.content === 'string' || m.content.length > 0)).toBe(true);
  });

  test('one switch per call — a Claude failure on the retried round takes the ordinary failure path, never a second switch', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
    mockAnthropicScriptedMessages.push(Promise.reject(new Error('Claude is also down')));

    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-fallback-double', from: '+19415551234', send: (t) => spoken.push(t) });
    await convo._runLoop('hello?');

    expect(convo._provider).toBe('anthropic'); // still switched — the switch itself doesn't undo
    expect(convo._modelSwitch).not.toBeNull();
    expect(convo._modelFailures).toBe(1); // the Claude retry's own failure counted normally
    expect(spoken.some((t) => /say that again|trouble|sorry/i.test(t))).toBe(true);
  });

  test('a round that already streamed a piece switches provider for the NEXT round but is not replayed itself', async () => {
    const savedRenderer = process.env.VOICE_RELAY_RENDERER;
    process.env.VOICE_RELAY_RENDERER = 'stream';
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      let fetchCall = 0;
      global.fetch = jest.fn(async () => {
        fetchCall += 1;
        if (fetchCall === 1) {
          // A safe, allowlisted filler sentence streams progressively (a
          // real _streamSend, creating streamState.entry), then the stream
          // fails before completing.
          return {
            ok: true, status: 200,
            body: (async function* gen() {
              yield `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } })}\n\n`;
              yield `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'One moment please. ' })}\n\n`;
              yield `data: ${JSON.stringify({ type: 'error', error: { code: 'stream_broke' } })}\n\n`;
            }()),
          };
        }
        // Round 2 (the caller's NEXT turn) — now on Claude, via the
        // Anthropic mock below; this branch is never reached.
        return { ok: false, status: 500, text: async () => 'server error' };
      });
      mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Thanks for waiting.' }], stop_reason: 'end_turn' });

      const spoken = [];
      const convo = new RelayConversation({ callSid: 'CA-fallback-spoke', from: '+19415551234', send: (t) => spoken.push(t) });
      expect(convo.renderer).toBe('stream');
      // handlePrompt (a real caller turn) — a streamed piece is recorded on
      // the turn's agentEntries, which a bare _runLoop never seeds.
      await convo.handlePrompt('hello?');

      // This round was NOT retried inline (it had already spoken) — exactly
      // one OpenAI attempt, no Claude call yet for THIS round.
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mockAnthropicStreamCalls).toHaveLength(0);
      // But the switch stands: the session is now pinned to Claude for
      // whatever runs next, and the round's own failure was still counted
      // and (if not handed off) spoken normally.
      expect(convo._provider).toBe('anthropic');
      expect(convo._modelSwitch).toMatchObject({ from: LUNA, reason: 'provider_error' });
      expect(convo._modelFailures).toBe(1);
      // The already-sent prefix is what history keeps — never replayed.
      const lastAssistant = [...convo.messages].reverse().find((m) => m.role === 'assistant');
      expect(JSON.stringify(lastAssistant.content)).toContain('One moment please.');

      // The NEXT round (the caller's next turn) runs on Claude.
      await convo.handlePrompt('are you still there?');
      expect(mockAnthropicStreamCalls).toHaveLength(1);
      expect(spoken).toContain('Thanks for waiting.');
    } finally {
      if (savedRenderer === undefined) delete process.env.VOICE_RELAY_RENDERER; else process.env.VOICE_RELAY_RENDERER = savedRenderer;
    }
  });

  test('a barge-in that lands while the failed round is still settling ends the round — no Claude retry of the old prompt', async () => {
    const savedRenderer = process.env.VOICE_RELAY_RENDERER;
    process.env.VOICE_RELAY_RENDERER = 'stream';
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      global.fetch = jest.fn(async () => ({
        ok: true, status: 200,
        body: (async function* gen() {
          yield `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } })}\n\n`;
          yield `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'One moment please. ' })}\n\n`;
          yield `data: ${JSON.stringify({ type: 'error', error: { code: 'stream_broke' } })}\n\n`;
        }()),
      }));
      mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Answer to the old prompt.' }], stop_reason: 'end_turn' });

      const spoken = [];
      const convo = new RelayConversation({ callSid: 'CA-fallback-gap', from: '+19415551234', send: (t) => spoken.push(t) });
      // The filler's flush step is still awaiting its supersession check when
      // the OpenAI failure is caught; the caller barges in during that wait,
      // so nothing of the round is ever sent.
      convo._sessionSuperseded = () => new Promise((resolve) => setTimeout(() => {
        convo.interrupt({ utteranceUntilInterrupt: '' });
        resolve(false);
      }, 0));
      await convo.handlePrompt('hello?');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mockAnthropicStreamCalls).toHaveLength(0); // never retried on Claude
      expect(spoken).not.toContain('Answer to the old prompt.');
      expect(convo._modelSwitch).toMatchObject({ from: LUNA, reason: 'provider_error' }); // the switch still stands
      expect(convo._modelFailures).toBe(0); // an interruption, not a counted failure
    } finally {
      if (savedRenderer === undefined) delete process.env.VOICE_RELAY_RENDERER; else process.env.VOICE_RELAY_RENDERER = savedRenderer;
    }
  });

  test('the switch is stamped on the call row at once, so a reconnect that starts before this socket closes still sees it', async () => {
    const db = require('../models/db');
    const update = jest.fn(async () => 1);
    const whereRaw = jest.fn(() => ({ update }));
    db.mockImplementation(() => ({ where: () => ({ whereRaw }) }));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
      mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'How can I help?' }], stop_reason: 'end_turn' });
      const convo = new RelayConversation({ callSid: 'CA-fallback-row', from: '+19415551234', send: () => {} });
      await convo.handlePrompt('hello?');
      await new Promise((resolve) => setImmediate(resolve));

      expect(update).toHaveBeenCalledTimes(1);
      expect(whereRaw).toHaveBeenCalledWith("metadata->'relay_model_switch' IS NULL"); // first switch wins
      const { metadata } = update.mock.calls[0][0];
      expect(metadata.sql).toContain("'relay_model_switch'");
      expect(JSON.parse(metadata.bindings[0])).toEqual(convo._modelSwitch);
    } finally {
      db.mockReset();
      delete db.raw;
    }
  });

  // gpt-5.6-luna stamps effort 'none'; the Claude fallback stamps 'low' — so
  // these two tell which model a turn's effort is credited to.
  test('turn effort is credited to Claude only when Claude retries the round', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = 'gpt-5.6-luna';
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
    mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'How can I help?' }], stop_reason: 'end_turn' });
    const convo = new RelayConversation({ callSid: 'CA-fallback-effort-retry', from: '+19415551234', send: () => {} });
    expect(convo._stampedEffort).toBe('none');
    await convo.handlePrompt('hello?');
    expect(mockAnthropicStreamCalls).toHaveLength(1);
    expect(convo._turnStats[0].effort).toBe('low');
  });

  test('a streamed round that spoke on OpenAI and then failed keeps OpenAI effort on its turn', async () => {
    const savedRenderer = process.env.VOICE_RELAY_RENDERER;
    process.env.VOICE_RELAY_RENDERER = 'stream';
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = 'gpt-5.6-luna';
      global.fetch = jest.fn(async () => ({
        ok: true, status: 200,
        body: (async function* gen() {
          yield `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } })}\n\n`;
          yield `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'One moment please. ' })}\n\n`;
          yield `data: ${JSON.stringify({ type: 'error', error: { code: 'stream_broke' } })}\n\n`;
        }()),
      }));
      const convo = new RelayConversation({ callSid: 'CA-fallback-effort-spoke', from: '+19415551234', send: () => {} });
      await convo.handlePrompt('hello?');
      expect(mockAnthropicStreamCalls).toHaveLength(0); // not retried
      expect(convo._provider).toBe('anthropic'); // switched for the next turn
      expect(convo._turnStats[0].effort).toBe('none'); // this turn's speech came from OpenAI
    } finally {
      if (savedRenderer === undefined) delete process.env.VOICE_RELAY_RENDERER; else process.env.VOICE_RELAY_RENDERER = savedRenderer;
    }
  });

  test('a round whose streamed send already failed is not retried on Claude — the socket cannot deliver speech', async () => {
    const savedRenderer = process.env.VOICE_RELAY_RENDERER;
    process.env.VOICE_RELAY_RENDERER = 'stream';
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      global.fetch = jest.fn(async () => ({
        ok: true, status: 200,
        body: (async function* gen() {
          yield `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } })}\n\n`;
          yield `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'One moment please. ' })}\n\n`;
          yield `data: ${JSON.stringify({ type: 'error', error: { code: 'stream_broke' } })}\n\n`;
        }()),
      }));
      mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Into a dead socket.' }], stop_reason: 'end_turn' });
      const sent = [];
      const convo = new RelayConversation({ callSid: 'CA-fallback-sendfail', from: '+19415551234', send: (t) => { sent.push(t); return false; } }); // every send undelivered
      await convo.handlePrompt('hello?');

      expect(mockAnthropicStreamCalls).toHaveLength(0); // no Claude retry
      expect(convo._modelSwitch).toMatchObject({ from: LUNA }); // the switch still stands
      expect(convo._modelFailures).toBe(1); // the ordinary failure path ran
    } finally {
      if (savedRenderer === undefined) delete process.env.VOICE_RELAY_RENDERER; else process.env.VOICE_RELAY_RENDERER = savedRenderer;
    }
  });

  test('a leg that finds another leg\'s switch already recorded runs on that model — one model per call', async () => {
    const db = require('../models/db');
    const { ALLOWED_OVERRIDE_MODEL_IDS } = require('../services/voice-agent/relay-conversation');
    const other = [...ALLOWED_OVERRIDE_MODEL_IDS].find((id) => id !== MODELS.DEFAULTS.VOICE);
    const winner = { from: LUNA, to: other, reason: 'stream_timeout', turn: 1 };
    db.mockImplementation(() => ({
      where: () => ({
        whereRaw: () => ({ update: async () => 0 }), // lost the claim
        first: async () => ({ model_switch: winner }),
      }),
    }));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
      mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'How can I help?' }], stop_reason: 'end_turn' });
      const convo = new RelayConversation({ callSid: 'CA-fallback-lost-claim', from: '+19415551234', send: () => {} });
      await convo.handlePrompt('hello?');

      expect(mockAnthropicStreamCalls).toHaveLength(1);
      expect(mockAnthropicStreamCalls[0].model).toBe(other); // the retry already runs on the winner's model
      expect(convo.model).toBe(other);
      expect(convo._modelSwitch).toEqual(winner);
    } finally {
      db.mockReset();
      delete db.raw;
    }
  });

  test('a superseded socket never spends a Claude retry — it ends as superseded', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
    mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Stale answer.' }], stop_reason: 'end_turn' });
    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-fallback-superseded', from: '+19415551234', send: (t) => spoken.push(t) });
    convo._sessionSuperseded = async () => true;
    convo._endSession = jest.fn();
    await convo.handlePrompt('hello?');

    expect(mockAnthropicStreamCalls).toHaveLength(0);
    expect(spoken).not.toContain('Stale answer.');
    expect(convo._endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'superseded' }));
    expect(convo._modelSwitch).toMatchObject({ from: LUNA }); // the switch itself still stands
  });

  test('a rejected shared Claude setting stays in the stamp after the switch lands on the registry default', () => {
    jest.isolateModules(() => {
      const saved = process.env.VOICE_RELAY_MODEL;
      process.env.VOICE_RELAY_MODEL = 'not-a-real-model';
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      try {
        const { RelayConversation: RC } = require('../services/voice-agent/relay-conversation');
        const convo = new RC({ callSid: 'CA-fallback-attr', from: '+19415551234', send: () => {} });
        expect(convo._provider).toBe('openai');
        expect(convo._modelFallbackReason).toBeNull();
        convo._switchToClaudeFallback('provider_error', { turn: 1 });
        expect(convo._versionStamps().model_fallback_reason).toBe('unknown_shared_model:VOICE_RELAY_MODEL=not-a-real-model');
      } finally {
        if (saved === undefined) delete process.env.VOICE_RELAY_MODEL; else process.env.VOICE_RELAY_MODEL = saved;
      }
    });
  });

  test('a reconnected leg of a call that already switched starts on Claude — one switch per call, not per socket', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    const convo = new RelayConversation({ callSid: 'CA-fallback-resume', from: '+19415551234', send: () => {} });
    expect(convo._provider).toBe('openai');
    const earlier = { from: LUNA, to: MODELS.DEFAULTS.VOICE, reason: 'provider_error', turn: 2 };
    await convo._applyResumeState({ callerTurns: [], lookupRefs: [], slotRefs: [], promises: [], modelSwitch: earlier });

    expect(convo._provider).toBe('anthropic');
    expect(convo.model).toBe(MODELS.DEFAULTS.VOICE);
    expect(convo._canSwitchToClaudeFallback()).toBe(false);
    expect(convo._versionStamps().model_switch).toEqual(earlier);
  });

  test('a reconnected leg keeps the Claude model the call already switched to, not this process\'s current setting', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    const { ALLOWED_OVERRIDE_MODEL_IDS } = require('../services/voice-agent/relay-conversation');
    const other = [...ALLOWED_OVERRIDE_MODEL_IDS].find((id) => id !== MODELS.DEFAULTS.VOICE);
    const convo = new RelayConversation({ callSid: 'CA-fallback-resume-model', from: '+19415551234', send: () => {} });
    await convo._applyResumeState({ callerTurns: [], lookupRefs: [], slotRefs: [], promises: [], modelSwitch: { from: LUNA, to: other, reason: 'provider_error', turn: 1 } });
    expect(convo.model).toBe(other);
    expect(convo._provider).toBe('anthropic');
    // A recorded model this process no longer allows falls to the shared chain.
    const convo2 = new RelayConversation({ callSid: 'CA-fallback-resume-model-2', from: '+19415551234', send: () => {} });
    await convo2._applyResumeState({ callerTurns: [], lookupRefs: [], slotRefs: [], promises: [], modelSwitch: { from: LUNA, to: 'gpt-6-sol', reason: 'provider_error', turn: 1 } });
    expect(convo2.model).toBe(MODELS.DEFAULTS.VOICE);
  });

  test('a reconnected leg of an unswitched call keeps the earlier leg\'s model while the gates still allow it', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true'; // no inbound override: this process alone would pick Claude
    const resume = { callerTurns: [], lookupRefs: [], slotRefs: [], promises: [], modelSwitch: null, priorModel: LUNA };
    const convo = new RelayConversation({ callSid: 'CA-resume-prior', from: '+19415551234', send: () => {} });
    expect(convo._provider).toBe('anthropic');
    await convo._applyResumeState(resume);
    expect(convo.model).toBe(LUNA);
    expect(convo._provider).toBe('openai');

    // Gate turned off since: the kill switch wins — the reconnect stays on Claude.
    delete process.env.GATE_VOICE_RELAY_OPENAI_INBOUND;
    const killed = new RelayConversation({ callSid: 'CA-resume-prior-killed', from: '+19415551234', send: () => {} });
    await killed._applyResumeState(resume);
    expect(killed._provider).toBe('anthropic');

    // A delayed reload after this leg already ran a model call never changes models mid-leg.
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    const late = new RelayConversation({ callSid: 'CA-resume-prior-late', from: '+19415551234', send: () => {} });
    late._turnStats.push({ rounds: 1 });
    await late._applyResumeState(resume);
    expect(late._provider).toBe('anthropic');
  });

  test('a leg that already switched on its own keeps its pin and record when a delayed resume reload lands', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    const { ALLOWED_OVERRIDE_MODEL_IDS } = require('../services/voice-agent/relay-conversation');
    const other = [...ALLOWED_OVERRIDE_MODEL_IDS].find((id) => id !== MODELS.DEFAULTS.VOICE);
    const convo = new RelayConversation({ callSid: 'CA-fallback-resume-late', from: '+19415551234', send: () => {} });
    await convo._switchToClaudeFallback('provider_error', { turn: 2 });
    const own = convo._modelSwitch;
    await convo._applyResumeState({ callerTurns: [], lookupRefs: [], slotRefs: [], promises: [], modelSwitch: { from: LUNA, to: other, reason: 'stream_timeout', turn: 1 } });
    expect(convo.model).toBe(MODELS.DEFAULTS.VOICE); // not repinned to the predecessor's model
    expect(convo._modelSwitch).toBe(own);
  });

  test('a mid-stream OpenAI error on the block renderer retries on Claude, and the turn stats describe the Claude reply', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      body: (async function* gen() {
        // output_item.added fires the adapter's content_block_start, so the
        // failed attempt stamps a first token before the stream breaks.
        yield `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } })}\n\n`;
        yield `data: ${JSON.stringify({ type: 'error', error: { code: 'stream_broke' } })}\n\n`;
      }()),
    }));
    mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'How can I help?' }], stop_reason: 'end_turn' });

    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-fallback-midstream', from: '+19415551234', send: (t) => spoken.push(t) });
    expect(convo.renderer).toBe('block');
    await convo.handlePrompt('hello?');

    expect(mockAnthropicStreamCalls).toHaveLength(1);
    expect(spoken).toContain('How can I help?');
    const stat = convo._turnStats[0];
    expect(stat.modelSwitched).toBe(true);
    expect(stat.firstTokenAt).toBeNull(); // the failed attempt's stamp is discarded (the Claude double streams no events)
    expect(stat.effort).toBe(convo._stampedEffort); // Claude's effort, not Luna's
    expect(stat.timedOut).toBe(false);
  });

  test('a caller who speaks again during a silent failed call gets the NEW turn answered — the old one is never retried', async () => {
    jest.useFakeTimers();
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      global.fetch = jest.fn((url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }));
      mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Wednesday works.' }], stop_reason: 'end_turn' });
      const spoken = [];
      const convo = new RelayConversation({ callSid: 'CA-fallback-new-prompt', from: '+19415551234', send: (t) => spoken.push(t) });
      convo.handlePrompt('book me for tuesday');
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const second = convo.handlePrompt('actually make it wednesday'); // a prompt, not an interrupt
      jest.advanceTimersByTime(20000); // STREAM_TIMEOUT_MS
      await second;

      expect(mockAnthropicStreamCalls).toHaveLength(1); // only the new turn, on Claude
      const lastUser = [...mockAnthropicStreamCalls[0].messages].reverse().find((m) => m.role === 'user');
      expect(JSON.stringify(lastUser.content)).toMatch(/wednesday/);
      expect(spoken).toContain('Wednesday works.');
      expect(convo._modelSwitch).toMatchObject({ from: LUNA, reason: 'stream_timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a Claude retry the caller talks past while it runs is dropped — never spoken, its tools never run', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
    let releaseRetry;
    mockAnthropicScriptedMessages.push(new Promise((resolve) => { releaseRetry = resolve; }));
    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-fallback-retry-talked-past', from: '+19415551234', send: (t) => spoken.push(t) });
    convo.handlePrompt('book me for tuesday');
    for (let i = 0; i < 50 && mockAnthropicStreamCalls.length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(mockAnthropicStreamCalls).toHaveLength(1); // the retry is in flight
    const second = convo.handlePrompt('actually make it wednesday');
    mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Wednesday works.' }], stop_reason: 'end_turn' });
    releaseRetry({ stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Tuesday is booked.' },
      { type: 'tool_use', id: 'tu-stale', name: 'request_booking', input: {} },
    ] });
    await second;

    expect(spoken).not.toContain('Tuesday is booked.');
    expect(relayTools.executeTool).not.toHaveBeenCalledWith('request_booking', expect.anything(), expect.anything());
    expect(spoken).toContain('Wednesday works.');
  });

  test('a correction that lands during an earlier tool round of the turn still blocks the Claude retry', async () => {
    process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
    process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
    let fetchCall = 0;
    global.fetch = jest.fn(async () => {
      fetchCall += 1;
      if (fetchCall === 1) {
        return {
          ok: true, status: 200,
          body: (async function* gen() {
            yield `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'r1', model: LUNA, status: 'completed',
                output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup_customer', arguments: '{"phone":"+19415551234"}', status: 'completed' }],
              },
            })}\n\n`;
          }()),
        };
      }
      return { ok: false, status: 500, text: async () => 'server error' }; // the turn's next round fails
    });
    let releaseTool;
    relayTools.executeTool.mockImplementationOnce(async () => { await new Promise((r) => { releaseTool = r; }); return 'Found: Pat Sample.'; });
    const spoken = [];
    const convo = new RelayConversation({ callSid: 'CA-fallback-tool-round', from: '+19415551234', send: (t) => spoken.push(t) });
    convo.handlePrompt('book me for tuesday');
    for (let i = 0; i < 50 && !releaseTool; i++) await new Promise((r) => setImmediate(r));
    expect(releaseTool).toBeDefined(); // the first tool round is running
    const second = convo.handlePrompt('actually make it wednesday');
    mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Wednesday works.' }], stop_reason: 'end_turn' });
    releaseTool();
    await second;

    expect(mockAnthropicStreamCalls).toHaveLength(1); // only the new turn — no retry of the old one
    const lastUser = [...mockAnthropicStreamCalls[0].messages].reverse().find((m) => m.role === 'user');
    expect(JSON.stringify(lastUser.content)).toMatch(/wednesday/);
    expect(spoken).toContain('Wednesday works.');
  });

  test('a timed-out switch claim is not a win — the leg reads and adopts the recorded switch', async () => {
    const db = require('../models/db');
    const { ALLOWED_OVERRIDE_MODEL_IDS } = require('../services/voice-agent/relay-conversation');
    const other = [...ALLOWED_OVERRIDE_MODEL_IDS].find((id) => id !== MODELS.DEFAULTS.VOICE);
    const winner = { from: LUNA, to: other, reason: 'provider_error', turn: 1 };
    db.mockImplementation(() => ({
      where: () => ({
        whereRaw: () => ({ update: () => new Promise(() => {}) }), // the write never answers
        first: async () => ({ model_switch: winner }),
      }),
    }));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    jest.useFakeTimers();
    try {
      const convo = new RelayConversation({ callSid: 'CA-claim-timeout', from: '+19415551234', send: () => {} });
      const claim = convo._claimModelSwitch({ from: LUNA, to: MODELS.DEFAULTS.VOICE, reason: 'provider_error', turn: 1 });
      await jest.advanceTimersByTimeAsync(2000);
      expect(await claim).toEqual(winner);
    } finally {
      jest.useRealTimers();
      db.mockReset();
      delete db.raw;
    }
  });

  test('a barge-in after a stream timeout, while the round is still settling, ends the round — no Claude retry', async () => {
    const savedRenderer = process.env.VOICE_RELAY_RENDERER;
    process.env.VOICE_RELAY_RENDERER = 'stream';
    jest.useFakeTimers();
    try {
      process.env.GATE_VOICE_RELAY_OPENAI_INBOUND = 'true';
      process.env.VOICE_RELAY_INBOUND_MODEL = LUNA;
      // A filler streams, then the stream hangs until the timeout aborts it.
      global.fetch = jest.fn(async (url, opts) => ({
        ok: true, status: 200,
        body: (async function* gen() {
          yield `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } })}\n\n`;
          yield `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'One moment please. ' })}\n\n`;
          await new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          }));
        }()),
      }));
      mockAnthropicScriptedMessages.push({ content: [{ type: 'text', text: 'Answer to the old prompt.' }], stop_reason: 'end_turn' });

      const spoken = [];
      const convo = new RelayConversation({ callSid: 'CA-fallback-timeout-gap', from: '+19415551234', send: (t) => spoken.push(t) });
      // Hold the filler's flush step open so the round is still settling
      // after the timeout has fired.
      let releaseCheck;
      // (Later ownership checks — the pre-retry one — answer at once.)
      convo._sessionSuperseded = () => (releaseCheck ? Promise.resolve(false) : new Promise((resolve) => { releaseCheck = resolve; }));
      const run = convo.handlePrompt('hello?');
      for (let i = 0; i < 20; i++) await Promise.resolve();
      jest.advanceTimersByTime(20000); // STREAM_TIMEOUT_MS — the timer aborts the controller
      for (let i = 0; i < 20; i++) await Promise.resolve();
      convo.interrupt({ utteranceUntilInterrupt: '' }); // the caller talks over the silence
      releaseCheck(false);
      await run;

      expect(mockAnthropicStreamCalls).toHaveLength(0); // never retried on Claude
      expect(spoken).not.toContain('Answer to the old prompt.');
      expect(convo._modelSwitch).toMatchObject({ from: LUNA, reason: 'stream_timeout' });
      expect(convo._turnStats[0].timedOut).toBe(true);
    } finally {
      jest.useRealTimers();
      if (savedRenderer === undefined) delete process.env.VOICE_RELAY_RENDERER; else process.env.VOICE_RELAY_RENDERER = savedRenderer;
    }
  });
});
