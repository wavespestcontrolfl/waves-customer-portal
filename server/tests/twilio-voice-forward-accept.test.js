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

describe('twilio voice inbound forward acceptance', () => {
  const { resolveInboundDialCompletion } = voiceRouter._test;

  test('treats completed staff leg without press-1 acceptance as Waves voicemail', () => {
    expect(resolveInboundDialCompletion({
      status: 'completed',
      duration: 13,
      forwardAccepted: false,
    })).toEqual({
      shouldRecordVoicemail: true,
      answeredBy: 'voicemail',
    });
  });

  test('treats completed staff leg with press-1 acceptance as human', () => {
    expect(resolveInboundDialCompletion({
      status: 'completed',
      duration: 45,
      forwardAccepted: true,
    })).toEqual({
      shouldRecordVoicemail: false,
      answeredBy: 'human',
    });
  });

  test('still sends no-answer, busy, and failed dials to Waves voicemail', () => {
    for (const status of ['no-answer', 'busy', 'failed']) {
      expect(resolveInboundDialCompletion({
        status,
        duration: 0,
        forwardAccepted: false,
      })).toEqual({
        shouldRecordVoicemail: true,
        answeredBy: 'voicemail',
      });
    }
  });
});
