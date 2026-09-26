// callback_number_needed — the disclaimed-number hold at twilio.js's
// sendSMS dispatch(), the LAST await before messages.create() (PR #4807
// codex round 6, structural). sendCustomerMessage checks the same predicate
// earlier, but dozens of legacy callers reach sendSMS directly (review
// requests, billing, booking/estimate public routes, …); this is the one
// seam every SMS in the repo crosses, so a disclaimed number can't be
// texted by a sender that bypasses the canonical pipeline either.

const mockTwilioCreate = jest.fn();
const mockValidateOutbound = jest.fn(() => ({ ok: true }));

jest.mock('twilio', () => jest.fn(() => ({
  messages: { create: mockTwilioCreate },
})));
jest.mock('../config', () => ({
  twilio: {
    accountSid: 'AC_test',
    authToken: 'auth_test',
    verifyServiceSid: 'VA_test',
  },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(gate => gate !== 'smsGratitudeReplies'),
  // Push channel routing reads this at send time; false keeps routing inert
  // so these tests keep asserting the legacy SMS path.
  gateEnvValue: jest.fn(() => false),
  gateEnvTimestamp: jest.fn(() => null),
}));
jest.mock('../models/db', () => jest.fn());
// Codex round 3 on #4608 (structural move, P1 PRRT_kwDOR3YQi86j8Ydm): the
// annual-offer guard's AUTHORITATIVE check now lives inside sendSMS's own
// dispatch(), the true provider boundary. Mocked transparently (always
// allowed) by default so every existing test in this file — none of whose
// bodies carry an estimate link — is unaffected; the tests below override it.
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  // Round 8 P1: default no-op (nothing rewritten) so every existing test
  // in this file is unaffected; the withheldLinkPolicy tests below override it.
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
}));
jest.mock('../services/sms-guard', () => ({
  validateOutbound: (...args) => mockValidateOutbound(...args),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}) }));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// The predicate under test's wiring — its own row logic is covered in
// callback-number-hold-boundary.test.js.
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));

const TwilioService = require('../services/twilio');
const { disclaimedNumberBlocksSend } = require('../services/disclaimed-number-holds');

const TO = '+19415550123';
const FROM = '+19413180000';

describe('TwilioService.sendSMS — disclaimed-number hold at the provider boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    disclaimedNumberBlocksSend.mockResolvedValue(false);
    delete process.env.OWNER_SMS_DISABLED;
  });

  test('a DIRECT (non-pipeline) caller texting a disclaimed number never reaches Twilio — retryable, never-attempted refusal', async () => {
    disclaimedNumberBlocksSend.mockResolvedValueOnce(true);
    const result = await TwilioService.sendSMS(TO, 'Thanks for choosing Waves!', { messageType: 'review_request', fromNumber: FROM });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'CALLBACK_NUMBER_HOLD', retryable: true, deliveryOutcome: 'not_sent',
    });
    expect(disclaimedNumberBlocksSend).toHaveBeenCalledWith(expect.objectContaining({ to: TO }));
  });

  test('not held → sends normally', async () => {
    const result = await TwilioService.sendSMS(TO, 'Thanks for choosing Waves!', { messageType: 'review_request', fromNumber: FROM });
    expect(result.success).toBe(true);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
  });

  test('a hold that lands AFTER the caller\'s preSendCheck passed still stops the send (checked after it, inside dispatch)', async () => {
    const events = [];
    const preSendCheck = jest.fn(async () => { events.push('preSendCheck'); return { ok: true }; });
    disclaimedNumberBlocksSend.mockImplementationOnce(async () => { events.push('hold'); return true; });
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM, preSendCheck });
    expect(events).toEqual(['preSendCheck', 'hold']);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, code: 'CALLBACK_NUMBER_HOLD', retryable: true });
  });

  test('inside a caller withSmsHandoff lock the read runs on the HELD transaction, and a hold maps to a retryable handoff refusal', async () => {
    const trxSentinel = { __isTrx: true };
    disclaimedNumberBlocksSend.mockResolvedValueOnce(true);
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async (dispatch) => { await dispatch(trxSentinel); return { ok: true }; },
    });
    expect(disclaimedNumberBlocksSend).toHaveBeenCalledWith({ to: TO, conn: trxSentinel });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'CALLBACK_NUMBER_HOLD', retryable: true, deliveryOutcome: 'not_sent' });
  });
});
