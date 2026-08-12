// options.preSendCheck is the canonical messaging pipeline's send-window
// boundary re-check, and it must be awaited as the LAST step before
// c.messages.create() — sendSMS's own internal awaits (redirect check,
// template lookup, customer/location query) can carry a 19:59 ET send past
// the 20:00 cutoff, so any earlier placement re-opens the boundary race
// (codex r2). Fail closed: a throwing check blocks the send.

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
  isEnabled: jest.fn(() => true),
  // Push channel routing reads this at send time; false keeps routing inert
  // so these tests keep asserting the legacy SMS path.
  gateEnvValue: jest.fn(() => false),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
}));
jest.mock('../services/sms-guard', () => ({
  validateOutbound: (...args) => mockValidateOutbound(...args),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const TwilioService = require('../services/twilio');

const TO = '+19415550123';
const FROM = '+19413180000';

describe('TwilioService.sendSMS preSendCheck (provider-handoff gate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    delete process.env.OWNER_SMS_DISABLED;
  });

  test('a passing check sends normally', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck,
    });
    expect(preSendCheck).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.sid).toBe('SM_ok');
  });

  test('a blocked check stops the send before messages.create and carries the deferral fields', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck: () => ({
        ok: false,
        code: 'QUIET_HOURS_HOLD',
        reason: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
        retryable: true,
        deferred: true,
        nextAllowedAt: '2026-08-07T12:00:00.000Z',
      }),
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      sid: null,
      preSendBlocked: true,
      code: 'QUIET_HOURS_HOLD',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });
  });

  test('a throwing check fails closed', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck: () => { throw new Error('window check exploded'); },
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      preSendBlocked: true,
      code: 'PRE_SEND_CHECK_FAILED',
    });
  });

  test('legacy callers without preSendCheck are unaffected', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
