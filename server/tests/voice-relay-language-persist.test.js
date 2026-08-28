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
  c._provedLanguage = null;
  c._languageProof = null;
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
  expect(convoWith()._provedLanguage).toBeNull();
});

describe('_proveSelectedLanguage — the ONE source for every language WRITER', () => {
  test('proof sets _provedLanguage once; repeated calls reuse the same read', async () => {
    const q = callLogRow({ caller_language: 'es' });
    db.mockImplementation(() => q);
    const c = convoWith();
    expect(c._provedLanguage).toBeNull(); // the frame hint never pre-fills it
    expect(await c._proveSelectedLanguage()).toBe('es');
    expect(await c._proveSelectedLanguage()).toBe('es');
    expect(c._provedLanguage).toBe('es');
    expect(q.first).toHaveBeenCalledTimes(1);
  });
  test('no stamp ⇒ null and _provedLanguage stays null (lead capture then carries no language)', async () => {
    db.mockImplementation(() => callLogRow({}));
    const c = convoWith();
    expect(await c._proveSelectedLanguage()).toBeNull();
    expect(c._provedLanguage).toBeNull();
  });
  test('English session ⇒ no read at all', async () => {
    db.mockImplementation(() => callLogRow({ caller_language: 'es' }));
    expect(await convoWith({ language: 'en-US' })._proveSelectedLanguage()).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });
  test('a real session constructed with a Spanish hint starts the proof at setup and exposes only the proved value to the tool ctx', async () => {
    db.mockImplementation(() => callLogRow({ caller_language: 'es' }));
    const convo = new RelayConversation({ callSid: 'CA9', from: '+19415551234', language: 'es', send: jest.fn(), endSession: jest.fn() });
    expect(convo.language).toBe('es');
    expect(convo._languageProof).toBeInstanceOf(Promise);
    expect(await convo._languageProof).toBe('es');
    expect(convo._provedLanguage).toBe('es');
    const convoNo = new RelayConversation({ callSid: 'CA8', from: '+19415551234', language: 'en-US', send: jest.fn(), endSession: jest.fn() });
    expect(convoNo._languageProof).toBeNull();
    expect(convoNo._provedLanguage).toBeNull();
  });
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
