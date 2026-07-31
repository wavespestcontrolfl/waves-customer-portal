/**
 * Estimator SMS-thread entry (GATE_ESTIMATOR_SMS_DRAFTS).
 *
 * Pins: the double gate (SMS flag AND engine flag), the cheap trigger
 * ladder (regex prefilter → FAST classifier, fail-closed), the durability
 * contract (the awaited phase inserts ONE owed-quote bell on the
 * phone-scoped thread key BEFORE any detached composer work), the
 * triggering text riding into the context build, the unreadable-thread red
 * bell, and that there is NO phone-only duplicate precheck — the
 * draft-time guard owns duplicates so different-property quotes survive.
 */

// Chainable stub for the cooldown lookup (notifications table); tests set
// mockRecentBell to simulate a run inside the cooldown window.
let mockRecentBell = null;
jest.mock('../models/db', () => {
  const chain = {
    whereRaw: () => chain,
    where: () => chain,
    orderBy: () => chain,
    first: async () => mockRecentBell,
  };
  return jest.fn(() => chain);
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: (...args) => mockDispatch(...args),
}));
jest.mock('../config/models', () => ({
  TEXT_POLICIES: { fastStructured: 'fast-structured-policy' },
}));

const mockRunDraftPipeline = jest.fn();
const mockNotify = jest.fn();
const mockEngineEnabled = jest.fn();
jest.mock('../services/estimator-engine/index', () => ({
  runDraftPipeline: (...args) => mockRunDraftPipeline(...args),
  notify: (...args) => mockNotify(...args),
  estimatorEngineEnabled: () => mockEngineEnabled(),
}));

const mockBuildSmsThreadContext = jest.fn();
jest.mock('../services/estimator-engine/context-builder', () => ({
  buildSmsThreadContext: (...args) => mockBuildSmsThreadContext(...args),
}));

// Scope guards (GATE_ESTIMATOR_SCOPE_GUARDS) — controllable per test; the
// default (disabled, no veto, no triage) preserves the legacy path for
// every pre-existing test in this file.
const mockScopeGuardsEnabled = jest.fn(() => false);
const mockDeterministicOutOfScope = jest.fn(() => false);
const mockLoadTriage = jest.fn(async () => null);
jest.mock('../services/estimator-engine/scope-guards', () => ({
  scopeGuardsEnabled: () => mockScopeGuardsEnabled(),
  deterministicOutOfScope: (...args) => mockDeterministicOutOfScope(...args),
  loadThreadTriageContext: (...args) => mockLoadTriage(...args),
}));

const {
  startSmsThreadDraft,
  smsThreadDraftsEnabled,
  _private,
} = require('../services/estimator-engine/sms-thread');

const PHONE = '+19415550123';

beforeEach(() => {
  jest.clearAllMocks();
  mockRecentBell = null;
  process.env.GATE_ESTIMATOR_SMS_DRAFTS = 'true';
  mockEngineEnabled.mockReturnValue(true);
  mockDispatch.mockResolvedValue({ ok: true, json: { quote_request: true, confidence: 0.9 } });
  mockBuildSmsThreadContext.mockResolvedValue({ call: null, transcript: 'x'.repeat(60), phone: PHONE });
  mockRunDraftPipeline.mockImplementation(async ({ result }) => ({ ...result, lane: 'yellow', created: true }));
  mockNotify.mockResolvedValue(true);
});

afterAll(() => {
  delete process.env.GATE_ESTIMATOR_SMS_DRAFTS;
});

describe('smsThreadDraftsEnabled', () => {
  test('requires BOTH the SMS flag and the engine flag', () => {
    expect(smsThreadDraftsEnabled()).toBe(true);
    mockEngineEnabled.mockReturnValue(false);
    expect(smsThreadDraftsEnabled()).toBe(false);
    mockEngineEnabled.mockReturnValue(true);
    process.env.GATE_ESTIMATOR_SMS_DRAFTS = 'false';
    expect(smsThreadDraftsEnabled()).toBe(false);
  });
});

describe('startSmsThreadDraft', () => {
  test('gate off skips before any work', async () => {
    delete process.env.GATE_ESTIMATOR_SMS_DRAFTS;
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'how much for pest control?' });
    expect(result.started).toBe(false);
    expect(result.skipped).toBe('gate_off');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('non-quote chatter never reaches the classifier, a bell, or the engine', async () => {
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'Thanks! See you tomorrow.' });
    expect(result.skipped).toBe('no_quote_intent_regex');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('classifier rejection (or failure) fails closed', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { quote_request: false, confidence: 0.9 } });
    let result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'is my service scheduled? no ants lately' });
    expect(result.skipped).toBe('no_quote_intent_ai');
    mockDispatch.mockRejectedValueOnce(new Error('llm down'));
    result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'can I get a quote for pest control' });
    expect(result.skipped).toBe('no_quote_intent_ai_failed');
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('the durable owed-quote bell lands in the AWAITED phase, before the detached composer', async () => {
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'what would a quote for pest control run me?' });
    expect(result.started).toBe(true);
    // Bell was inserted synchronously (thread-keyed), before draftPromise
    // resolution — this is the restart-loss guarantee.
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      threadKey: 'sms:9415550123',
      title: 'Quote asked by text — send it',
      quotePromised: true,
    }));
    const draft = await result.draftPromise;
    expect(draft.created).toBe(true);
    const args = mockRunDraftPipeline.mock.calls[0][0];
    expect(args.origin.channel).toBe('sms_thread');
    expect(args.origin.threadKey).toBe('sms:9415550123');
    expect(args.quotePromised).toBe(true);
    expect(args.context.origin).toBe(args.origin);
  });

  test('the triggering text rides into the context build (sms_log races the webhook insert)', async () => {
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'what would a quote for pest control run me?' });
    await result.draftPromise;
    expect(mockBuildSmsThreadContext).toHaveBeenCalledWith(expect.objectContaining({
      triggerBody: 'what would a quote for pest control run me?',
    }));
  });

  test('unreadable thread bells red on the thread key from the detached phase', async () => {
    mockBuildSmsThreadContext.mockResolvedValueOnce({ error: 'ambiguous_phone' });
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'how much is quarterly pest control' });
    const draft = await result.draftPromise;
    expect(draft.lane).toBe('red');
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      threadKey: 'sms:9415550123',
      lane: 'red',
      body: expect.stringContaining('ambiguous_phone'),
    }));
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('a run inside the cooldown window skips before any paid call', async () => {
    // The durable bell doubles as the per-phone claim: repeated quote-y
    // texts must not burn FAST/DEEP runs while a run already started.
    mockRecentBell = { id: 'bell-1' };
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    expect(result.started).toBe(false);
    expect(result.skipped).toBe('cooldown');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('a failed durable bell reports not-started — callers keep their fallback', async () => {
    // notify() returning false means NO restart-loss artifact exists; the
    // handoff must not detach the composer or let lead-intake drop its
    // shell path on a promise that isn't durably recorded.
    mockNotify.mockResolvedValueOnce(false);
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    expect(result.started).toBe(false);
    expect(result.skipped).toBe('durable_bell_failed');
    expect(result.draftPromise).toBeUndefined();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('skipIntentGate bypasses the classifier for lead-intake handoffs', async () => {
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'anything', skipIntentGate: true });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(result.started).toBe(true);
    await result.draftPromise;
    expect(mockRunDraftPipeline).toHaveBeenCalledTimes(1);
  });

  test('no phone-only duplicate precheck exists — the pipeline always gets its chance', async () => {
    // Multi-property owners text about a second property while an estimate
    // is open; only the composer can read the address, so the address-aware
    // duplicate bypass at draft time must not be short-circuited here.
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for lawn care please' });
    const draft = await result.draftPromise;
    expect(draft.created).toBe(true);
    expect(mockRunDraftPipeline).toHaveBeenCalledTimes(1);
  });
});

describe('_private.threadQuoteSignal', () => {
  test('prefilter passes quote-flavored text to the FAST policy with a webhook-safe timeout', async () => {
    await _private.threadQuoteSignal('how much for mosquito treatment?');
    expect(mockDispatch).toHaveBeenCalledWith('fast-structured-policy', expect.objectContaining({
      jsonMode: true,
      // The Twilio handler awaits this classifier — the dispatcher's
      // default multi-minute budget must never hold the webhook open.
      timeoutMs: 3500,
    }));
  });

  test('low classifier confidence is not a quote request', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { quote_request: true, confidence: 0.4 } });
    const signal = await _private.threadQuoteSignal('price?');
    expect(signal.quoteRequest).toBe(false);
  });
});

describe('scope guards (GATE_ESTIMATOR_SCOPE_GUARDS)', () => {
  beforeEach(() => {
    mockScopeGuardsEnabled.mockReturnValue(true);
  });

  test('deterministic out-of-scope veto skips before any model call or bell', async () => {
    mockDeterministicOutOfScope.mockReturnValueOnce(true);
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'I would like to know if you available for power washing service',
    });
    expect(result.skipped).toBe('out_of_scope_service');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockLoadTriage).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('triage grounding rides into the classifier prompt', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: ['Message thread names address "4021 Coral…" which matches: existing active customer Pat Homeowner, 4021 Coral Bay Loop — booked: Quarterly Pest Control Service 2026-08-01 (pending)'],
      matchedExistingCustomer: true,
    });
    await startSmsThreadDraft({ phone: PHONE, triggerBody: 'can you spray for spiders at 4021 Coral Bay Loop before Saturday?' });
    const prompt = mockDispatch.mock.calls[0][1].text;
    expect(prompt).toContain('SERVICES WAVES OFFERS');
    expect(prompt).toContain('NOT OFFERED: power washing');
    expect(prompt).toContain('Pat Homeowner');
    expect(prompt).toContain('relates_to_existing_job');
  });

  test('grounded classifier vetoes: not-offered service never bells', async () => {
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: false, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'how much to pressure treat my deck service' });
    expect(result.skipped).toBe('no_quote_intent_ai_out_of_scope');
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('grounded classifier vetoes: existing-job coordination never bells', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: ['Message thread names address "4021 Coral…" which matches: existing active customer Pat Homeowner'],
      matchedExistingCustomer: true,
    });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: true, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'this is the property coordinator for Pat Homeowner at 4021 Coral Bay Loop, can you spray before Saturday?',
    });
    expect(result.skipped).toBe('no_quote_intent_ai_existing_job');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('an out-of-scope ask living in an EARLIER text vetoes the thread', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: [],
      matchedExistingCustomer: false,
      recentTexts: ['Do you do power washing?'],
      vetoTexts: ['Do you do power washing?'],
    });
    // The real veto sees "power washing" only in the combined thread text.
    mockDeterministicOutOfScope.mockImplementation((text) => /power washing/i.test(text));
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'How much would that cost?' });
    expect(result.skipped).toBe('out_of_scope_service_thread');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('a STALE out-of-scope mention (outside the burst window) never hard-vetoes', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: [],
      matchedExistingCustomer: false,
      recentTexts: ['Do you do power washing?'],
      vetoTexts: [],
    });
    mockDeterministicOutOfScope.mockImplementation((text) => /power washing/i.test(text));
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'Can I get that quote?' });
    expect(result.started).toBe(true);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('recent texts ride into the grounded classifier prompt', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: [],
      matchedExistingCustomer: false,
      recentTexts: ['we talked about the spiders yesterday'],
    });
    await startSmsThreadDraft({ phone: PHONE, triggerBody: 'how much for that treatment?' });
    const prompt = mockDispatch.mock.calls[0][1].text;
    expect(prompt).toContain('RECENT TEXTS FROM THIS NUMBER');
    expect(prompt).toContain('spiders yesterday');
  });

  test('a grounded response missing the veto booleans fails closed (no bell)', async () => {
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { quote_request: true, confidence: 0.9 } });
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    expect(result.skipped).toBe('no_quote_intent_ai_malformed_grounded');
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('a clean grounded yes still bells and drafts (guards must not eat real leads)', async () => {
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'how much for quarterly pest control?' });
    expect(result.started).toBe(true);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    await result.draftPromise;
    expect(mockRunDraftPipeline).toHaveBeenCalledTimes(1);
  });

  test('triage failure falls back to the ungrounded prompt (fail-open)', async () => {
    mockLoadTriage.mockResolvedValueOnce(null);
    await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    const prompt = mockDispatch.mock.calls[0][1].text;
    expect(prompt).not.toContain('SERVICES WAVES OFFERS');
  });

  test('clarify resumes (skipIntentGate) still hit the scope vetoes', async () => {
    mockDeterministicOutOfScope.mockReturnValueOnce(true);
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'power washing please',
      skipIntentGate: true,
      skipCooldown: true,
    });
    expect(result.skipped).toBe('out_of_scope_service');
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('gate off never consults the guards (dark ship)', async () => {
    mockScopeGuardsEnabled.mockReturnValue(false);
    await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    expect(mockDeterministicOutOfScope).not.toHaveBeenCalled();
    expect(mockLoadTriage).not.toHaveBeenCalled();
    const prompt = mockDispatch.mock.calls[0][1].text;
    expect(prompt).not.toContain('SERVICES WAVES OFFERS');
  });

  test('triage groundedCustomerId rides into the draft context build', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: ['Message thread names address "4021 Coral…" which matches: existing active customer Pat Homeowner'],
      matchedExistingCustomer: true,
      groundedCustomerId: 'cust-77',
    });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'the coordinator here — can we also get mosquito treatment quoted at 4021 Coral Bay Loop?',
    });
    await result.draftPromise;
    expect(mockBuildSmsThreadContext).toHaveBeenCalledWith(expect.objectContaining({
      groundedCustomerId: 'cust-77',
    }));
  });

  test('gate off: the context build receives NO grounded customer (byte-identical path)', async () => {
    mockScopeGuardsEnabled.mockReturnValue(false);
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    await result.draftPromise;
    expect(mockBuildSmsThreadContext).toHaveBeenCalledWith(expect.objectContaining({
      groundedCustomerId: null,
    }));
  });
});
