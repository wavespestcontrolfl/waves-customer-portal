jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(),
}));

const TwilioService = require('../services/twilio');
const { sendViaTwilio, _internals } = require('../services/messaging/providers/twilio-sms');
const { _internals: sendInternals } = require('../services/messaging/send-customer-message');

function baseInput(overrides = {}) {
  return {
    to: '+15551230000',
    body: 'Hello from Waves',
    channel: 'sms',
    audience: 'lead',
    purpose: 'conversational',
    entryPoint: 'test_sms',
    metadata: {},
    ...overrides,
  };
}

describe('Twilio messaging provider adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    TwilioService.sendSMS.mockResolvedValue({ success: true, sid: 'SM123', deliveryOutcome: 'accepted' });
  });

  test('does not forward media URLs for automated sends without explicit authorization', async () => {
    await sendViaTwilio(baseInput({
      metadata: {
        original_message_type: 'auto_reply',
        mediaUrls: ['https://example.com/logo.png'],
      },
    }));

    expect(TwilioService.sendSMS).toHaveBeenCalledWith(
      '+15551230000',
      'Hello from Waves',
      expect.objectContaining({
        mediaUrls: undefined,
      }),
    );
  });

  test('forwards media URLs when the caller explicitly authorizes media', async () => {
    await sendViaTwilio(baseInput({
      metadata: {
        original_message_type: 'service_report_v1',
        mediaUrls: ['https://cdn.example.com/report.jpg'],
        allowMediaUrls: true,
      },
    }));

    expect(TwilioService.sendSMS).toHaveBeenCalledWith(
      '+15551230000',
      'Hello from Waves',
      expect.objectContaining({
        mediaUrls: ['https://cdn.example.com/report.jpg'],
      }),
    );
  });

  test('returns sanitized provider details when Twilio throws', async () => {
    const err = new Error('The To number +15551230000 is not a valid mobile number.');
    err.code = 21614;
    err.status = 400;
    err.providerOutcome = { sent: false, deliveryOutcome: 'not_sent' };
    TwilioService.sendSMS.mockRejectedValueOnce(err);

    const result = await sendViaTwilio(baseInput());

    expect(result).toMatchObject({
      sent: false,
      provider: 'twilio',
      error: expect.stringContaining('Twilio 21614'),
      retryable: false,
      terminal: true,
      providerErrorCode: '21614',
      providerHttpStatus: 400,
      deliveryOutcome: 'not_sent',
    });
    expect(result.error).toContain('[redacted-phone]');
    expect(result.error).not.toContain('+15551230000');
  });

  test('prefers wrapped providerError details from the Twilio service', async () => {
    const err = new Error('Failed to send SMS: Twilio 30008');
    err.providerError = 'Twilio 30008: Unknown error for +15551230000';
    err.providerOutcome = { sent: false, deliveryOutcome: 'uncertain' };
    TwilioService.sendSMS.mockRejectedValueOnce(err);

    const result = await sendViaTwilio(baseInput());

    expect(result.error).toBe('Twilio 30008: Unknown error for [redacted-phone]');
  });

  test('classifies rate limits and server errors as retryable', async () => {
    const rateLimit = new Error('Too many requests');
    rateLimit.code = 20429;
    rateLimit.status = 429;

    expect(_internals.classifyProviderFailure(rateLimit)).toMatchObject({
      retryable: true,
      terminal: false,
      twilioCode: '20429',
      httpStatus: 429,
      retryAfterMs: 5 * 60 * 1000,
    });

    const serverError = new Error('Internal server error');
    serverError.status = 503;
    expect(_internals.classifyProviderFailure(serverError)).toMatchObject({
      retryable: true,
      terminal: false,
      httpStatus: 503,
    });
  });

  test.each([
    [new Error('socket hang up'), undefined],
    [Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }), undefined],
    [Object.assign(new Error('provider unavailable'), { status: 503 }), 503],
  ])('keeps a %s handoff failure uncertain', async (err, providerHttpStatus) => {
    err.providerOutcome = { sent: false, deliveryOutcome: 'uncertain' };
    TwilioService.sendSMS.mockRejectedValueOnce(err);

    const result = await sendViaTwilio(baseInput());

    expect(result).toMatchObject({
      sent: false,
      provider: 'twilio',
      deliveryOutcome: 'uncertain',
      retryable: true,
      terminal: false,
      retryAfterMs: 5 * 60 * 1000,
    });
    expect(result.providerHttpStatus).toBe(providerHttpStatus ?? null);
  });

  test('keeps a proven 429 rejection retryable while marking it not sent', async () => {
    const err = Object.assign(new Error('too many requests'), {
      code: 20429,
      status: 429,
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });
    TwilioService.sendSMS.mockRejectedValueOnce(err);

    expect(await sendViaTwilio(baseInput())).toMatchObject({
      sent: false,
      deliveryOutcome: 'not_sent',
      retryable: true,
      terminal: false,
      providerErrorCode: '20429',
      providerHttpStatus: 429,
    });
  });

  test('does not infer definitive non-delivery from an unproven status', async () => {
    TwilioService.sendSMS.mockRejectedValueOnce(Object.assign(new Error('preparation failed'), { status: 400 }));

    expect(await sendViaTwilio(baseInput())).toMatchObject({
      sent: false,
      deliveryOutcome: 'uncertain',
      providerHttpStatus: 400,
    });
  });

  test('preserves known acceptance when the Twilio service throws afterward', async () => {
    const err = Object.assign(new Error('post-send bookkeeping failed'), {
      providerOutcome: {
        sent: true,
        provider: 'twilio',
        deliveryOutcome: 'accepted',
        providerMessageId: 'SM123',
        sentAt: '2026-09-10T15:00:00.000Z',
      },
    });
    TwilioService.sendSMS.mockRejectedValueOnce(err);

    expect(await sendViaTwilio(baseInput())).toMatchObject({
      sent: true,
      deliveryOutcome: 'accepted',
      providerMessageId: 'SM123',
      sentAt: '2026-09-10T15:00:00.000Z',
    });
  });

  test('classifies unsuccessful provider results using their returned error', async () => {
    TwilioService.sendSMS.mockResolvedValueOnce({
      success: false,
      error: 'HTTP 503: Twilio service unavailable',
    });

    const result = await sendViaTwilio(baseInput());

    expect(result).toMatchObject({
      sent: false,
      deliveryOutcome: 'uncertain',
      retryable: true,
      terminal: false,
      providerHttpStatus: 503,
    });
    expect(result.error).toBe('HTTP 503: Twilio service unavailable');
  });

  test('preserves definitive non-delivery when Twilio is not configured', async () => {
    TwilioService.sendSMS.mockResolvedValueOnce({
      success: false,
      deliveryOutcome: 'not_sent',
      error: 'Twilio not configured',
    });

    expect(await sendViaTwilio(baseInput())).toMatchObject({
      sent: false,
      deliveryOutcome: 'not_sent',
    });
  });

  test('an unproven legacy success remains uncertain', async () => {
    TwilioService.sendSMS.mockResolvedValueOnce({ success: true, sid: 'SM-legacy' });

    expect(await sendViaTwilio(baseInput())).toMatchObject({
      sent: true,
      deliveryOutcome: 'uncertain',
    });
  });

  test('forwards the preSendCheck hook to TwilioService.sendSMS', async () => {
    const preSendCheck = jest.fn(() => ({ ok: true }));
    await sendViaTwilio(baseInput(), { preSendCheck });
    expect(TwilioService.sendSMS).toHaveBeenCalledWith(
      '+15551230000',
      'Hello from Waves',
      expect.objectContaining({ preSendCheck }),
    );
  });

  test('forwards the local handoff and preserves its authority-block classification', async () => {
    const withSmsHandoff = jest.fn();
    TwilioService.sendSMS.mockResolvedValue({ success: false, preSendBlocked: true,
      code: 'LEAD_SUBJECT_CHANGED', validator: 'check_sms_handoff_authority' });
    expect(await sendViaTwilio(baseInput(), { withSmsHandoff })).toMatchObject({
      sent: false, blocked: true, code: 'LEAD_SUBJECT_CHANGED', validator: 'check_sms_handoff_authority',
    });
    expect(TwilioService.sendSMS.mock.calls[0][2].withSmsHandoff).toBe(withSmsHandoff);
  });

  test('maps a preSendBlocked result onto the blocked/deferral contract, not a provider failure', async () => {
    TwilioService.sendSMS.mockResolvedValue({
      success: false,
      sid: null,
      preSendBlocked: true,
      code: 'QUIET_HOURS_HOLD',
      error: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });
    const res = await sendViaTwilio(baseInput(), { preSendCheck: () => ({ ok: false }) });
    expect(res.sent).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.deliveryOutcome).toBe('not_sent');
    expect(res.code).toBe('QUIET_HOURS_HOLD');
    expect(res.retryable).toBe(true);
    expect(res.deferred).toBe(true);
    expect(res.nextAllowedAt).toBe('2026-08-07T12:00:00.000Z');
    // Must not be classified as a Twilio provider failure.
    expect(res.providerErrorCode).toBeUndefined();
  });

  test('maps the owned-number recipient guard onto the blocked contract, never a provider failure', async () => {
    TwilioService.sendSMS.mockResolvedValue({
      success: false,
      sid: null,
      blocked: true,
      guardBlocked: true,
      code: 'OWNED_NUMBER_RECIPIENT',
      error: 'Recipient is a Waves-owned Twilio number, not a customer (would fail Twilio 21266)',
    });
    const res = await sendViaTwilio(baseInput({ to: '+19412975749' }));
    expect(res).toMatchObject({ sent: false, blocked: true, code: 'OWNED_NUMBER_RECIPIENT', validator: 'check_owned_number_recipient' });
    expect(res.deliveryOutcome).toBe('not_sent');
    expect(res.retryable).toBe(false);
    expect(res.deferred).toBe(false);
    expect(res.providerErrorCode).toBeUndefined();
  });

  test('exposes the same media authorization logic for direct unit coverage', () => {
    expect(_internals.providerMediaUrls(baseInput({
      metadata: { mediaUrls: ['https://example.com/a.jpg'] },
    }))).toBeUndefined();

    expect(_internals.providerMediaUrls(baseInput({
      metadata: { mediaUrls: ['https://example.com/a.jpg'], adminUserId: 'admin-1' },
    }))).toEqual(['https://example.com/a.jpg']);
  });

  test('blocks media-only messages without explicit media authorization', () => {
    expect(sendInternals.validateContract(baseInput({
      body: '',
      metadata: { mediaUrls: ['https://example.com/a.jpg'] },
    }))).toEqual({
      ok: false,
      reason: 'media-only SMS requires explicit media authorization',
    });

    expect(sendInternals.validateContract(baseInput({
      body: '',
      metadata: {
        mediaUrls: ['https://example.com/a.jpg'],
        allowMediaUrls: true,
      },
    }))).toEqual({ ok: true });
  });

  test('computes provider retry time from retryAfterMs', () => {
    const now = new Date('2026-05-25T12:00:00.000Z');
    expect(sendInternals.nextProviderRetryAt({ retryable: true, retryAfterMs: 90_000 }, now).toISOString())
      .toBe('2026-05-25T12:01:30.000Z');
    expect(sendInternals.nextProviderRetryAt({ retryable: false }, now)).toBeNull();
  });

  test.each([
    [{ success: true, sid: 'owner-sms-disabled', suppressed: true }, 'owner-silence'],
    [{ success: true, sid: 'gate-blocked', gateBlocked: true }, 'gate-blocked'],
    [{ success: true, sid: 'template-disabled', templateDisabled: true }, 'template-disabled'],
  ])('keeps legacy sent semantics but marks %s as not sent', async (providerResult, providerMessageId) => {
    TwilioService.sendSMS.mockResolvedValueOnce(providerResult);

    expect(await sendViaTwilio(baseInput())).toMatchObject({
      sent: true,
      deliveryOutcome: 'not_sent',
      providerMessageId,
    });
  });
});
