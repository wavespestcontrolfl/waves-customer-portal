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
    buildForwardScreenUrl,
    forwardScreenAnnouncement,
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

    test('handles E.164 with country code', () => {
      expect(spokenPhoneDigits('+19415551234')).toBe('941. 555. 1234.');
    });

    test('returns empty string for non-NANP input', () => {
      expect(spokenPhoneDigits('')).toBe('');
      expect(spokenPhoneDigits('12345')).toBe('');
    });
  });

  describe('buildForwardScreenUrl', () => {
    const base = '/api/webhooks/twilio/inbound-forward-screen';

    test('announces a matched customer by name', () => {
      const url = buildForwardScreenUrl({ customer: { first_name: 'John', last_name: 'Doe' }, from: '+19415551234' });
      expect(url).toBe(`${base}?caller=John+Doe`);
    });

    test('announces an unmatched caller by number', () => {
      const url = buildForwardScreenUrl({ customer: null, from: '+19415551234' });
      expect(url).toBe(`${base}?callerNum=%2B19415551234`);
    });

    test('falls back to the bare screen URL with no name and no number', () => {
      expect(buildForwardScreenUrl({ customer: null, from: '' })).toBe(base);
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
