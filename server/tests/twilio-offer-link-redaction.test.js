// options.preSendCheck is the canonical messaging pipeline's send-window
// boundary re-check, and it must be awaited as the LAST step before
// c.messages.create() — sendSMS's own internal awaits (redirect check,
// template lookup, customer/location query) can carry a 19:59 ET send past
// the 20:00 cutoff, so any earlier placement re-opens the boundary race
// (codex r2). Fail closed: a throwing check blocks the send.

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
const conversations = require('../services/conversations');

const TO = '+19415550123';
const FROM = '+19413180000';
const TOKEN = 'ab'.repeat(32);
const OFFER_TEXT = `Hi Jordan, it's Adam with Waves. Your job offer is ready to read and sign: https://portal.wavespestcontrol.com/careers/offer/${TOKEN} It stays open until Fri, Dec 18. Reply STOP to opt out.`;

describe('a job-offer text: the provider gets the full link, every stored copy hides the token', () => {
  const inserted = [];
  beforeEach(() => {
    jest.clearAllMocks();
    inserted.length = 0;
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_offer' });
    db.transaction = jest.fn(async (cb) => cb(db));
    db.raw = jest.fn(async () => ({}));
    db.mockImplementation((table) => ({
      insert: async (row) => { inserted.push({ table, row }); return [row]; },
      where: () => ({ first: async () => null }),
    }));
  });

  test('Twilio is sent the real offer link', async () => {
    await TwilioService.sendSMS(TO, OFFER_TEXT, { messageType: 'job_offer_sent', fromNumber: FROM });
    expect(mockTwilioCreate.mock.calls[0][0].body).toContain(`/careers/offer/${TOKEN}`);
  });

  test('the sms_log row and the unified messages row keep the path with the token hidden', async () => {
    await TwilioService.sendSMS(TO, OFFER_TEXT, { messageType: 'job_offer_sent', fromNumber: FROM });
    const log = inserted.find((i) => i.table === 'sms_log');
    expect(log.row.message_body).toContain('/careers/offer/[link hidden]');
    expect(log.row.message_body).not.toContain(TOKEN);
    expect(JSON.stringify(log.row)).not.toContain(TOKEN);
    const touch = conversations.recordTouchpoint.mock.calls[0][0];
    expect(touch.body).toContain('/careers/offer/[link hidden]');
    expect(JSON.stringify(touch)).not.toContain(TOKEN);
  });

  test('any other text is stored exactly as sent', async () => {
    const other = 'Your visit is tomorrow: https://portal.wavespestcontrol.com/careers/interview/' + TOKEN;
    await TwilioService.sendSMS(TO, other, { messageType: 'manual', fromNumber: FROM });
    const log = inserted.find((i) => i.table === 'sms_log');
    expect(log.row.message_body).toContain(TOKEN); // interview links are out of scope here
  });
});
