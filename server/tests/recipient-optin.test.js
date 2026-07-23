jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  recipientPhoneKey,
  optinBlocksSend,
} = require('../services/recipient-optin');

describe('recipient double opt-in', () => {
  test('recipientPhoneKey matches the webhook last-10 convention', () => {
    expect(recipientPhoneKey('+19415550123')).toBe('9415550123');
    expect(recipientPhoneKey('(941) 555-0123')).toBe('9415550123');
    expect(recipientPhoneKey('')).toBe('');
    expect(recipientPhoneKey(null)).toBe('');
  });

  test('no row = grandfathered recipient, always allowed', () => {
    expect(optinBlocksSend(null, true)).toBe(false);
    expect(optinBlocksSend(undefined, true)).toBe(false);
  });

  test('pending and declined rows hold sends while the gate is on', () => {
    expect(optinBlocksSend({ status: 'pending' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'declined' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'confirmed' }, true)).toBe(false);
  });

  test('request_failed and lookup_error rows also hold sends (never-asked/unknown state)', () => {
    expect(optinBlocksSend({ status: 'request_failed' }, true)).toBe(true);
    expect(optinBlocksSend({ status: 'lookup_error' }, true)).toBe(true);
  });

  test('gate off disables the hold entirely', () => {
    expect(optinBlocksSend({ status: 'pending' }, false)).toBe(false);
    expect(optinBlocksSend({ status: 'declined' }, false)).toBe(false);
  });
});
