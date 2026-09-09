// STOP / HELP / START handling only applies to numbers Waves has texted.
// A first-contact stranger's body is never scanned for opt-out phrasing, so a
// robotext's own "reply NO to stop texting" footer cannot earn an
// unsubscribe reply from a Waves line (audit 2026-09-09).
const chain = { result: null, fail: false };
jest.mock('../models/db', () => {
  const q = {
    where: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    whereNot: jest.fn(() => q),
    orWhereNull: jest.fn(() => q),
    first: jest.fn(async () => { if (chain.fail) throw new Error('db down'); return chain.result; }),
  };
  return jest.fn(() => q);
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ recordSuppression: jest.fn(), clearSuppression: jest.fn() }));
jest.mock('../services/messaging/opt-out-detector', () => ({ detectSmsOptCommand: jest.fn(() => ({ action: null })) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), updateByTwilioSid: jest.fn() }));
jest.mock('../services/sms-media', () => ({ uploadTwilioMedia: jest.fn(async () => []) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(), isFailureStatus: jest.fn(() => false) }));
jest.mock('../services/sms-intent', () => ({ hasSchedulingIntent: jest.fn(() => false), isSmsReaction: jest.fn(() => false) }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.wavespestcontrol.com') }));

const { hasOutboundHistory } = require('../routes/twilio-webhook')._internals;

describe('hasOutboundHistory — who may receive a STOP/HELP/START reply', () => {
  beforeEach(() => { chain.result = null; chain.fail = false; });

  test('a number Waves never texted is not eligible', async () => {
    expect(await hasOutboundHistory('+18139342698')).toBe(false);
  });

  test('a number with any customer-facing outbound row is eligible', async () => {
    chain.result = { id: 'sms-1' };
    expect(await hasOutboundHistory('+19415551234')).toBe(true);
  });

  test('an unusable number is never eligible', async () => {
    chain.result = { id: 'sms-1' };
    expect(await hasOutboundHistory('')).toBe(false);
    expect(await hasOutboundHistory('12345')).toBe(false);
  });

  test('fails OPEN on a query error so a real STOP is still honored', async () => {
    chain.fail = true;
    expect(await hasOutboundHistory('+19415551234')).toBe(true);
  });
});
