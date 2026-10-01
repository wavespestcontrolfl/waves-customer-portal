/**
 * sendCustomerMessage — GATE_SMS_LINK_WRAP send path.
 *
 * Pins, through the real choke point: the portal link in a customer/lead SMS
 * is rewritten to a /l/<code> short link BEFORE countSegments, so the audit
 * row's body, its segment count and the text handed to the provider all
 * describe the same wrapped body; the minted code is stamped with the sms_log
 * row after an accepted Twilio send (a blocked or failed attempt leaves it
 * unstamped — codes are never deleted); a shortener
 * failure keeps the original link and still sends; gate off / MMS bodies are
 * byte-identical to today.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/short-url', () => ({
  ...jest.requireActual('../services/short-url'),
  createShortCode: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn(actual.isEnabled) };
});
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({})),
  checkConsentForPurpose: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, contactState) => contactState),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  checkLineType: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/identity', () => ({
  validateRequiredIds: jest.fn(() => ({ ok: true })),
  validateIdentityTrust: jest.fn(() => ({ ok: true })),
  resolveTrustLevel: jest.fn(() => 'phone_provided_unverified'),
}));
jest.mock('../services/messaging/validators/voice', () => ({
  validateNoCustomerEmoji: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  checkContactCompliance: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM${'b2'.repeat(16)}` })),
  mapPurposeToMessageType: jest.fn(() => 'manual'),
  mediaUrlsAllowed: jest.fn((input) => input.metadata?.allowMediaUrls === true),
}));
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  // Round 8 P1: default no-op (nothing rewritten) so every existing test
  // in this file is unaffected; the withheldLinkPolicy tests override it.
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  // Round 11 structural fix (P1): default 'refuse' (like the real function
  // for any non-receipt purpose/message-type) so every existing test in
  // this file is unaffected — they all either pass an explicit
  // withheldLinkPolicy or exercise the default-refuse path directly; the
  // purpose-resolution mechanism itself is covered by
  // estimate-annual-guard.test.js and estimate-deposits.test.js's
  // scheduled-retry test.
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));
// callback_number_needed hold (PR #4807, round 6 — number-keyed) — the
// canonical chokepoint checks every SMS `to` against
// disclaimed_number_holds, right beside the MOVE_HOLD check this file's own
// describe block exercises. Mocked out (default: never held) so this
// file's plain `db` doubles — built for MOVE_HOLD's own where/first query
// shape — are never asked to also answer the hold read; the chokepoint
// itself is covered by send-customer-message-callback-number-hold.test.js.
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));


const db = require('../models/db');
const { createShortCode } = require('../services/short-url');
const { countSegments } = require('../services/messaging/segment-counter');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const logger = require('../services/logger');

const HOST = 'portal.wavespestcontrol.com';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LONG_LINK = `https://${HOST}/prep/${TOKEN}`;
// Long enough that the raw link pushes the text into a second segment while
// the short link keeps it in one — the count must follow the wrapped body.
const LEAD_IN = 'Hi, this is Waves with the prep checklist for your upcoming pest control visit. Please read it before we arrive: ';
const BASE_INPUT = {
  to: '+19415550142',
  body: `${LEAD_IN}${LONG_LINK}`,
  channel: 'sms',
  audience: 'customer',
  purpose: 'conversational',
  customerId: '11111111-2222-4333-8444-555555555555',
};
const SID = `SM${'b2'.repeat(16)}`;
const WRAPPED_BODY = `${LEAD_IN}${HOST}/l/wrap1abcde`;

let dbLog;
function fakeDb(table) {
  const b = {};
  b.where = jest.fn((c) => { dbLog.push({ table, where: c }); return b; });
  b.whereIn = jest.fn((col, vals) => { dbLog.push({ table, whereIn: [col, vals] }); return b; });
  b.whereNull = jest.fn(() => b);
  b.orderBy = jest.fn(() => b);
  b.whereRaw = jest.fn(() => b);
  b.first = jest.fn(async () => (table === 'sms_log' ? { id: 'sms-log-9' } : null));
  b.update = jest.fn(async (payload) => { dbLog.push({ table, update: payload }); return 1; });
  return b;
}
const providerInput = () => sendViaTwilio.mock.calls[0][0];
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  dbLog = [];
  db.mockImplementation(fakeDb);
  process.env.GATE_SMS_LINK_WRAP = 'true';
  sendViaTwilio.mockResolvedValue({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: SID });
  persistAudit.mockResolvedValue({ id: 'audit-1' });
  createShortCode.mockResolvedValue({ code: 'wrap1abcde', shortUrl: `https://${HOST}/l/wrap1abcde` });
});
afterAll(() => { delete process.env.GATE_SMS_LINK_WRAP; });

test('gate on: the provider body, the audit body and the segment count all describe the wrapped body', async () => {
  const rawSegments = countSegments(`${LEAD_IN}${HOST}/prep/${TOKEN}`).segmentCount;
  const wrappedSegments = countSegments(WRAPPED_BODY).segmentCount;
  expect(rawSegments).toBeGreaterThan(wrappedSegments); // the fixture must make the difference observable

  const result = await sendCustomerMessage(BASE_INPUT);

  expect(result).toMatchObject({ sent: true, segmentCount: wrappedSegments });
  expect(providerInput().body).toBe(WRAPPED_BODY);
  expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
    input: expect.objectContaining({ body: WRAPPED_BODY }),
    segmentMeta: expect.objectContaining({ segmentCount: wrappedSegments }),
  }));
  expect(createShortCode).toHaveBeenCalledWith(`https://${HOST}/prep/${TOKEN}`, expect.objectContaining({
    channel: 'sms', purpose: 'sms_link_wrap', customerId: BASE_INPUT.customerId,
  }));
});

test('an accepted send returns the body the provider was handed (sentBody), wrapped link included', async () => {
  const result = await sendCustomerMessage(BASE_INPUT);
  expect(result.sentBody).toBe(WRAPPED_BODY);
  expect(result.sentBody).toBe(providerInput().body);
});

test('accepted but the audit insert throws: the error carries the provider-handed body (sentBody)', async () => {
  persistAudit.mockRejectedValueOnce(new Error('audit insert failed'));
  const err = await sendCustomerMessage(BASE_INPUT).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.providerOutcome).toMatchObject({ sent: true });
  expect(err.sentBody).toBe(WRAPPED_BODY);
});

test('an accepted send stamps the minted code with the sms_log row (after the send, off the send path)', async () => {
  await sendCustomerMessage(BASE_INPUT);
  await flush();
  expect(dbLog).toContainEqual({ table: 'sms_log', where: { twilio_sid: SID } });
  expect(dbLog).toContainEqual({ table: 'short_codes', whereIn: ['code', ['wrap1abcde']] });
  expect(dbLog).toContainEqual({ table: 'short_codes', update: expect.objectContaining({ message_ref: 'sms_log:sms-log-9' }) });
});

test('a code the provider boundary stripped (withheldLinksRewritten) stays unstamped', async () => {
  sendViaTwilio.mockResolvedValue({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: SID, withheldLinksRewritten: ['est-1'] });
  db.mockImplementation((table) => {
    const b = fakeDb(table);
    // The provider logged the body it ACTUALLY sent: the link is gone.
    if (table === 'sms_log') b.first = jest.fn(async () => ({ id: 'sms-log-9', message_body: 'Hi, this is Waves. See your account at portal.wavespestcontrol.com' }));
    return b;
  });
  const result = await sendCustomerMessage(BASE_INPUT);
  await flush();
  expect(result).toMatchObject({ sent: true });
  expect(dbLog.some((e) => e.table === 'short_codes')).toBe(false);
});

test('a code still in the provider-logged body is stamped even when another link was rewritten', async () => {
  sendViaTwilio.mockResolvedValue({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: SID, withheldLinksRewritten: ['est-1'] });
  db.mockImplementation((table) => {
    const b = fakeDb(table);
    if (table === 'sms_log') b.first = jest.fn(async () => ({ id: 'sms-log-9', message_body: WRAPPED_BODY }));
    return b;
  });
  await sendCustomerMessage(BASE_INPUT);
  await flush();
  expect(dbLog).toContainEqual({ table: 'short_codes', whereIn: ['code', ['wrap1abcde']] });
});

test('a push-routed accepted send (no Twilio sid) leaves the code unstamped', async () => {
  sendViaTwilio.mockResolvedValue({ sent: true, provider: 'push', deliveryOutcome: 'accepted', providerMessageId: 'push:delivered' });
  await sendCustomerMessage(BASE_INPUT);
  await flush();
  expect(dbLog).toEqual([]);
});

test('a rejecting stamp is caught and logged by code only (no unhandled rejection, no send failure)', async () => {
  const wrap = require('../services/messaging/sms-link-wrap');
  const spy = jest.spyOn(wrap, 'settleWrappedLinks').mockRejectedValue(Object.assign(new Error('insert ... https://x/prep/secret-token'), { code: 'ECONNRESET' }));
  const result = await sendCustomerMessage(BASE_INPUT);
  await flush();
  expect(result).toMatchObject({ sent: true });
  expect(spy).toHaveBeenCalled();
  const warned = logger.warn.mock.calls.map((c) => c[0]).find((m) => String(m).includes('stamp failed'));
  expect(warned).toContain('ECONNRESET');
  expect(warned).not.toContain('secret-token');
  spy.mockRestore();
});

test('a send that never leaves stamps nothing and deletes nothing', async () => {
  const blocked = await sendCustomerMessage({
    ...BASE_INPUT,
    preDispatchCheck: async () => ({ ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'answered mid-send' }),
  });
  await flush();
  expect(blocked).toMatchObject({ sent: false, blocked: true });
  expect(sendViaTwilio).not.toHaveBeenCalled();
  expect(dbLog).toEqual([]);
});

test('gate off: body, audit and segment count are byte-identical to today; nothing minted', async () => {
  delete process.env.GATE_SMS_LINK_WRAP;
  const stripped = `${LEAD_IN}${HOST}/prep/${TOKEN}`;
  const result = await sendCustomerMessage(BASE_INPUT);
  expect(result).toMatchObject({ sent: true, segmentCount: countSegments(stripped).segmentCount });
  expect(providerInput().body).toBe(stripped);
  expect(createShortCode).not.toHaveBeenCalled();
});

test('a shortener failure keeps the original link, warns, and still sends', async () => {
  createShortCode.mockRejectedValue(new Error('short_codes unavailable'));
  const stripped = `${LEAD_IN}${HOST}/prep/${TOKEN}`;
  const result = await sendCustomerMessage(BASE_INPUT);
  expect(result).toMatchObject({ sent: true, segmentCount: countSegments(stripped).segmentCount });
  expect(providerInput().body).toBe(stripped);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('original kept'));
});

test('an authorized MMS body is never rewritten', async () => {
  const body = `Photo of your yard ${LONG_LINK}`;
  await sendCustomerMessage({
    ...BASE_INPUT,
    body,
    metadata: { mediaUrls: ['https://media.example/x.jpg'], allowMediaUrls: true },
  });
  expect(createShortCode).not.toHaveBeenCalled();
  expect(providerInput().body).toContain(`${HOST}/prep/${TOKEN}`);
});

test('a portal link already shortened by its sender is left alone', async () => {
  const body = `Your invoice: ${HOST}/l/k3j9x2m4pq`;
  await sendCustomerMessage({ ...BASE_INPUT, body });
  expect(createShortCode).not.toHaveBeenCalled();
  expect(providerInput().body).toBe(body);
});
