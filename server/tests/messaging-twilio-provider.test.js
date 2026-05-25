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
    TwilioService.sendSMS.mockResolvedValue({ success: true, sid: 'SM123' });
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
    TwilioService.sendSMS.mockRejectedValueOnce(err);

    const result = await sendViaTwilio(baseInput());

    expect(result).toMatchObject({
      sent: false,
      provider: 'twilio',
      error: expect.stringContaining('Twilio 21614'),
    });
    expect(result.error).toContain('[redacted-phone]');
    expect(result.error).not.toContain('+15551230000');
  });

  test('prefers wrapped providerError details from the Twilio service', async () => {
    const err = new Error('Failed to send SMS: Twilio 30008');
    err.providerError = 'Twilio 30008: Unknown error for +15551230000';
    TwilioService.sendSMS.mockRejectedValueOnce(err);

    const result = await sendViaTwilio(baseInput());

    expect(result.error).toBe('Twilio 30008: Unknown error for [redacted-phone]');
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
});
