jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(),
  syncVoiceMessageForCall: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const voiceRouter = require('../routes/twilio-voice-webhook');

describe('twilio voice inbound caller announcement', () => {
  const {
    connectingAnnouncement,
    spokenCallerName,
    spokenPhoneDigits,
  } = voiceRouter._test;

  describe('spokenCallerName', () => {
    test('joins first and last name', () => {
      expect(spokenCallerName({ first_name: 'John', last_name: 'Doe' })).toBe('John Doe');
    });

    test('falls back to first name only', () => {
      expect(spokenCallerName({ first_name: 'John', last_name: null })).toBe('John');
    });

    test('keeps accented letters and apostrophes, strips the rest', () => {
      expect(spokenCallerName({ first_name: 'José*', last_name: '<O’Brien>' }))
        .toBe('José O’Brien');
    });

    test('returns null when no usable name is present', () => {
      expect(spokenCallerName(null)).toBeNull();
      expect(spokenCallerName({})).toBeNull();
      expect(spokenCallerName({ first_name: '   ', last_name: '' })).toBeNull();
    });
  });

  describe('spokenPhoneDigits', () => {
    test('formats a 10-digit number with pauses', () => {
      expect(spokenPhoneDigits('9415551234')).toBe('941. 555. 1234.');
    });

    test('handles E.164 with US country code', () => {
      expect(spokenPhoneDigits('+19415551234')).toBe('941. 555. 1234.');
    });

    test('does NOT read a UK international number as a US number', () => {
      // Must not be announced as "201. 234. 5678."
      expect(spokenPhoneDigits('+442012345678')).toBe('');
    });

    test('does NOT read a +-prefixed non-US number that happens to have 10 digits', () => {
      // +4930123456 strips to 10 digits but is a German number — not NANP.
      expect(spokenPhoneDigits('+4930123456')).toBe('');
    });

    test('returns empty string for non-NANP input', () => {
      expect(spokenPhoneDigits('')).toBe('');
      expect(spokenPhoneDigits('12345')).toBe('');
    });
  });

  describe('connectingAnnouncement (spoken only after press-1)', () => {
    test('reads a matched customer by name from jsonb metadata', () => {
      const row = { metadata: { screen_caller_name: 'John Doe' }, from_phone: '+19415551234' };
      expect(connectingAnnouncement(row)).toBe('Connecting your call from John Doe.');
    });

    test('parses metadata when stored as a JSON string', () => {
      const row = { metadata: JSON.stringify({ screen_caller_name: 'José O’Brien' }), from_phone: '+19415551234' };
      expect(connectingAnnouncement(row)).toBe('Connecting your call from José O’Brien.');
    });

    test('falls back to the stored from_phone when there is no matched name', () => {
      const row = { metadata: { screen_caller_name: null }, from_phone: '+19415551234' };
      expect(connectingAnnouncement(row))
        .toBe('Connecting your call from an unknown number. 941. 555. 1234.');
    });

    test('falls back to a generic confirmation when the row is missing entirely', () => {
      expect(connectingAnnouncement(null)).toBe('Connecting your call.');
    });

    test('falls back to generic for an international caller with no matched name', () => {
      const row = { metadata: {}, from_phone: '+442012345678' };
      expect(connectingAnnouncement(row)).toBe('Connecting your call.');
    });
  });
});
