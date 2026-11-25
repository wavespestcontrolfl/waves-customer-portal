// A failed post-send sms_log insert must log the driver code only. A knex insert error message carries the bound row: the text
// (which can hold a /l/<code> short link or any bearer link) and both phone numbers. Same for the unified-messages dual write.
const mockTwilioCreate = jest.fn();
const mockValidateOutbound = jest.fn(() => ({ ok: true }));

jest.mock('twilio', () => jest.fn(() => ({
  messages: { create: mockTwilioCreate },
})));
jest.mock('../config', () => ({
  twilio: {
    accountSid: 'AC_test',
    authToken: 'auth_test',
    verifyServiceSid: 'VA_test',
  },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(gate => gate !== 'smsGratitudeReplies'),
  // Push channel routing reads this at send time; false keeps routing inert
  // so these tests keep asserting the legacy SMS path.
  gateEnvValue: jest.fn(() => false),
  gateEnvTimestamp: jest.fn(() => null),
}));
jest.mock('../models/db', () => jest.fn());
// Codex round 3 on #4608 (structural move, P1 PRRT_kwDOR3YQi86j8Ydm): the
// annual-offer guard's AUTHORITATIVE check now lives inside sendSMS's own
// dispatch(), the true provider boundary. Mocked transparently (always
// allowed) by default so every existing test in this file — none of whose
// bodies carry an estimate link — is unaffected; the tests below override it.
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  // Round 8 P1: default no-op (nothing rewritten) so every existing test
  // in this file is unaffected; the withheldLinkPolicy tests below override it.
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
}));
jest.mock('../services/sms-guard', () => ({
  validateOutbound: (...args) => mockValidateOutbound(...args),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}) }));
jest.mock('../services/messaging/sync-optout', () => ({ recordSyncProviderOptOut: jest.fn(async () => {}) }));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// callback_number_needed (PR #4807): every SMS is checked against
// disclaimed_number_holds (sendCustomerMessage + sendSMS's dispatch). Not
// under test here — stubbed to "never held" so no hold read reaches the db.
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));


const TwilioService = require('../services/twilio');
const db = require('../models/db');
const logger = require('../services/logger');

const TO = '+19415550123';
const FROM = '+19413180000';
const BODY = 'Hi Bob, Waves here. Pat is on the way. Track live: https://portal.wavespestcontrol.com/l/abcdefghjk Reply STOP to opt out.';

function knexInsertError() {
  return Object.assign(
    new Error(`insert into "sms_log" ("from_phone", "message_body", "to_phone") values ('${FROM}', '${BODY}', '${TO}') - connection terminated`),
    { code: '57P01' },
  );
}

describe('a failed sms_log insert after the provider accepted the text', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_log_fail' });
    db.transaction = jest.fn(async (cb) => cb(db));
    db.raw = jest.fn(async () => ({}));
    db.mockImplementation((table) => ({
      insert: async () => { if (table === 'sms_log') throw knexInsertError(); return [{}]; },
      where: () => ({ first: async () => null }),
    }));
  });

  test('the send still succeeds, and the log carries the driver code but neither the text, the short link nor a phone number', async () => {
    const result = await TwilioService.sendSMS(TO, BODY, { messageType: 'tech_en_route', fromNumber: FROM });
    expect(result.success).toBe(true);
    const logged = JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, logger.info.mock.calls]);
    expect(logged).toContain('SMS log failed');
    expect(logged).toContain('code=57P01');
    expect(logged).not.toContain('abcdefghjk');
    expect(logged).not.toContain('/l/');
    expect(logged).not.toContain('Pat is on the way');
    expect(logged).not.toContain('9415550123');
    expect(logged).not.toContain('9413180000');
  });
});
