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
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}) }));
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
    expect(result.deliveryOutcome).toBe('accepted');
  });

  test('direct SMS callers strip external links without changing provider callback URLs', async () => {
    const body = 'Review: https://g.page/r/demo/review';
    const result = await TwilioService.sendSMS(TO, body, {
      messageType: 'manual', fromNumber: FROM,
    });
    expect(result.success).toBe(true);
    expect(mockTwilioCreate.mock.calls[0][0]).toMatchObject({
      body: 'Review: g.page/r/demo/review',
      statusCallback: expect.stringMatching(/^https:\/\//),
    });
  });

  test('MMS captions and media fetch URLs preserve their HTTPS schemes', async () => {
    const body = 'Photo: https://example.com/photo';
    await TwilioService.sendSMS(TO, body, {
      messageType: 'manual', fromNumber: FROM, mediaUrls: ['https://example.com/photo.jpg'],
    });
    expect(mockTwilioCreate.mock.calls[0][0]).toMatchObject({
      body, mediaUrl: ['https://example.com/photo.jpg'],
    });
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

  test('handoff locks enclose only the SDK call; log time follows lock acquisition', async () => {
    const events = [];
    const acquiredAt = new Date('2026-01-01T15:00:02Z');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T15:00:00Z'));
    require('../models/db').mockImplementation(table => ({ insert: async row => {
      events.push(table);
      expect(row.created_at).toEqual(acquiredAt);
    } }));
    mockTwilioCreate.mockImplementation(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
        withSmsHandoff: async dispatch => {
          events.push('locked');
          jest.setSystemTime(acquiredAt);
          await dispatch();
          events.push('released');
          return { ok: true };
        },
      });
      expect(result.success).toBe(true);
      expect(events).toEqual(['locked', 'sdk', 'released', 'sms_log']);
    } finally { jest.useRealTimers(); require('../models/db').mockReset(); }
  });

  test('a stale subject refuses the SDK handoff', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async () => ({ ok: false, code: 'LEAD_SUBJECT_CHANGED' }),
    });
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'LEAD_SUBJECT_CHANGED' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('a guard failure after acceptance preserves the send result', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); throw new Error('commit connection lost'); },
    });
    expect(result).toMatchObject({ success: true, sid: 'SM_ok' });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
  });

  test('an authority lookup error blocks retryably without a provider failure alert', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async () => { throw Object.assign(new Error('connection unavailable'), { code: '08006' }); },
    });
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'SMS_HANDOFF_CHECK_FAILED', retryable: true });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test.each([
    ['timeout', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })],
    ['reset', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })],
    ['HTTP 408', Object.assign(new Error('request timeout'), { status: 408 })],
    ['timeout with an incidental 4xx status', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT', status: 400 })],
    ['HTTP 503', Object.assign(new Error('provider unavailable'), { status: 503 })],
    ['unknown handoff error', new Error('unexpected transport failure')],
  ])('an SDK %s stays uncertain and follows provider failure handling', async (_label, failure) => {
    mockTwilioCreate.mockRejectedValueOnce(failure);
    await expect(TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
    })).rejects.toMatchObject({
      providerOutcome: { sent: false, deliveryOutcome: 'uncertain' },
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('a missing SID remains uncertain (guarded: %s)', async guarded => {
    mockTwilioCreate.mockResolvedValueOnce({});
    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
      ...(guarded ? { withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; } } : {}),
    })).rejects.toMatchObject({ providerOutcome: { sent: false, deliveryOutcome: 'uncertain' } });
  });

  test('a provider 4xx is a definitive retryable/non-retryable rejection', async () => {
    mockTwilioCreate.mockRejectedValueOnce(Object.assign(new Error('too many requests'), { code: 20429, status: 429 }));

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
    })).rejects.toMatchObject({
      status: 429,
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });
  });

  test('a pre-provider 5xx-shaped exception is still definitive non-delivery', async () => {
    jest.spyOn(TwilioService, 'deriveOutboundNumber').mockRejectedValueOnce(
      Object.assign(new Error('location lookup unavailable'), { status: 503 }),
    );

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
    })).rejects.toMatchObject({
      status: 503,
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('an exception after an accepted SDK response preserves acceptance provenance', async () => {
    require('../services/conversations').recordTouchpoint.mockImplementationOnce(() => {
      throw Object.assign(new Error('touchpoint module failed'), { status: 503 });
    });

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
    })).rejects.toMatchObject({
      providerOutcome: {
        sent: true,
        deliveryOutcome: 'accepted',
        providerMessageId: 'SM_ok',
      },
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
  });

  test('a guarded send cannot escape through explicit push routing', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      explicitPushOnly: true, withSmsHandoff: jest.fn(),
    });
    expect(result).toMatchObject({ success: false, code: 'UNSUPPORTED_SMS_HANDOFF' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });
});
