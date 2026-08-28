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
const mockOutOfScopeIncidental = jest.fn(() => false);
const mockLoadTriage = jest.fn(async () => null);
jest.mock('../services/estimator-engine/scope-guards', () => ({
  scopeGuardsEnabled: () => mockScopeGuardsEnabled(),
  deterministicOutOfScope: (...args) => mockDeterministicOutOfScope(...args),
  outOfScopeIsIncidental: (...args) => mockOutOfScopeIncidental(...args),
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
  // Re-pin defaults every test — mockReturnValue survives clearAllMocks
  // and would otherwise leak between tests.
  mockDeterministicOutOfScope.mockReturnValue(false);
  mockOutOfScopeIncidental.mockReturnValue(false);
  mockDeterministicOutOfScope.mockImplementation(() => false);
  mockOutOfScopeIncidental.mockImplementation(() => false);
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

  test('a clarify-reply re-draft carries the draft it supersedes into the pipeline context (retired atomically on insert)', async () => {
    const result = await startSmsThreadDraft({
      phone: PHONE, triggerBody: "It's a 2 bedroom", skipIntentGate: true, skipCooldown: true,
      supersedeEstimateId: 'est-1', supersedeReason: 'clarify_bedroom_reply', supersedeAttempt: 'att-1', bedroomCountOverride: 2,
    });
    await result.draftPromise;
    const args = mockRunDraftPipeline.mock.calls[0][0];
    expect(args.context.supersedeEstimateId).toBe('est-1');
    expect(args.context.supersedeAttempt).toBe('att-1');
    expect(args.context.supersedeReason).toBe('clarify_bedroom_reply');
    expect(args.context.bedroomCountOverride).toBe(2);
    // An ordinary thread draft names nothing to supersede (fresh context
    // object — the pipeline stamps the one buildSmsThreadContext returns).
    mockRunDraftPipeline.mockClear();
    mockBuildSmsThreadContext.mockResolvedValueOnce({ call: null, transcript: 'x'.repeat(60), phone: PHONE });
    const plain = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'can I get a quote for pest control', skipIntentGate: true, skipCooldown: true });
    await plain.draftPromise;
    expect(mockRunDraftPipeline.mock.calls[0][0].context.supersedeEstimateId).toBeUndefined();
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

  test('catalog offers bee treatment/honeycomb extraction, not removal; live relocation is NOT OFFERED', async () => {
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    await startSmsThreadDraft({ phone: PHONE, triggerBody: 'how much to deal with bees in the wall?' });
    const prompt = mockDispatch.mock.calls[0][1].text;
    expect(prompt).toContain('wasp/hornet/bee treatment and honeycomb extraction');
    expect(prompt).toContain('live bee relocation');
    expect(prompt).not.toContain('bee removal');
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

  test('an INCIDENTAL trade mention defers to the grounded classifier (no hard veto)', async () => {
    // 'I just had the house pressure washed; how much do you charge for
    // quarterly service?' — deterministic veto matches, incidental check
    // hands the judgment to the classifier, which approves the quote.
    mockDeterministicOutOfScope.mockReturnValue(true);
    mockOutOfScopeIncidental.mockReturnValue(true);
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'I just had the house pressure washed; how much do you charge for quarterly service?',
    });
    expect(result.started).toBe(true);
    expect(mockDispatch).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('precomputedTriage skips the whole ladder — triage and classifier run zero times', async () => {
    // lead-intake's pre-check already ran the ladder on this exact body;
    // the real run must not double the awaited webhook latency.
    const triage = { lines: [], matchedExistingCustomer: false, groundedCustomerId: null };
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'quote for pest control please',
      skipIntentGate: true,
      skipCooldown: true,
      precomputedTriage: triage,
    });
    expect(result.started).toBe(true);
    expect(mockLoadTriage).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockDeterministicOutOfScope).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('scopeCheckOnly returns its triage for reuse', async () => {
    const triage = { lines: [], matchedExistingCustomer: false };
    mockLoadTriage.mockResolvedValueOnce(triage);
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'quote for pest control please',
      skipIntentGate: true,
      scopeCheckOnly: true,
    });
    expect(result.skipped).toBe('scope_check_only');
    expect(result.triage).toBe(triage);
  });

  test('an out-of-scope trigger inside the cooldown window is still TERMINAL', async () => {
    // The cooldown used to return first, reporting operational 'cooldown' —
    // and lead-intake's fallback drafted the out-of-scope work anyway.
    mockRecentBell = { id: 'bell-1' };
    mockDeterministicOutOfScope.mockReturnValueOnce(true);
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'power washing service please',
    });
    expect(result.skipped).toBe('out_of_scope_service');
    expect(result.terminal).toBe(true);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('an in-scope trigger inside the cooldown window still reports cooldown', async () => {
    mockRecentBell = { id: 'bell-1' };
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    expect(result.skipped).toBe('cooldown');
    expect(result.terminal).toBeUndefined();
  });

  test('a correction ANYWHERE after the out-of-scope mention escapes the veto (burst memory)', async () => {
    // 'power washing?' → 'Actually quarterly instead' (never processed —
    // fails the quote-hint prefilter) → 'How much?' — the shorthand joins
    // the burst, but the correction between them hands the judgment to the
    // grounded classifier.
    mockLoadTriage.mockResolvedValueOnce({
      lines: [],
      matchedExistingCustomer: false,
      recentTexts: ['Actually, quarterly instead', 'Do you do power washing?'],
      vetoTexts: ['Actually, quarterly instead', 'Do you do power washing?'],
    });
    mockDeterministicOutOfScope.mockImplementation((text) => /power wash/i.test(text));
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'How much?' });
    expect(result.started).toBe(true);
    expect(mockDispatch).toHaveBeenCalled();
  });

  test('a CORRECTION escapes the burst veto and reaches the grounded classifier', async () => {
    // "Do you do power washing?" → "Actually, quote me for quarterly
    // service instead" — in scope, but 'quarterly'/'service' are not
    // IN_SCOPE_RE nouns, so the joined burst hard-vetoed it.
    mockLoadTriage.mockResolvedValueOnce({
      lines: [],
      matchedExistingCustomer: false,
      recentTexts: ['Do you do power washing?'],
      vetoTexts: ['Do you do power washing?'],
    });
    mockDeterministicOutOfScope.mockImplementation((text) => /power wash/i.test(text));
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'Actually, quote me for quarterly service instead',
    });
    expect(result.started).toBe(true);
    expect(mockDispatch).toHaveBeenCalled();
  });

  test('a bare follow-up after an out-of-scope ask still vetoes (same request)', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: [],
      matchedExistingCustomer: false,
      recentTexts: ['Do you do power washing?'],
      vetoTexts: ['Do you do power washing?'],
    });
    mockDeterministicOutOfScope.mockImplementation((text) => /power wash/i.test(text));
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'how much?' });
    expect(result.skipped).toBe('out_of_scope_service_thread');
    expect(result.terminal).toBe(true);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a correction whose OWN text is out of scope still vetoes', async () => {
    // No mockLoadTriage queue entry: the trigger-body veto fires BEFORE
    // triage loads, so queuing one would leak into the next test.
    mockDeterministicOutOfScope.mockImplementation((text) => /power wash|gutter/i.test(text));
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'Actually, gutter cleaning instead',
    });
    expect(result.skipped).toBe('out_of_scope_service');
    expect(result.terminal).toBe(true);
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
    expect(prompt).toContain('RECENT TEXTS IN THIS THREAD');
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
    // TERMINAL: lead-intake must not fall back to a shell estimate.
    expect(result.terminal).toBe(true);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('mixed-vocabulary clarify resume: the grounded classifier veto still fires', async () => {
    // "power wash my yard" — OUT matches but 'yard' defeats the
    // deterministic veto; the resume must still be scope-checked.
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: false, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'power wash my yard',
      skipIntentGate: true,
      skipCooldown: true,
    });
    expect(result.skipped).toBe('no_quote_intent_ai_out_of_scope');
    // Terminal too: the resume came from lead-intake, whose fallback would
    // otherwise draft the out-of-scope work anyway.
    expect(result.terminal).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('resume honors explicit veto booleans even when quote_request is false', async () => {
    // A compliant "this is just for Friday's visit" answer is exactly
    // quote_request:false + relates_to_existing_job:true — the
    // confident-gated primary branch would wave it through as method 'ai'.
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: true });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: false, service_offered: true, relates_to_existing_job: true, confidence: 0.9 },
    });
    let result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'this is just for Friday\'s visit',
      skipIntentGate: true,
      skipCooldown: true,
    });
    expect(result.skipped).toBe('no_quote_intent_ai_existing_job');
    expect(mockNotify).not.toHaveBeenCalled();

    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: false, service_offered: false, relates_to_existing_job: false, confidence: 0.9 },
    });
    result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'just the driveway cleaning',
      skipIntentGate: true,
      skipCooldown: true,
    });
    expect(result.skipped).toBe('no_quote_intent_ai_out_of_scope');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('primary path semantics unchanged: unconfident vetoes stay method ai', async () => {
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: true });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: false, service_offered: true, relates_to_existing_job: true, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    expect(result.skipped).toBe('no_quote_intent_ai');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('a LOW-CONFIDENCE resume veto is not terminal — the draft proceeds', async () => {
    // Resume vetoes are TERMINAL to lead-intake, which then suppresses its
    // fallback — a 0.2-confidence guess must not leave an established
    // quote request with no draft and no durable task.
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: false, service_offered: false, relates_to_existing_job: false, confidence: 0.2 },
    });
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'the back lanai please',
      skipIntentGate: true,
      skipCooldown: true,
    });
    expect(result.started).toBe(true);
    expect(result.terminal).toBeUndefined();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('classifier trouble on a resume fails OPEN (quote already owed)', async () => {
    // Asymmetry vs the primary path is deliberate: there, ai_failed is
    // fail-closed; on a resume the intent is established, so the draft
    // proceeds.
    mockLoadTriage.mockResolvedValueOnce({ lines: [], matchedExistingCustomer: false });
    mockDispatch.mockRejectedValueOnce(new Error('llm down'));
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'the back lanai please',
      skipIntentGate: true,
      skipCooldown: true,
    });
    expect(result.started).toBe(true);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('gate off: resumes never consult the classifier (byte-identical)', async () => {
    mockScopeGuardsEnabled.mockReturnValue(false);
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'power wash my yard',
      skipIntentGate: true,
      skipCooldown: true,
    });
    expect(result.started).toBe(true);
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
      groundedScope: { address: '77 Rental Cove', line2: null, city: 'North Port', zip: '34287', isPrimary: false },
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
      groundedConflict: false,
      groundedScope: expect.objectContaining({ address: '77 Rental Cove', isPrimary: false }),
      groundedMultiScope: false,
    }));
  });

  test('a MULTI-SCOPE ambiguity signal rides into the context build', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: ['…Apt 1 matches', '…Apt 6 matches'],
      matchedExistingCustomer: true,
      groundedCustomerId: 'cust-77',
      groundedScope: null,
      groundedMultiScope: true,
    });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'quotes for 100 Palm Ave Apt 1, also 100 Palm Ave Apt 6',
    });
    await result.draftPromise;
    expect(mockBuildSmsThreadContext).toHaveBeenCalledWith(expect.objectContaining({
      groundedMultiScope: true,
      groundedScope: null,
    }));
  });

  test('a distinct-customer conflict rides into the context build', async () => {
    mockLoadTriage.mockResolvedValueOnce({
      lines: ['Sender phone matches: existing active customer A', 'Message thread names address which matches: existing active customer B'],
      matchedExistingCustomer: true,
      groundedCustomerId: null,
      groundedConflict: true,
    });
    mockDispatch.mockResolvedValueOnce({
      ok: true,
      json: { quote_request: true, service_offered: true, relates_to_existing_job: false, confidence: 0.9 },
    });
    const result = await startSmsThreadDraft({
      phone: PHONE,
      triggerBody: 'quote for pest control at 900 Other Property Rd please',
    });
    await result.draftPromise;
    expect(mockBuildSmsThreadContext).toHaveBeenCalledWith(expect.objectContaining({
      groundedCustomerId: null,
      groundedConflict: true,
    }));
  });

  test('gate off: the context build receives NO grounded customer (byte-identical path)', async () => {
    mockScopeGuardsEnabled.mockReturnValue(false);
    const result = await startSmsThreadDraft({ phone: PHONE, triggerBody: 'quote for pest control please' });
    await result.draftPromise;
    expect(mockBuildSmsThreadContext).toHaveBeenCalledWith(expect.objectContaining({
      groundedCustomerId: null,
      groundedConflict: false,
      groundedScope: null,
      groundedMultiScope: false,
    }));
  });
});
