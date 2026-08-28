/**
 * preferred_language persistence for a Spanish relay session (codex #3561):
 * ONE writer (lead-from-extraction.stampCustomerPreferredLanguage), written
 * only on confident resolution AND a re-proven press-2 stamp on the
 * authenticated call_log row, detached from the first-turn wait, once per
 * session, time-bounded.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(),
  stampCustomerPreferredLanguage: jest.fn(async () => true),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { stampCustomerPreferredLanguage } = require('../services/lead-from-extraction');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');

function callLogRow(meta) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => (meta === undefined ? undefined : { metadata: meta }));
  return q;
}
function convoWith({ language = 'es', tier = 'full', verified = true, callSid = 'CA1', customerId = 'cust-1' } = {}) {
  const c = Object.create(RelayConversation.prototype);
  c.callSid = callSid;
  c.language = language;
  c._callerVerified = verified;
  c._callerContext = customerId ? { tier, customer: { id: customerId } } : null;
  return c;
}

beforeEach(() => { jest.clearAllMocks(); stampCustomerPreferredLanguage.mockResolvedValue(true); });

test('happy path: Spanish + full-tier verified + signed press-2 stamp ⇒ ONE write through the shared writer', async () => {
  db.mockImplementation(() => callLogRow({ caller_language: 'es' }));
  const c = convoWith();
  expect(await c._persistLanguagePreference()).toBe(true);
  expect(db).toHaveBeenCalledWith('call_log');
  expect(stampCustomerPreferredLanguage).toHaveBeenCalledWith('cust-1', 'es');
  // once per session
  expect(await c._persistLanguagePreference()).toBe(false);
  expect(stampCustomerPreferredLanguage).toHaveBeenCalledTimes(1);
});

test('string metadata is parsed', async () => {
  db.mockImplementation(() => callLogRow(JSON.stringify({ caller_language: 'es' })));
  expect(await convoWith()._persistLanguagePreference()).toBe(true);
});

test.each([
  ['English session', { language: 'en-US' }],
  ['no language', { language: null }],
  ['redacted tier (shared number)', { tier: 'redacted' }],
  ['not verified', { verified: false }],
  ['no customer', { customerId: null }],
  ['no callSid', { callSid: null }],
])('%s ⇒ no read, no write', async (_label, opts) => {
  db.mockImplementation(() => callLogRow({ caller_language: 'es' }));
  expect(await convoWith(opts)._persistLanguagePreference()).toBe(false);
  expect(db).not.toHaveBeenCalled();
  expect(stampCustomerPreferredLanguage).not.toHaveBeenCalled();
});

test.each([
  ['no press-2 stamp on the row', {}],
  ['English stamp', { caller_language: 'en' }],
  ['no row', undefined],
  ['unparseable metadata', 'not-json'],
])('setup-frame lang alone never mutates the account: %s ⇒ no write', async (_label, meta) => {
  db.mockImplementation(() => callLogRow(meta));
  expect(await convoWith()._persistLanguagePreference()).toBe(false);
  expect(stampCustomerPreferredLanguage).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('preference NOT persisted'));
});

test('a stalled call_log read is bounded — resolves false, never hangs', async () => {
  jest.useFakeTimers();
  const q = { where: jest.fn(() => q), first: jest.fn(() => new Promise(() => {})) };
  db.mockImplementation(() => q);
  const p = convoWith()._persistLanguagePreference();
  jest.advanceTimersByTime(3100);
  await expect(p).resolves.toBe(false);
  expect(stampCustomerPreferredLanguage).not.toHaveBeenCalled();
  jest.useRealTimers();
});

test('a read error is non-blocking', async () => {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => { throw new Error('boom'); }) };
  db.mockImplementation(() => q);
  expect(await convoWith()._persistLanguagePreference()).toBe(false);
});
