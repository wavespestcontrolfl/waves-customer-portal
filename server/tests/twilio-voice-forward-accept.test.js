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

// The press-1 forward screen was removed 2026-06-12: staff legs bridge as
// soon as they answer, so completion classification rests on dial status +
// duration alone. Carrier voicemail answering a staff cell now counts as a
// human answer — accepted trade-off, documented in the route.
describe('twilio voice inbound dial completion', () => {
  const { resolveInboundDialCompletion } = voiceRouter._test;

  test('treats a completed staff leg with talk time as a human answer', () => {
    expect(resolveInboundDialCompletion({
      status: 'completed',
      duration: 45,
    })).toEqual({
      shouldRecordVoicemail: false,
      answeredBy: 'human',
    });
  });

  test('completed dial with zero duration stays unknown, no voicemail', () => {
    expect(resolveInboundDialCompletion({
      status: 'completed',
      duration: 0,
    })).toEqual({
      shouldRecordVoicemail: false,
      answeredBy: 'unknown',
    });
  });

  test('still sends no-answer, busy, and failed dials to Waves voicemail', () => {
    for (const status of ['no-answer', 'busy', 'failed']) {
      expect(resolveInboundDialCompletion({
        status,
        duration: 0,
      })).toEqual({
        shouldRecordVoicemail: true,
        answeredBy: 'voicemail',
      });
    }
  });
});
