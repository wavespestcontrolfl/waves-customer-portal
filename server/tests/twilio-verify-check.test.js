/**
 * checkVerificationCode error semantics (Sentry NODE-EXPRESS-11).
 *
 * Twilio Verify throws 20404 when a verification is expired (10-min TTL),
 * already consumed, or never sent, and 60202 when max check attempts are
 * reached. Customers retrying a stale code were getting 500s because the
 * service rethrew every error into the route's error handler — these are
 * wrong-code outcomes and must return { success: false } so the route
 * answers 401. Genuine infrastructure failures must still throw.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));

const mockVerificationChecks = { create: jest.fn() };
jest.mock('twilio', () => jest.fn(() => ({
  verify: {
    v2: {
      services: jest.fn(() => ({ verificationChecks: mockVerificationChecks })),
    },
  },
})));

jest.mock('../config', () => ({
  twilio: {
    accountSid: 'AC_test',
    authToken: 'auth_test',
    verifyServiceSid: 'VA_test',
    phoneNumber: '+15550000000',
  },
}));

const TwilioService = require('../services/twilio');

function twilioError(props) {
  return Object.assign(new Error(props.message || 'twilio error'), props);
}

describe('checkVerificationCode', () => {
  beforeEach(() => {
    mockVerificationChecks.create.mockReset();
  });

  test('approved check returns success', async () => {
    mockVerificationChecks.create.mockResolvedValueOnce({ status: 'approved' });
    const result = await TwilioService.checkVerificationCode('+19415551234', '123456');
    expect(result).toEqual({ success: true, status: 'approved' });
  });

  test('wrong code (pending status) returns success:false without throwing', async () => {
    mockVerificationChecks.create.mockResolvedValueOnce({ status: 'pending' });
    const result = await TwilioService.checkVerificationCode('+19415551234', '000000');
    expect(result).toEqual({ success: false, status: 'pending' });
  });

  test('expired/consumed verification (20404) returns success:false, not a throw', async () => {
    mockVerificationChecks.create.mockRejectedValueOnce(
      twilioError({ code: 20404, status: 404, message: 'The requested resource was not found' }),
    );
    const result = await TwilioService.checkVerificationCode('+19415551234', '123456');
    expect(result).toEqual({ success: false, status: 'expired_or_not_found' });
  });

  test('HTTP 404 without a Twilio code is still an expired outcome', async () => {
    mockVerificationChecks.create.mockRejectedValueOnce(twilioError({ status: 404 }));
    const result = await TwilioService.checkVerificationCode('+19415551234', '123456');
    expect(result).toEqual({ success: false, status: 'expired_or_not_found' });
  });

  test('max check attempts (60202) returns success:false, not a throw', async () => {
    mockVerificationChecks.create.mockRejectedValueOnce(
      twilioError({ code: 60202, status: 429, message: 'Max check attempts reached' }),
    );
    const result = await TwilioService.checkVerificationCode('+19415551234', '123456');
    expect(result).toEqual({ success: false, status: 'max_attempts_reached' });
  });

  test('genuine infrastructure failures still throw the generic error', async () => {
    mockVerificationChecks.create.mockRejectedValueOnce(
      twilioError({ code: 20003, status: 401, message: 'Authentication error' }),
    );
    await expect(TwilioService.checkVerificationCode('+19415551234', '123456'))
      .rejects.toThrow('Verification check failed');
  });
});
