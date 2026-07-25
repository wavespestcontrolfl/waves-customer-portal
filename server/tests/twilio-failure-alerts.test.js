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

function notificationQuery(existing = null, recipientCount = 0) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(existing),
    // recipientFailureCount resolves the builder itself (no .first()) — a mock
    // without this silently throws into the catch and reports 0, which would
    // make the repeat-offender tests pass for the wrong reason.
    count: jest.fn().mockResolvedValue([{ n: recipientCount }]),
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

  // Regression: three 30005s to ***6842 on 2026-07-23/24 each carried a fresh
  // Twilio SID, so the per-SID dedupe could never collapse them and the bell
  // showed three byte-identical alerts.
  test('suppresses a repeat failure to the same number even with a new SID', async () => {
    db.mockReturnValue(notificationQuery(null, 1));

    const result = await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      phase: 'delivery',
      status: 'undelivered',
      sid: 'SMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      errorCode: '30005',
      from: '+19413187612',
      to: '+19415556842',
    });

    expect(result).toEqual({ skipped: true, reason: 'duplicate_recipient', priorFailures: 1 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('still alerts on the first failure to a number and carries recipientKey', async () => {
    db.mockReturnValue(notificationQuery(null, 0));

    await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      phase: 'delivery',
      status: 'undelivered',
      sid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      errorCode: '30005',
      from: '+19413187612',
      to: '+19415556842',
    });

    expect(triggerNotification).toHaveBeenCalledWith('twilio_failure', expect.objectContaining({
      toMasked: '***6842',
      recipientKey: expect.stringMatching(/^twilio:[a-f0-9]{16}$/),
    }));
    // The recipient key must not leak the number it is derived from.
    expect(triggerNotification.mock.calls[0][1].recipientKey).not.toContain('6842');
  });

  test('a different error code to the same number is still its own alert', async () => {
    db.mockReturnValue(notificationQuery(null, 0));

    await alertTwilioFailure({
      channel: 'sms', direction: 'outbound', phase: 'delivery', status: 'undelivered',
      sid: 'SMcccccccccccccccccccccccccccccccc', errorCode: '30005',
      from: '+19413187612', to: '+19415556842',
    });
    const first = triggerNotification.mock.calls[0][1].recipientKey;

    await alertTwilioFailure({
      channel: 'sms', direction: 'outbound', phase: 'delivery', status: 'undelivered',
      sid: 'SMdddddddddddddddddddddddddddddddd', errorCode: '30006',
      from: '+19413187612', to: '+19415556842',
    });
    const second = triggerNotification.mock.calls[1][1].recipientKey;

    expect(first).not.toEqual(second);
  });

  test('a failure with no recipient falls back to per-SID dedupe only', async () => {
    db.mockReturnValue(notificationQuery(null, 0));

    await alertTwilioFailure({
      channel: 'sms', direction: 'outbound', phase: 'send_api', status: 'failed',
      sid: 'SMeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', errorCode: '20003',
      errorMessage: 'HTTP 401: Authenticate',
    });

    expect(triggerNotification).toHaveBeenCalledWith('twilio_failure', expect.objectContaining({
      recipientKey: null,
    }));
  });
});
