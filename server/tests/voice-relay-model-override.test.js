/**
 * Voice relay inbound-only model override.
 *
 * VOICE_RELAY_INBOUND_MODEL and VOICE_RELAY_SANDBOX_MODEL let the owner try a
 * candidate Anthropic model on Sandy's inbound line (and, narrower still, on
 * the sandbox test line) without ever touching the shared VOICE_RELAY_MODEL
 * that collections-conversation.js also reads. Pins:
 *  - precedence: sandbox model → inbound override → shared → tier default;
 *  - the model is resolved ONCE per session and pinned on `this.model` — two
 *    concurrent sessions under different env values never leak into each
 *    other, and a later env change never moves an already-built session;
 *  - an override that is not in the allowlist (config/models.js
 *    MODEL_CATALOG) is never silently substituted: one logged warning, the
 *    session falls back down the chain, and `_versionStamps().model` /
 *    `model_fallback_reason` both say so;
 *  - the sandbox selector has zero effect on a non-sandbox session;
 *  - collections-conversation.js's own VOICE_RELAY_MODEL resolution is
 *    provably unaffected by either new env.
 *
 * The last describe block builds a real CollectionsConversation the same way
 * tests/collections-conversation.test.js does (same mocks, same fixture rows)
 * so it can inspect the actual `model` sent to `anthropic.messages.stream`.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  // Richer than a bare jest.fn() so collections-conversation.js's
  // db.raw / db.schema.hasTable calls have something to hit too — inert for
  // every RelayConversation test above, which never invokes db() at all.
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  fn.schema = { hasTable: jest.fn(async () => true) };
  return fn;
});
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

// Stream-capturing Anthropic mock, shared by every test in this file. No test
// above this one ever calls _runLoop() / touches anthropic.messages.stream,
// so this is inert for them — only the collections describe block below
// drives a real turn through it.
const mockStreamCalls = [];
const mockScriptedMessages = [];
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({
  messages: {
    stream: jest.fn((params) => {
      mockStreamCalls.push(params);
      return { finalMessage: async () => mockScriptedMessages.shift() };
    }),
  },
})));

// collections-conversation.js's own dependencies — relay-conversation.js
// never imports any of these, so declaring them here cannot affect it.
jest.mock('../services/collections/contact-policy', () => ({
  loadEligibleInvoices: jest.fn(async () => ([
    { id: 'inv-1', invoice_number: 'WPC-0001', status: 'overdue', due_date: '2026-07-20', total: '258.00', credit_applied: 0 },
  ])),
  isWithinCallWindow: jest.fn(() => true),
  isSupervisedApprover: jest.fn(() => false),
  evaluate: jest.fn(async () => ({ allowed: true, denialReasons: [], eligibleInvoiceIds: null })),
}));
jest.mock('../services/collections/outbound-voice/flags', () => ({
  revokeAutomatedVoiceConsent: jest.fn(async () => ({ ok: true, created: true })),
  placeDisputeHold: jest.fn(async () => ({ ok: true, created: true })),
  flagWrongNumber: jest.fn(async () => ({ ok: true, created: true })),
  writeFlag: jest.fn(async () => ({ ok: true, created: true })),
  fileFlagCard: jest.fn(async () => true),
}));
jest.mock('../services/collections/outbound-voice/outcomes', () => {
  const actual = jest.requireActual('../services/collections/outbound-voice/outcomes');
  return { ...actual, writeCallOutcome: jest.fn(async () => ({ ok: true })) };
});
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => true),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'ledger-sms-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../services/invoice', () => ({
  sendViaSMS: jest.fn(async () => ({ sent: true, ok: true })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n1' })),
}));

const MODELS = require('../config/models');
const { THINKING_FLOOR_TOKENS } = require('../services/llm/anthropic-wire');
const logger = require('../services/logger');
const db = require('../models/db');
const {
  RelayConversation, resolveSessionModel, MODEL,
} = require('../services/voice-agent/relay-conversation');
const { CollectionsConversation } = require('../services/collections/outbound-voice/collections-conversation');

const OVERRIDE_ENV_KEYS = ['VOICE_RELAY_INBOUND_MODEL', 'VOICE_RELAY_SANDBOX_MODEL'];
let SAVED_ENV;

beforeEach(() => {
  jest.clearAllMocks();
  mockStreamCalls.length = 0;
  mockScriptedMessages.length = 0;
  SAVED_ENV = {};
  for (const k of OVERRIDE_ENV_KEYS) { SAVED_ENV[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of OVERRIDE_ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k];
  }
});

describe('resolveSessionModel — precedence table', () => {
  test('no overrides set ⇒ the shared module default (VOICE_RELAY_MODEL || MODELS.VOICE), sandbox or not', () => {
    expect(resolveSessionModel({ sandbox: false })).toEqual({ model: MODEL, fallbackReason: null });
    expect(resolveSessionModel({ sandbox: true })).toEqual({ model: MODEL, fallbackReason: null });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('inbound override wins over the shared default on a production (non-sandbox) session', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-haiku-4-5-20251001';
    expect(resolveSessionModel({ sandbox: false })).toEqual({ model: 'claude-haiku-4-5-20251001', fallbackReason: null });
  });

  test('inbound override still applies on a sandbox session when no sandbox override is set', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-opus-5';
    expect(resolveSessionModel({ sandbox: true })).toEqual({ model: 'claude-opus-5', fallbackReason: null });
  });

  test('sandbox override outranks the inbound override on a sandbox session', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-sonnet-5';
    process.env.VOICE_RELAY_SANDBOX_MODEL = 'claude-opus-5';
    expect(resolveSessionModel({ sandbox: true })).toEqual({ model: 'claude-opus-5', fallbackReason: null });
  });

  test('sandbox override is inert on a non-sandbox session — never read', () => {
    process.env.VOICE_RELAY_SANDBOX_MODEL = 'claude-opus-5';
    expect(resolveSessionModel({ sandbox: false })).toEqual({ model: MODEL, fallbackReason: null });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('an empty-string override is treated as unset, not as a rejected value', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = '';
    expect(resolveSessionModel({ sandbox: false })).toEqual({ model: MODEL, fallbackReason: null });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('an unknown inbound override id falls back to the shared default with one warning + a stamped reason', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-nope-9000';
    const result = resolveSessionModel({ sandbox: false });
    expect(result.model).toBe(MODEL);
    expect(result.fallbackReason).toBe('unknown_model_override:VOICE_RELAY_INBOUND_MODEL=claude-nope-9000');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('claude-nope-9000');
  });

  test('a Fable id is rejected too — Fable/Mythos ids require services/llm/deep.js and this lane sends thinking:disabled', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-fable-5-1';
    const result = resolveSessionModel({ sandbox: false });
    expect(result.model).toBe(MODEL);
    expect(result.fallbackReason).toBe('unknown_model_override:VOICE_RELAY_INBOUND_MODEL=claude-fable-5-1');
  });

  test('an unknown sandbox override still falls through to a VALID inbound override, but the rejection is still stamped', () => {
    process.env.VOICE_RELAY_SANDBOX_MODEL = 'not-a-real-model';
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-haiku-4-5-20251001';
    const result = resolveSessionModel({ sandbox: true });
    // What actually ran is the still-valid, lower-precedence override — never
    // silently promoted to the ultimate default when a legitimate fallback
    // exists below it in the chain.
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.fallbackReason).toBe('unknown_model_override:VOICE_RELAY_SANDBOX_MODEL=not-a-real-model');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('not-a-real-model');
  });
});

describe('rejected-override warning is deduplicated per process', () => {
  test('every call still stamps its fallback reason, but the warning is logged once per source/value', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-dedupe-probe-1';
    const first = resolveSessionModel({ sandbox: false });
    const second = resolveSessionModel({ sandbox: false });
    expect(first.fallbackReason).toBe('unknown_model_override:VOICE_RELAY_INBOUND_MODEL=claude-dedupe-probe-1');
    expect(second.fallbackReason).toBe(first.fallbackReason);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // A different bad value is a new misconfiguration and warns again.
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-dedupe-probe-2';
    resolveSessionModel({ sandbox: false });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[1][0]).toContain('claude-dedupe-probe-2');
  });
});

describe('per-session pinning', () => {
  test('two sessions built under different env values each keep their own resolved model; changing env afterwards moves neither', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-opus-5';
    const convoA = new RelayConversation({ callSid: 'CA-pin-a', from: '+19415551234', send: jest.fn() });
    expect(convoA.model).toBe('claude-opus-5');

    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-haiku-4-5-20251001';
    const convoB = new RelayConversation({ callSid: 'CA-pin-b', from: '+19415551234', send: jest.fn() });
    expect(convoB.model).toBe('claude-haiku-4-5-20251001');

    // A third env change after BOTH sessions exist must not reach either one.
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-opus-4-8';
    expect(convoA.model).toBe('claude-opus-5');
    expect(convoB.model).toBe('claude-haiku-4-5-20251001');

    delete process.env.VOICE_RELAY_INBOUND_MODEL;
    expect(convoA.model).toBe('claude-opus-5');
    expect(convoB.model).toBe('claude-haiku-4-5-20251001');
  });

  test('a concurrent production session and a sandbox session never leak into each other', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-sonnet-5';
    process.env.VOICE_RELAY_SANDBOX_MODEL = 'claude-opus-5';
    const prod = new RelayConversation({ callSid: 'CA-prod', from: '+19415551234', send: jest.fn(), sandbox: false });
    const sandboxCall = new RelayConversation({ callSid: 'CA-sb', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(prod.model).toBe('claude-sonnet-5');
    expect(sandboxCall.model).toBe('claude-opus-5');

    // Flipping the sandbox var after both are built must not move the prod call.
    process.env.VOICE_RELAY_SANDBOX_MODEL = 'claude-haiku-4-5-20251001';
    expect(prod.model).toBe('claude-sonnet-5');
    expect(sandboxCall.model).toBe('claude-opus-5');
  });
});

describe('unknown override never reaches the model request, and the version stamp says so', () => {
  test('an unknown inbound override id: this.model is the safe default, and _versionStamps names the rejection', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-nope-9000';
    const convo = new RelayConversation({ callSid: 'CA-unknown', from: '+19415551234', send: jest.fn() });
    expect(convo.model).toBe(MODEL);
    const stamps = convo._versionStamps();
    expect(stamps.model).toBe(MODEL);
    expect(stamps.model_fallback_reason).toBe('unknown_model_override:VOICE_RELAY_INBOUND_MODEL=claude-nope-9000');
  });

  test('no override set ⇒ no warning, and model_fallback_reason is null', () => {
    const convo = new RelayConversation({ callSid: 'CA-clean', from: '+19415551234', send: jest.fn() });
    expect(convo.model).toBe(MODEL);
    expect(convo._versionStamps().model_fallback_reason).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('collections-conversation.js resolution is unaffected by the new envs', () => {
  const CALL_ROW = {
    id: 'cl-1',
    direction: 'outbound',
    source: 'collections_voice',
    twilio_call_sid: 'CA1',
    customer_id: 'cust-1',
    to_phone: '+19415551234',
    metadata: JSON.stringify({ collectionCaseId: 'case-1', caseVersion: 3, ledgerId: 'ledger-1', collectionsSupervised: false }),
  };
  const CASE_ROW = { id: 'case-1', customer_id: 'cust-1', case_version: 3, eligible_invoice_ids: JSON.stringify(['inv-1']) };
  const CUSTOMER = {
    id: 'cust-1', first_name: 'Pat', last_name: 'Sample',
    phone: '+19415551234', address_line1: '4128 Shellcracker Dr', zip: '34208',
  };

  function chain({ first } = {}) {
    const q = {};
    ['where', 'whereIn', 'whereNull', 'whereRaw', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => first);
    q.update = jest.fn(async () => 1);
    return q;
  }

  function setDb(target = db) {
    const queues = {
      call_log: [chain({ first: CALL_ROW }), chain(), chain(), chain()],
      collection_cases: [chain({ first: CASE_ROW })],
    };
    target.mockImplementation((table) => {
      if (table === 'customers') return chain({ first: CUSTOMER });
      if (table === 'customer_dunning_sequences') return chain({ first: undefined });
      const queue = queues[table];
      if (!queue || !queue.length) return chain();
      return queue.shift();
    });
  }

  beforeEach(() => {
    process.env.GATE_VOICE_LATE_PAYMENT = 'true';
    delete process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK;
    delete process.env.GATE_COLLECTIONS_POLICY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    setDb();
  });

  afterEach(() => {
    delete process.env.GATE_VOICE_LATE_PAYMENT;
  });

  test('the outbound collections flow keeps reading VOICE_RELAY_MODEL only, never the inbound/sandbox overrides', async () => {
    // Deliberately leave VOICE_RELAY_MODEL unset so the expected resolution
    // is the bare MODELS.VOICE tier default — and set BOTH new overrides to
    // values that would prove a leak if collections ever read them.
    process.env.VOICE_RELAY_INBOUND_MODEL = 'claude-haiku-4-5-20251001';
    process.env.VOICE_RELAY_SANDBOX_MODEL = 'claude-opus-5';
    mockScriptedMessages.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Am I speaking with Pat?' }] });

    const spoken = [];
    const convo = new CollectionsConversation({
      callSid: 'CA1',
      from: '+19412975749',
      to: '+19415551234',
      send: (t) => spoken.push(t),
      endSession: jest.fn(),
      now: () => new Date('2026-08-12T15:00:00Z'), // Wed 11:00 ET — staffed hours
    });
    convo.handlePrompt('Hello?');
    await convo._chain;

    expect(mockStreamCalls).toHaveLength(1);
    // The overrides above must have NO effect on collections: it still
    // resolves the shared VOICE_RELAY_MODEL (unset here) → MODELS.VOICE —
    // never the inbound or sandbox override value.
    expect(mockStreamCalls[0].model).toBe(MODELS.VOICE);
    expect(mockStreamCalls[0].model).not.toBe(process.env.VOICE_RELAY_INBOUND_MODEL);
    expect(mockStreamCalls[0].model).not.toBe(process.env.VOICE_RELAY_SANDBOX_MODEL);
  });

  // collections-conversation.js previously read VOICE_RELAY_MODEL/MODEL_VOICE
  // with NO validation at all — a thinking-always-on id (Opus 5.5+) there
  // would 400 on this lane's always-on `thinking: { type: 'disabled' }`
  // every single call. It now guards against exactly that (reusing
  // relay-conversation's own ALLOWED_OVERRIDE_MODEL_IDS), falling back to
  // MODELS.DEFAULTS.VOICE with one logged warning — the module-level MODEL
  // const is resolved once at require time, so this needs a fresh module
  // registry under the bad env.
  // The walk validates each link in order: a rejected VOICE_RELAY_MODEL
  // falls to a valid configured MODEL_VOICE, and only then to the code default.
  test.each([
    ['unset MODEL_VOICE → the code default', undefined, () => MODELS.DEFAULTS.VOICE],
    ['a valid custom MODEL_VOICE → that tier', 'claude-opus-5', () => 'claude-opus-5'],
  ])('a thinking-always-on VOICE_RELAY_MODEL is rejected with a warning — %s', async (_label, modelVoice, expected) => {
    process.env.VOICE_RELAY_MODEL = 'claude-opus-5-5';
    if (modelVoice) process.env.MODEL_VOICE = modelVoice;
    let FreshCollectionsConversation;
    let isolatedLogger;
    jest.isolateModules(() => {
      // A fresh require inside isolateModules gets its OWN mock instance for
      // ../services/logger (the factory re-runs), separate from the outer
      // `logger` this file requires at top — captured here so the assertion
      // below checks the instance collections-conversation.js actually used.
      isolatedLogger = require('../services/logger');
      // Same for ../models/db: configure the instance the fresh module
      // actually requires, not the outer one beforeEach set up.
      setDb(require('../models/db'));
      FreshCollectionsConversation = require('../services/collections/outbound-voice/collections-conversation').CollectionsConversation;
    });
    delete process.env.VOICE_RELAY_MODEL;
    delete process.env.MODEL_VOICE;

    expect(isolatedLogger.warn).toHaveBeenCalledWith(expect.stringContaining('claude-opus-5-5'));

    mockScriptedMessages.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Am I speaking with Pat?' }] });
    const convo = new FreshCollectionsConversation({
      callSid: 'CA1',
      from: '+19412975749',
      to: '+19415551234',
      send: jest.fn(),
      endSession: jest.fn(),
      now: () => new Date('2026-08-12T15:00:00Z'), // Wed 11:00 ET — staffed hours
    });
    convo.handlePrompt('Hello?');
    await convo._chain;

    expect(mockStreamCalls).toHaveLength(1);
    expect(mockStreamCalls[0].model).toBe(expected());
    expect(mockStreamCalls[0].thinking).toEqual({ type: 'disabled' }); // still sent — and now safe to send
  });
});

// Haiku 4.5 (and pre-5 Sonnets) 400 on `output_config.effort`. A session
// pinned to one through an override must omit the field, or every turn of the
// call errors before a word is spoken — and the benchmark's candidate arm would
// score as a total failure.
describe('effort is sent only to models that accept it', () => {
  const HAIKU = 'claude-haiku-4-5-20251001';

  // Uses this file's shared stream-capturing @anthropic-ai/sdk mock.
  async function runOneTurn(callSid) {
    mockScriptedMessages.push({ content: [{ type: 'text', text: 'Hi there.' }], stop_reason: 'end_turn' });
    const convo = new RelayConversation({ callSid, from: '+19415551234', send: jest.fn() });
    await convo._runLoop('hello').catch(() => {});
    return { convo, sent: mockStreamCalls.slice() };
  }

  test('voiceEffortFor: low for effort-capable models, null for Haiku 4.5', () => {
    const { voiceEffortFor } = require('../services/voice-agent/relay-conversation');
    expect(MODELS.MODEL_CATALOG[HAIKU]).toBeTruthy();
    expect(voiceEffortFor('claude-sonnet-5')).toBe('low');
    expect(voiceEffortFor(HAIKU)).toBeNull();
    expect(voiceEffortFor(undefined)).toBeNull();
    // Partially capable Opus tiers accept `low` (codex r1 P2 on #4938).
    expect(voiceEffortFor('claude-opus-4-5')).toBe('low');
    expect(voiceEffortFor('claude-opus-4-6')).toBe('low');
    expect(MODELS.anthropicAcceptsEffort('claude-opus-4-5', 'xhigh')).toBe(false);
    expect(MODELS.anthropicAcceptsEffort('claude-opus-4-6', 'xhigh')).toBe(false);
    expect(MODELS.anthropicAcceptsEffort('claude-opus-4-6', 'max')).toBe(true);
    expect(MODELS.anthropicAcceptsEffort('claude-sonnet-5', 'xhigh')).toBe(true);
    expect(MODELS.anthropicAcceptsEffort('claude-sonnet-4-5', 'low')).toBe(false);
  });

  test('a Haiku 4.5 inbound override sends no output_config and stamps effort null', async () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = HAIKU;
    const { convo, sent } = await runOneTurn('CA-haiku-effort');
    expect(convo.model).toBe(HAIKU);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const p of sent) {
      expect(p.model).toBe(HAIKU);
      expect(p).not.toHaveProperty('output_config');
      expect(p.thinking).toEqual({ type: 'disabled' });
    }
    expect(convo._versionStamps().effort).toBeNull();
  });

  test('the default session still sends effort low', async () => {
    const { convo, sent } = await runOneTurn('CA-default-effort');
    expect(MODELS.ANTHROPIC_EFFORT_CAPABLE_RE.test(convo.model)).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const p of sent) expect(p.output_config).toEqual({ effort: 'low' });
    expect(convo._versionStamps().effort).toBe('low');
  });

  // Sonnet 5 (the code default, MODELS.DEFAULTS.VOICE) is a thinking-capable
  // model but NOT thinking-always-on — its request must stay byte-identical
  // to before Opus 5.5 existed: `thinking: disabled` still sent, max_tokens
  // still the plain lane constant.
  test('the default (Sonnet 5) session request is unchanged: thinking disabled, max_tokens 1024', async () => {
    const { convo, sent } = await runOneTurn('CA-sonnet-unchanged');
    expect(convo.model).toBe('claude-sonnet-5');
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const p of sent) {
      expect(p.thinking).toEqual({ type: 'disabled' });
      expect(p.max_tokens).toBe(1024);
    }
  });
});

// Sonnet 5.5 (`claude-sonnet-5-5`) — rejects `thinking: { type: 'disabled' }`;
// its floor is `between_tools` (no up-front thinking), which the lane sends
// instead. Same containment as Opus 5.5: sandbox / eval harness only.
describe('Sonnet 5.5 sandbox candidate (between_tools floor)', () => {
  const SONNET_55 = 'claude-sonnet-5-5';

  test('catalog entry is deep-only with a between_tools voice floor, and the registry predicate agrees', () => {
    expect(MODELS.MODEL_CATALOG[SONNET_55]).toMatchObject({ provider: 'anthropic', status: 'current', requires: 'deep', voice: { thinking: 'between_tools' } });
    expect(MODELS.anthropicThinkingAlwaysOn(SONNET_55)).toBe(true);
    expect(MODELS.anthropicThinkingAlwaysOn('claude-sonnet-5')).toBe(false);
    expect(MODELS.anthropicAcceptsEffort(SONNET_55, 'low')).toBe(true);
  });

  test('sandbox and eval harness only — never production inbound or the shared chain', () => {
    const { ALLOWED_OVERRIDE_MODEL_IDS, ANTHROPIC_SANDBOX_OVERRIDE_MODEL_IDS, allowedOverrideModelIds } = require('../services/voice-agent/relay-conversation');
    expect(ALLOWED_OVERRIDE_MODEL_IDS.has(SONNET_55)).toBe(false);
    expect(ANTHROPIC_SANDBOX_OVERRIDE_MODEL_IDS.has(SONNET_55)).toBe(true);
    expect(allowedOverrideModelIds().has(SONNET_55)).toBe(false);
    expect(allowedOverrideModelIds({ openaiContext: true }).has(SONNET_55)).toBe(true);
    process.env.VOICE_RELAY_INBOUND_MODEL = SONNET_55;
    expect(resolveSessionModel({ sandbox: false }).model).toBe(MODEL);
    expect(resolveSessionModel({ sandbox: false, evalHarness: true })).toEqual({ model: SONNET_55, fallbackReason: null });
  });

  test('a sandbox request sends thinking between_tools at low effort with the thinking floor cap', async () => {
    process.env.VOICE_RELAY_SANDBOX_MODEL = SONNET_55;
    mockScriptedMessages.push({ content: [{ type: 'text', text: 'Sandbox reply.' }], stop_reason: 'end_turn' });
    const convo = new RelayConversation({ callSid: 'CA-sonnet55-sandbox', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(convo.model).toBe(SONNET_55);
    await convo._runLoop('hello').catch(() => {});
    expect(mockStreamCalls.length).toBeGreaterThanOrEqual(1);
    for (const p of mockStreamCalls) {
      expect(p.model).toBe(SONNET_55);
      expect(p.thinking).toEqual({ type: 'between_tools' });
      expect(p.output_config).toEqual({ effort: 'low' });
      expect(p.max_tokens).toBe(THINKING_FLOOR_TOKENS); // progress-update thinking blocks spend from it (shared floor)
      expect(p).not.toHaveProperty('tool_choice');
    }
  });
});

// Opus 5.5 (`claude-opus-5-5`) — thinking always on, rejects
// `thinking: { type: 'disabled' }`. Reachable ONLY for a sandbox test call
// or the eval/benchmark harness, never production inbound and never the
// shared VOICE_RELAY_MODEL / MODEL_VOICE chain.
describe('thinking-always-on Anthropic candidates (Opus 5.5+)', () => {
  const OPUS_55 = 'claude-opus-5-5';

  test('MODEL_CATALOG carries the entry and the registry predicate agrees', () => {
    expect(MODELS.MODEL_CATALOG[OPUS_55]).toMatchObject({ provider: 'anthropic', status: 'current' });
    expect(MODELS.anthropicThinkingAlwaysOn(OPUS_55)).toBe(true);
    // Bare Opus 5 stays thinking-disable-able — the existing override tests
    // above rely on picking it with `thinking: disabled` still sent.
    expect(MODELS.anthropicThinkingAlwaysOn('claude-opus-5')).toBe(false);
  });

  test('excluded from the production allowlist and the shared VOICE_RELAY_MODEL/MODEL_VOICE chain', () => {
    const { ALLOWED_OVERRIDE_MODEL_IDS, ANTHROPIC_SANDBOX_OVERRIDE_MODEL_IDS, allowedOverrideModelIds } = require('../services/voice-agent/relay-conversation');
    expect(ALLOWED_OVERRIDE_MODEL_IDS.has(OPUS_55)).toBe(false);
    expect(ANTHROPIC_SANDBOX_OVERRIDE_MODEL_IDS.has(OPUS_55)).toBe(true);
    expect(allowedOverrideModelIds().has(OPUS_55)).toBe(false); // no context = production inbound reporting
    expect(allowedOverrideModelIds({ openaiContext: true }).has(OPUS_55)).toBe(true);
  });

  test('production inbound override is rejected — falls back to the shared default with a stamped reason', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = OPUS_55;
    const result = resolveSessionModel({ sandbox: false });
    expect(result.model).toBe(MODEL);
    expect(result.fallbackReason).toBe(`unknown_model_override:VOICE_RELAY_INBOUND_MODEL=${OPUS_55}`);
  });

  test('the shared VOICE_RELAY_MODEL/MODEL_VOICE chain never resolves to it either, sandbox or not', () => {
    // SHARED_MODEL_CHAIN is captured at module load, so load a fresh
    // instance with the env already set.
    process.env.VOICE_RELAY_MODEL = OPUS_55;
    let freshResolve;
    try {
      jest.isolateModules(() => {
        freshResolve = require('../services/voice-agent/relay-conversation').resolveSessionModel;
      });
    } finally {
      delete process.env.VOICE_RELAY_MODEL;
    }
    for (const sandbox of [false, true]) {
      const result = freshResolve({ sandbox });
      expect(result.model).not.toBe(OPUS_55);
      expect(result.fallbackReason).toBe(`unknown_shared_model:VOICE_RELAY_MODEL=${OPUS_55}`);
    }
  });

  test('a sandbox session accepts it with no gate required', () => {
    process.env.VOICE_RELAY_SANDBOX_MODEL = OPUS_55;
    const result = resolveSessionModel({ sandbox: true });
    expect(result).toEqual({ model: OPUS_55, fallbackReason: null });
  });

  test('an eval-harness session accepts it too (the benchmark runner path)', () => {
    process.env.VOICE_RELAY_INBOUND_MODEL = OPUS_55;
    const result = resolveSessionModel({ sandbox: false, evalHarness: true });
    expect(result).toEqual({ model: OPUS_55, fallbackReason: null });
  });

  // Uses this file's shared stream-capturing @anthropic-ai/sdk mock (see
  // `runOneTurn` above) — a sandbox session pinned to Opus 5.5 by
  // VOICE_RELAY_SANDBOX_MODEL.
  test('its request omits thinking, keeps effort low, and raises max_tokens to the shared floor', async () => {
    process.env.VOICE_RELAY_SANDBOX_MODEL = OPUS_55;
    mockScriptedMessages.push({ content: [{ type: 'text', text: 'Sandbox reply.' }], stop_reason: 'end_turn' });
    const convo = new RelayConversation({ callSid: 'CA-opus55-sandbox', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(convo.model).toBe(OPUS_55);
    await convo._runLoop('hello').catch(() => {});
    expect(mockStreamCalls.length).toBeGreaterThanOrEqual(1);
    for (const p of mockStreamCalls) {
      expect(p.model).toBe(OPUS_55);
      expect(p).not.toHaveProperty('thinking');
      expect(p.output_config).toEqual({ effort: 'low' });
      expect(p.max_tokens).toBe(THINKING_FLOOR_TOKENS); // 8192 — raised off the plain 1024 lane constant
    }
  });

  // The preserved-thinking history-editing check (KEY FACTS): a thinking
  // block returned alongside a tool_use must be passed back UNCHANGED, in
  // order (thinking first) into `this.messages` — the exact array the next
  // round's request sends as `messages` (see the request build), so proving
  // it lands there correctly proves it rides into the next request unchanged.
  test('a thinking block accompanying a tool_use is preserved, in order, in history (block renderer)', async () => {
    process.env.VOICE_RELAY_SANDBOX_MODEL = OPUS_55;
    const convo = new RelayConversation({ callSid: 'CA-opus55-thinking', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(convo.model).toBe(OPUS_55);
    const msg = {
      content: [
        { type: 'thinking', thinking: 'internal reasoning', signature: 'sig-1' },
        { type: 'tool_use', id: 't1', name: 'get_pricing', input: {} },
      ],
      stop_reason: 'tool_use',
    };
    const { assistantMessage } = await convo._finalizeBlockRound(msg, '', false);
    expect(convo.messages).toContainEqual(assistantMessage);
    expect(assistantMessage.content[0]).toEqual({ type: 'thinking', thinking: 'internal reasoning', signature: 'sig-1' });
    expect(assistantMessage.content[1]).toMatchObject({ type: 'tool_use', id: 't1' });
  });

  describe('signed thinking replay prefixes', () => {
    afterEach(() => { delete process.env.GATE_VOICE_RELAY_INTERRUPT_CONTEXT; });

    function thinkingConvo(callSid) {
      process.env.VOICE_RELAY_SANDBOX_MODEL = OPUS_55;
      return new RelayConversation({ callSid, from: '+19415551234', send: jest.fn(), sandbox: true });
    }

    test('keeps legal interleaved response blocks unchanged and appends sent-only guidance to the tool-result turn', async () => {
      const convo = thinkingConvo('CA-opus55-interleaved');
      jest.spyOn(convo, '_runStreamSendOrFail').mockReturnValue(null);
      jest.spyOn(convo, '_executeToolBounded').mockResolvedValue('Price result.');
      const content = [
        { type: 'text', text: 'Let me check. That request is complete.' },
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-interleaved' },
        { type: 'tool_use', id: 't1', name: 'get_pricing', input: {} },
      ];
      const msg = { content, stop_reason: 'tool_use' };
      const entry = { planned: 'Let me check. ' };

      const { assistantMessage } = convo._closeStreamedRoundSentOnly(
        { entry }, msg, entry.planned, 'That request is complete.', true
      );

      expect(assistantMessage.content).toBe(content);
      expect(assistantMessage.content).toEqual(content);
      expect(entry.historyMessage).toBe(assistantMessage);
      await expect(convo._runToolUseRound(msg, {}, { toolMs: 0, toolCount: 0 }, null)).resolves.toEqual({ done: false });
      expect(convo.messages.at(-1)).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'Price result.' },
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Only this text'),
          }),
        ],
      });
    });

    test('an interruption after a thinking tool follow-up does not rewrite either signed assistant response', () => {
      process.env.GATE_VOICE_RELAY_INTERRUPT_CONTEXT = 'true';
      const convo = thinkingConvo('CA-opus55-interrupt-followup');
      const toolContent = [
        { type: 'text', text: 'Let me check that. ' },
        { type: 'thinking', thinking: 'tool reasoning', signature: 'sig-tool' },
        { type: 'tool_use', id: 't1', name: 'get_pricing', input: {} },
      ];
      const followupContent = [
        { type: 'thinking', thinking: 'follow-up reasoning', signature: 'sig-followup' },
        { type: 'text', text: 'The follow-up answer.' },
      ];
      const toolMessage = { role: 'assistant', content: toolContent };
      const followupMessage = { role: 'assistant', content: followupContent };
      convo.messages.push(
        toolMessage,
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Price result.' }] },
        followupMessage,
      );

      convo._noteInterruptForModel(
        { historyMessage: toolMessage, text: 'Let me check [interrupted]', played: 'Let me check', playedUnknown: false },
        [{ historyMessage: followupMessage, text: '[not played — caller interrupted]' }],
      );

      expect(toolMessage.content).toBe(toolContent);
      expect(toolMessage.content).toEqual(toolContent);
      expect(followupMessage.content).toBe(followupContent);
      expect(followupMessage.content).toEqual(followupContent);
      expect(convo._consumeInterruptNote()).toContain('Let me check');
    });

    test('an abort before finalMessage resolves still records its unsigned sent prefix', () => {
      const convo = thinkingConvo('CA-opus55-early-abort');
      const entry = { planned: 'One moment please. ', interrupted: false };

      const result = convo._closeStreamedRoundEarly({ entry }, null, 'interrupted');

      expect(result).toEqual({ aborted: true });
      expect(convo.messages).toContainEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'One moment please.' }],
      });
    });

    test('a completed response interrupted before any stream entry carries an unsaid note into the next real caller turn', async () => {
      delete process.env.GATE_VOICE_RELAY_INTERRUPT_CONTEXT;
      const convo = thinkingConvo('CA-opus55-no-entry-interrupt');
      const content = [
        { type: 'thinking', thinking: 'amount reasoning', signature: 'sig-amount' },
        { type: 'text', text: 'That will be $149.' },
      ];
      const result = convo._closeStreamedRoundEarly(
        { entry: null },
        { content, stop_reason: 'end_turn' },
        'interrupted',
      );
      expect(result).toEqual({ aborted: true });
      expect(convo.messages.at(-1).content).toBe(content);
      expect(convo._pendingInterruptNote).toBeNull();

      mockScriptedMessages.push({
        content: [{ type: 'text', text: 'Of course — let me repeat that.' }],
        stop_reason: 'end_turn',
      });
      await convo._runLoop('Can you repeat that?');

      const request = mockStreamCalls.at(-1);
      const callerTurn = request.messages.find((message) => {
        const text = typeof message.content === 'string'
          ? message.content
          : message.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ');
        return message.role === 'user' && text.includes('Can you repeat that?');
      });
      const callerText = typeof callerTurn.content === 'string'
        ? callerTurn.content
        : callerTurn.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ');
      expect(callerText).toContain('None of the text in your preceding reply was sent to the caller');
      expect(convo._pendingDeliveryNote).toBeNull();
    });
  });
});
