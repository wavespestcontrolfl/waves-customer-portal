// GATE_SMS_BARE_YES_REPLY decision: a bare YES is an ordinary reply only when
// it has nothing to re-subscribe. Weekly sweep #5007 B3: every bare YES used
// to be START, so an answer to "Reply YES to book" never reached the office.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ loadSuppressionState: jest.fn() }));
jest.mock('../services/recipient-optin', () => ({
  recipientPhoneKey: (phone) => String(phone || '').replace(/\D/g, '').slice(-10),
}));

const { loadSuppressionState } = require('../services/messaging/validators/suppression');
const logger = require('../services/logger');
const { bareYesIsReply } = require('../services/messaging/bare-yes-reply');

const PHONE = '+19415550123';

// A knex double: one canned `.first()` answer (or error) per table, and every
// where/whereNot filter recorded so the tests can check what was asked.
function fakeDb(answers = {}) {
  const calls = [];
  const dbh = (table) => {
    const call = { table, filters: [] };
    calls.push(call);
    const q = {
      where: (filter) => { call.filters.push(['where', filter]); return q; },
      whereNot: (filter) => { call.filters.push(['whereNot', filter]); return q; },
      first: async () => {
        const answer = answers[table];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
      },
    };
    return q;
  };
  return { dbh, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  loadSuppressionState.mockImplementation(async (input, contactState) => ({ ...contactState, suppressionLoaded: true }));
});

test('a subscribed number with texts on and no open ask is a reply', async () => {
  const { dbh, calls } = fakeDb({ notification_prefs: { sms_enabled: true } });
  await expect(bareYesIsReply({ phone: PHONE, customerId: 'cust-1', dbh })).resolves.toBe(true);
  expect(loadSuppressionState).toHaveBeenCalledWith({ to: PHONE }, {}, dbh);
  expect(calls).toEqual([
    { table: 'notification_prefs', filters: [['where', { customer_id: 'cust-1' }]] },
    { table: 'recipient_optin', filters: [['where', { phone_key: '9415550123' }], ['whereNot', { status: 'confirmed' }]] },
  ]);
});

test('an active suppression keeps the opt-in, so YES still undoes a STOP', async () => {
  loadSuppressionState.mockResolvedValueOnce({ suppressionLoaded: true, suppression: { reason: 'opt_out_keyword' } });
  const { dbh, calls } = fakeDb();
  await expect(bareYesIsReply({ phone: PHONE, customerId: 'cust-1', dbh })).resolves.toBe(false);
  expect(calls).toEqual([]);
});

test.each([
  ['a failed lookup', { suppressionLookupFailed: true }],
  ['a missing table', {}],
])('unknown suppression state (%s) keeps the opt-in', async (_label, state) => {
  loadSuppressionState.mockResolvedValueOnce(state);
  const { dbh } = fakeDb();
  await expect(bareYesIsReply({ phone: PHONE, customerId: 'cust-1', dbh })).resolves.toBe(false);
});

test('texts turned off on the customer keep the opt-in', async () => {
  const { dbh } = fakeDb({ notification_prefs: { sms_enabled: false } });
  await expect(bareYesIsReply({ phone: PHONE, customerId: 'cust-1', dbh })).resolves.toBe(false);
});

test('a sender with no matched customer skips the preference read', async () => {
  const { dbh, calls } = fakeDb();
  await expect(bareYesIsReply({ phone: PHONE, dbh })).resolves.toBe(true);
  expect(calls.map((c) => c.table)).toEqual(['recipient_optin']);
});

test('an open recipient ask keeps the opt-in, so YES still confirms it', async () => {
  const { dbh } = fakeDb({ recipient_optin: { id: 'ask-1' } });
  await expect(bareYesIsReply({ phone: PHONE, customerId: 'cust-1', dbh })).resolves.toBe(false);
});

test('a query error keeps the opt-in and logs no phone digits', async () => {
  const { dbh } = fakeDb({ notification_prefs: Object.assign(new Error(`timeout for ${PHONE}`), { code: '57014' }) });
  await expect(bareYesIsReply({ phone: PHONE, customerId: 'cust-1', dbh })).resolves.toBe(false);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn.mock.calls[0][0]).toContain('57014');
  expect(logger.warn.mock.calls[0][0]).not.toMatch(/\d{7}/);
});
