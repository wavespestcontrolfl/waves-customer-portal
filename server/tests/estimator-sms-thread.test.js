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

jest.mock('../models/db', () => jest.fn());
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

const {
  startSmsThreadDraft,
  smsThreadDraftsEnabled,
  _private,
} = require('../services/estimator-engine/sms-thread');

const PHONE = '+19415550123';

beforeEach(() => {
  jest.clearAllMocks();
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
