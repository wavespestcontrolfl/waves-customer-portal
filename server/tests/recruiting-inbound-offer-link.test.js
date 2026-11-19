/**
 * An applicant who replies with the offer text quoted must not leave the signing link in the recruiting history or the
 * sms_log row (services/recruiting-inbound.js recordApplicantReply; the Twilio webhook redacts the inbound body once for
 * every inbound writer, see the source guard at the end).
 */

const mockInserts = [];
const mockAppended = [];
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = async (fn) => fn((table) => ({
    where: () => ({ first: async () => null }),
    insert: async (row) => { mockInserts.push({ table, row }); return [row]; },
  }));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/recruiting-comms', () => ({
  appendCommsHistory: jest.fn(async (_id, entries) => { mockAppended.push(...entries); }),
  maskPhone: (p) => `masked:${p}`,
  errorSummary: () => 'error',
}));
jest.mock('../services/messaging/review-ask-reservation', () => ({ excludeUnresolvedSendReservations: (q) => q }));

const { recordApplicantReply } = require('../services/recruiting-inbound');

const TOKEN = 'ef'.repeat(32);

beforeEach(() => { mockInserts.length = 0; mockAppended.length = 0; });

test('a quoted offer link is hidden in the history entry and the sms_log row; the rest of the reply is kept', async () => {
  const body = `Yes I got it > Hi Jordan, your job offer: https://portal.wavespestcontrol.com/careers/offer/${TOKEN} It stays open`;
  await recordApplicantReply({ applicationId: 'app-1', from: '+19415550123', to: '+19415550199', body, messageSid: 'SM1' });
  const log = mockInserts.find((i) => i.table === 'sms_log').row;
  expect(log.message_body).toContain('/careers/offer/[link hidden]');
  expect(log.message_body).toContain('Yes I got it');
  expect(mockAppended[0].body).toContain('/careers/offer/[link hidden]');
  expect(JSON.stringify([...mockInserts, ...mockAppended])).not.toContain(TOKEN);
});

test('an ordinary reply, and a photo-only reply, are stored as before', async () => {
  await recordApplicantReply({ applicationId: 'app-1', from: '+19415550123', to: '+19415550199', body: 'Thanks, see you Monday', messageSid: 'SM2' });
  expect(mockAppended[0].body).toBe('Thanks, see you Monday');
  await recordApplicantReply({ applicationId: 'app-1', from: '+19415550123', to: '+19415550199', body: '', messageSid: 'SM3', mediaCount: 2 });
  expect(mockAppended[1].body).toBe('2 photos');
});

test('the inbound webhook redacts the body once, before every inbound writer (source guard)', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'twilio-webhook.js'), 'utf8');
  const at = (needle) => source.indexOf(needle);
  expect(at("redactOfferLinks(req.body.Body)")).toBeGreaterThan(-1);
  expect(at("redactOfferLinks(req.body.Body)")).toBeLessThan(at('isSmsReaction(Body)'));
  expect(source).not.toMatch(/const \{ From, To, Body, MessageSid \} = req\.body/);
});
