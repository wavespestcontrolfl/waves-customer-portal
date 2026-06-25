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
    forwardScreenAnnouncement,
    screenAnnouncementFromCallRow,
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

    test('does NOT read an international (non-NANP) number as a US number', () => {
      // UK number — must not be announced as "201. 234. 5678."
      expect(spokenPhoneDigits('+442012345678')).toBe('');
    });

    test('returns empty string for non-NANP input', () => {
      expect(spokenPhoneDigits('')).toBe('');
      expect(spokenPhoneDigits('12345')).toBe('');
    });
  });

  describe('screenAnnouncementFromCallRow', () => {
    test('reads a matched customer by name from jsonb metadata', () => {
      const row = { metadata: { screen_caller_name: 'John Doe' }, from_phone: '+19415551234' };
      expect(screenAnnouncementFromCallRow(row))
        .toBe('Waves call from John Doe. Press 1 to connect.');
    });

    test('parses metadata when stored as a JSON string', () => {
      const row = { metadata: JSON.stringify({ screen_caller_name: 'John Doe' }), from_phone: '+19415551234' };
      expect(screenAnnouncementFromCallRow(row))
        .toBe('Waves call from John Doe. Press 1 to connect.');
    });

    test('falls back to the stored from_phone when there is no matched name', () => {
      const row = { metadata: { screen_caller_name: null }, from_phone: '+19415551234' };
      expect(screenAnnouncementFromCallRow(row))
        .toBe('Waves call from an unknown number. 941. 555. 1234. Press 1 to connect.');
    });

    test('falls back to plain unknown when the row is missing entirely', () => {
      expect(screenAnnouncementFromCallRow(null))
        .toBe('Waves call from an unknown number. Press 1 to connect.');
    });
  });

  describe('forwardScreenAnnouncement', () => {
    test('reads a matched caller by name', () => {
      expect(forwardScreenAnnouncement({ caller: 'John Doe' }))
        .toBe('Waves call from John Doe. Press 1 to connect.');
    });

    test('reads an unmatched caller by number', () => {
      expect(forwardScreenAnnouncement({ callerNum: '+19415551234' }))
        .toBe('Waves call from an unknown number. 941. 555. 1234. Press 1 to connect.');
    });

    test('falls back to plain unknown when nothing is passed', () => {
      expect(forwardScreenAnnouncement({}))
        .toBe('Waves call from an unknown number. Press 1 to connect.');
    });

    test('keeps the business prefix so staff can tell it is a Waves call', () => {
      expect(forwardScreenAnnouncement({ caller: 'John Doe' })).toContain('Waves call from');
    });
  });
});
