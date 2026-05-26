jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({ bellWritten: true, push: null })),
}));

const db = require('../models/db');
const { triggerNotification } = require('../services/notification-triggers');
const {
  alertTwilioFailure,
  publicDedupeKey,
  sanitizeFailureText,
} = require('../services/twilio-failure-alerts');

function notificationQuery(existing = null) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(existing),
  };
}

describe('Twilio failure alerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((value) => value);
    db.mockReturnValue(notificationQuery(null));
  });

  test('sanitizes provider text before admin notification dispatch', async () => {
    await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      phase: 'send_api',
      status: 'failed',
      sid: 'SM1234567890abcdef1234567890abcdef',
      errorCode: '30007',
      errorMessage: 'Twilio failed for +19415551212 and SM1234567890abcdef1234567890abcdef sent to owner@example.com',
      from: '+19413187612',
      to: '+19415551212',
      dedupeKey: 'twilio:sms:outbound:+19415551212:SM1234567890abcdef1234567890abcdef',
    });

    expect(triggerNotification).toHaveBeenCalledWith('twilio_failure', expect.objectContaining({
      errorMessage: 'Twilio failed for [phone] and SM...abcdef sent to [email]',
      fromMasked: '***7612',
      toMasked: '***1212',
      sidMasked: 'SM...abcdef',
      dedupeKey: expect.stringMatching(/^twilio:[a-f0-9]{16}$/),
    }));

    const payload = triggerNotification.mock.calls[0][1];
    expect(payload).not.toHaveProperty('sid');
    expect(payload.dedupeKey).not.toContain('+19415551212');
    expect(payload.dedupeKey).not.toContain('SM1234567890abcdef1234567890abcdef');
  });

  test('sanitizes lookup urls, phone numbers, emails, and Twilio SIDs', () => {
    expect(sanitizeFailureText(
      'GET https://lookups.twilio.com/v2/PhoneNumbers/%2B19415551212?Fields=caller_name failed for +19415551212 ZZ1234567890abcdef1234567890abcdef test@example.com'
    )).toBe(
      'GET https://lookups.twilio.com/v2/PhoneNumbers/[phone]?Fields=caller_name failed for [phone] ZZ...abcdef [email]'
    );
  });

  test('hashes caller-provided dedupe keys before persistence', () => {
    expect(publicDedupeKey('raw:+19415551212:SM1234567890abcdef1234567890abcdef'))
      .toMatch(/^twilio:[a-f0-9]{16}$/);
  });
});
