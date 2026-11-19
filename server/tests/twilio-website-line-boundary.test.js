// The website-only line rule at twilio.js's sendSMS dispatch(), next to the
// disclaimed-number hold: the seam every SMS crosses. The send routes, the
// queue and the scheduled dispatcher refuse earlier with their own message;
// this check covers a path that keeps a thread's line and texts a number that
// never contacted it (a dashboard reply that falls back to the customer's
// current phone, an applicant reply, an approved agent draft). The rule's own
// reads are covered in website-line-contact.test.js.

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
  gateEnvValue: jest.fn(() => false),
  gateEnvTimestamp: jest.fn(() => null),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
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
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));
jest.mock('../services/website-line-contact', () => ({
  websiteLineRefusal: jest.fn(async () => null),
}));

const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { websiteLineRefusal } = require('../services/website-line-contact');

const TO = '+19415550123';
const WEB_LINE = '+19412542617';
const REFUSAL = 'That line is shown only on a Waves website.';

describe('TwilioService.sendSMS — the website-only line rule at the provider boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    websiteLineRefusal.mockResolvedValue(null);
  });

  test('a text from a website-only line to a number that never contacted it never reaches Twilio, and is not retried', async () => {
    websiteLineRefusal.mockResolvedValueOnce(REFUSAL);
    const result = await TwilioService.sendSMS(TO, 'Thanks for reaching out', { messageType: 'manual', fromNumber: WEB_LINE });
    expect(websiteLineRefusal).toHaveBeenCalledWith(WEB_LINE, TO, { database: db });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'WEBSITE_LINE_FIRST_CONTACT', error: REFUSAL, retryable: false, deliveryOutcome: 'not_sent',
    });
  });

  test('a check that cannot read refuses too, and the send may be tried again', async () => {
    websiteLineRefusal.mockRejectedValueOnce(new Error('connection reset'));
    const result = await TwilioService.sendSMS(TO, 'Thanks for reaching out', { messageType: 'manual', fromNumber: WEB_LINE });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'WEBSITE_LINE_UNVERIFIED', retryable: true, deliveryOutcome: 'not_sent',
    });
  });

  test('a reply to someone who contacted the line, or any other line, sends normally', async () => {
    const result = await TwilioService.sendSMS(TO, 'Thanks for reaching out', { messageType: 'manual', fromNumber: WEB_LINE });
    expect(result.success).toBe(true);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate.mock.calls[0][0]).toMatchObject({ from: WEB_LINE, to: TO });
  });

  test('inside a caller withSmsHandoff lock the check reads on the held transaction, and a refusal is not retried', async () => {
    const trxSentinel = { __isTrx: true };
    websiteLineRefusal.mockResolvedValueOnce(REFUSAL);
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: WEB_LINE,
      withSmsHandoff: async (dispatch) => { await dispatch(trxSentinel); return { ok: true }; },
    });
    expect(websiteLineRefusal).toHaveBeenCalledWith(WEB_LINE, TO, { database: trxSentinel });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'WEBSITE_LINE_FIRST_CONTACT', retryable: false, deliveryOutcome: 'not_sent' });
  });
});
