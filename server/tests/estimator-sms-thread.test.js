/**
 * Estimator SMS-thread entry (GATE_ESTIMATOR_SMS_DRAFTS).
 *
 * Pins: the double gate (SMS flag AND engine flag), the cheap trigger
 * ladder (regex prefilter → FAST classifier → engine, fail-closed), the
 * open-automated-estimate precheck that skips before any model call, the
 * unreadable-thread red bell keyed on the phone-scoped thread key, and the
 * happy-path handoff into the shared pipeline with the SMS origin.
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

const mockDuplicateCheck = jest.fn();
jest.mock('../services/estimate-automation-duplicates', () => ({
  blockIfAutomatedEstimateDuplicate: (...args) => mockDuplicateCheck(...args),
}));

const {
  maybeDraftEstimateForSmsThread,
  smsThreadDraftsEnabled,
  _private,
} = require('../services/estimator-engine/sms-thread');

const PHONE = '+19415550123';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_ESTIMATOR_SMS_DRAFTS = 'true';
  mockEngineEnabled.mockReturnValue(true);
  mockDuplicateCheck.mockResolvedValue(null);
  mockDispatch.mockResolvedValue({ ok: true, json: { quote_request: true, confidence: 0.9 } });
  mockBuildSmsThreadContext.mockResolvedValue({ call: null, transcript: 'x'.repeat(60), phone: PHONE });
  mockRunDraftPipeline.mockImplementation(async ({ result }) => ({ ...result, lane: 'yellow', created: true }));
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

describe('maybeDraftEstimateForSmsThread', () => {
  test('gate off skips before any work', async () => {
    delete process.env.GATE_ESTIMATOR_SMS_DRAFTS;
    const result = await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'how much for pest control?' });
    expect(result.skipped).toBe('gate_off');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('non-quote chatter never reaches the classifier or the engine', async () => {
    const result = await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'Thanks! See you tomorrow.' });
    expect(result.skipped).toBe('no_quote_intent_regex');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('classifier rejection (or failure) fails closed', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { quote_request: false, confidence: 0.9 } });
    let result = await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'is my service scheduled? no ants lately' });
    expect(result.skipped).toBe('no_quote_intent_ai');
    mockDispatch.mockRejectedValueOnce(new Error('llm down'));
    result = await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'can I get a quote for pest control' });
    expect(result.skipped).toBe('no_quote_intent_ai_failed');
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('the triggering text rides into the context build (sms_log races the webhook insert)', async () => {
    await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'what would a quote for pest control run me?' });
    expect(mockBuildSmsThreadContext).toHaveBeenCalledWith(expect.objectContaining({
      triggerBody: 'what would a quote for pest control run me?',
    }));
  });

  test('an open estimate on the phone does NOT precheck-skip — the draft-time guard owns duplicates', async () => {
    // Multi-property owners text about a second property while an estimate
    // is open; only the composer can read the address, so the address-aware
    // duplicate bypass at draft time must get its chance.
    mockDuplicateCheck.mockResolvedValue({ blocked: true, existingEstimateId: 'est-1' });
    const result = await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'quote for lawn care please' });
    expect(result.created).toBe(true);
    expect(mockRunDraftPipeline).toHaveBeenCalledTimes(1);
  });

  test('unreadable thread bells red on the phone-scoped thread key', async () => {
    mockBuildSmsThreadContext.mockResolvedValueOnce({ error: 'ambiguous_phone' });
    const result = await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'how much is quarterly pest control' });
    expect(result.lane).toBe('red');
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      threadKey: 'sms:9415550123',
      lane: 'red',
      body: expect.stringContaining('ambiguous_phone'),
    }));
    expect(mockRunDraftPipeline).not.toHaveBeenCalled();
  });

  test('happy path runs the shared pipeline with the SMS origin', async () => {
    const result = await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'what would a quote for pest control run me?' });
    expect(result.created).toBe(true);
    expect(mockRunDraftPipeline).toHaveBeenCalledTimes(1);
    const args = mockRunDraftPipeline.mock.calls[0][0];
    expect(args.origin.channel).toBe('sms_thread');
    expect(args.origin.threadKey).toBe('sms:9415550123');
    expect(args.quotePromised).toBe(true);
    expect(args.context.origin).toBe(args.origin);
  });

  test('skipIntentGate bypasses the classifier for lead-intake handoffs', async () => {
    await maybeDraftEstimateForSmsThread({ phone: PHONE, triggerBody: 'anything', skipIntentGate: true });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRunDraftPipeline).toHaveBeenCalledTimes(1);
  });
});

describe('_private.threadQuoteSignal', () => {
  test('prefilter passes quote-flavored text to the FAST policy', async () => {
    await _private.threadQuoteSignal('how much for mosquito treatment?');
    expect(mockDispatch).toHaveBeenCalledWith('fast-structured-policy', expect.objectContaining({
      jsonMode: true,
    }));
  });

  test('low classifier confidence is not a quote request', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { quote_request: true, confidence: 0.4 } });
    const signal = await _private.threadQuoteSignal('price?');
    expect(signal.quoteRequest).toBe(false);
  });
});
