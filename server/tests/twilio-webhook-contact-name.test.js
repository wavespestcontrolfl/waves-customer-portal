jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  recordSuppression: jest.fn(),
  clearSuppression: jest.fn(),
}));
jest.mock('../services/messaging/opt-out-detector', () => ({
  detectSmsOptCommand: jest.fn(() => ({ action: null })),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(),
  updateByTwilioSid: jest.fn(),
}));
jest.mock('../services/sms-media', () => ({
  uploadTwilioMedia: jest.fn(async () => []),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/sms-intent', () => ({
  hasSchedulingIntent: jest.fn(() => false),
  isSmsReaction: jest.fn(() => false),
}));
jest.mock('../utils/portal-url', () => ({
  publicPortalUrl: jest.fn(() => 'https://portal.wavespestcontrol.com'),
}));

const { extractContactNameFromSms, intakeOutcome } = require('../routes/twilio-webhook')._internals;

describe('a scope-vetoed intake reply still reaches normal inbound notification handling', () => {
  // The intake state machine refusing to QUOTE ("this is for Friday's
  // visit, please treat the backyard" → existing-job coordination, no
  // draft) used to return handled:true, which made the SMS handler return
  // immediately — before the sms_reply bell, the push, and the owner
  // forward. Real, time-sensitive service instructions then existed only in
  // the communications log for someone to find by hand. Suppressing the
  // DRAFT was correct; suppressing the NOTIFICATION was not.
  test('terminal (refused-to-quote) results continue into the notification path', () => {
    expect(intakeOutcome({ handled: true, terminal: true, next: 'awaiting_service' }))
      .toBe('continue_without_quote');
    expect(intakeOutcome({ handled: true, terminal: true, next: 'awaiting_address' }))
      .toBe('continue_without_quote');
  });

  test('a reply the machine ANSWERED is still consumed end to end (unchanged)', () => {
    expect(intakeOutcome({ handled: true, next: 'estimate_drafted' })).toBe('consumed');
    expect(intakeOutcome({ handled: true, next: 'awaiting_address' })).toBe('consumed');
  });

  test('a non-intake message is untouched', () => {
    expect(intakeOutcome({ handled: false })).toBe('continue');
    expect(intakeOutcome(null)).toBe('continue');
    expect(intakeOutcome(undefined)).toBe('continue');
  });
});

describe('twilio inbound SMS contact name extraction', () => {
  test('extracts obvious self-introduction names from lead SMS bodies', () => {
    expect(
      extractContactNameFromSms('Hello, my name is Jeff and I live in Twin Rivers. I am seeking a quote.'),
    ).toEqual({ fullName: 'Jeff', firstName: 'Jeff', lastName: '' });

    expect(
      extractContactNameFromSms('Hi, this is jane smith from Parrish. Need pest control.'),
    ).toEqual({ fullName: 'Jane Smith', firstName: 'Jane', lastName: 'Smith' });
  });

  test('does not treat service request wording as a name', () => {
    expect(extractContactNameFromSms('I am seeking a quote for one-time rodent service.')).toBeNull();
    expect(extractContactNameFromSms('This is about a rodent problem in my garage.')).toBeNull();
    expect(extractContactNameFromSms("I'm from Bradenton and need pest control.")).toBeNull();
    expect(extractContactNameFromSms('This is for pest control at my house.')).toBeNull();
  });
});
