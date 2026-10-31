// Mercury paychecks without a database: the approve-by day, the bell copy against the admin-alert rules, the poller's
// pure decisions, and the gates (off = 404 and no Mercury call). The rows, the locks and the unique index are proved
// against Postgres in payroll-mercury-postgres.test.js. Synthetic names and ids only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const mercury = require('../services/payroll-mercury');
const alerts = require('../services/payroll-mercury-alerts');
const poller = require('../services/payroll-mercury-poller');
const router = require('../routes/admin-payroll');

describe('approveBy', () => {
  test('a Friday pay date: the Wednesday before, 5 PM ET', () => {
    expect(mercury.approveBy('2026-11-06')).toEqual({ date: '2026-11-04', rule: 'wednesday' });
    expect(mercury.approveBy('2026-11-20')).toEqual({ date: '2026-11-18', rule: 'wednesday' });
  });

  test('a pay date on the Wednesday itself, or a Monday, still names an earlier Wednesday', () => {
    expect(mercury.approveBy('2026-11-11')).toEqual({ date: '2026-11-04', rule: 'wednesday' });
    expect(mercury.approveBy('2026-11-09')).toEqual({ date: '2026-11-04', rule: 'wednesday' });
  });

  test('pay date the 1st of a month: the business day before, so wages do not land in the prior month', () => {
    // Fri Jan 1 2027 is a holiday: the business day before is Thu Dec 31 2026 (the Wednesday rule would say Dec 30).
    expect(mercury.approveBy('2027-01-01')).toEqual({ date: '2026-12-31', rule: 'first_of_month' });
    // Mon Mar 1 2027: the business day before is Fri Feb 26, not a Wednesday.
    expect(mercury.approveBy('2027-03-01')).toEqual({ date: '2027-02-26', rule: 'first_of_month' });
    // Sun Nov 1 2026 (a weekend pay date): Fri Oct 30.
    expect(mercury.approveBy('2026-11-01')).toEqual({ date: '2026-10-30', rule: 'first_of_month' });
  });
});

describe('payment states', () => {
  test('Send again: yes after failed, rejected, cancelled or returned; confirm for unknown; never while open or paid', () => {
    for (const state of ['failed', 'rejected', 'cancelled', 'returned']) expect(mercury.canSendAgainOf({ state })).toBe('yes');
    expect(mercury.canSendAgainOf({ state: 'unknown' })).toBe('confirm');
    for (const state of ['queued', 'requested', 'approved', 'sent', 'paper']) expect(mercury.canSendAgainOf({ state })).toBeNull();
  });

  test('a void is blocked by queued, requested, unknown, approved and sent; a returned or paper payment does not block', () => {
    expect(mercury.BLOCKING_STATES).toEqual(['queued', 'requested', 'unknown', 'approved', 'sent']);
    expect(mercury.OPEN_STATES).toEqual(expect.arrayContaining(['paper']));
  });

  test('the error line keeps only a status and a short code', () => {
    expect(mercury.failureText({ status: 400, code: 'InvalidRecipient' })).toBe('Mercury refused the request (HTTP 400): InvalidRecipient');
    expect(mercury.failureText({ status: null, code: null })).toBe('Mercury refused the request');
  });
});

describe('linking a Mercury request to an unknown payment', () => {
  const payment = { recipient_id: 'rec-1', account_id: 'acct-1', amount_cents: '81240', created_at: '2026-11-02T14:00:00Z' };
  const request = { recipientId: 'rec-1', accountId: 'acct-1', amountCents: 81240, createdAt: '2026-11-02T14:00:30Z', status: 'pendingApproval' };

  test('a request of this attempt links, whatever its state', () => {
    for (const status of ['pendingApproval', 'approved', 'rejected', 'cancelled']) expect(mercury.linkMismatch(payment, { ...request, status })).toBeNull();
    // Up to 10 minutes before the attempt is allowed (clock slack).
    expect(mercury.linkMismatch(payment, { ...request, createdAt: '2026-11-02T13:51:00Z' })).toBeNull();
  });

  test.each([
    ['recipient', { recipientId: 'rec-2' }, /different recipient/],
    ['account', { accountId: 'acct-2' }, /different Mercury account/],
    ['amount (one cent)', { amountCents: 81241 }, /different amount/],
    ['too early', { createdAt: '2026-11-02T13:49:00Z' }, /before this payment was tried/],
    ['no date', { createdAt: null }, /before this payment was tried/],
    ['a state it cannot link', { status: 'somethingNew' }, /state this page cannot link/],
  ])('refuses a request with the wrong %s, in plain words', (_name, patch, words) => {
    expect(mercury.linkMismatch(payment, { ...request, ...patch })).toMatch(words);
  });
});

describe('bells follow the admin notification rules', () => {
  const payment = { id: '33333333-3333-4333-8333-333333333333', check_id: 'c1', amountCents: 123456, postedOn: '2026-12-01' };
  const names = ['Sample Employee', 'Alexandria Montgomery-Featherstonehaugh', 'Al'];

  test.each(Object.keys(alerts.EVENTS))('%s composes for short and very long names (the helper throws on a rule break in tests)', (event) => {
    for (const name of names) {
      const spec = alerts.specFor(event, payment, { name, payDate: '2026-11-27' });
      const composed = composeAdminAlert(spec);
      expect(composed.headline.length).toBeLessThanOrEqual(60);
      expect(composed.why.length).toBeLessThanOrEqual(110);
      expect(composed.metadata).toMatchObject({ area: 'Billing', severity: 'needs-you', subject: { type: 'check', id: payment.id } });
      expect(composed.link).toBe('/admin/timetracking?tab=payroll');
    }
  });

  test('a re-raised month-mismatch bell reads a posted date that pg returns as a Date (Codex P2 on #7213)', async () => {
    const raise = jest.fn(async () => ({ id: 1 }));
    const conn = () => ({ where: () => ({ first: async () => ({ employee_name: 'Sample Employee', pay_date: '2026-09-25' }) }) });
    conn.raw = (x) => x;
    // pg's default DATE parser: local midnight of the stored day.
    const postedOn = new Date(2026, 9, 1);
    await alerts.raisePaymentAlert('month_mismatch', { id: payment.id, check_id: 'c1', amount_cents: 123456, posted_on: postedOn }, { conn, raise });
    const [, spec] = raise.mock.calls[0];
    expect(spec.why).toMatch(/Oct 1/);
    expect(spec.why).not.toMatch(/posted {2}but/);
  });

  test('every payment bell rings by default (bellDefault, never bell: true) with a key per payment and event', async () => {
    const raise = jest.fn(async () => ({ id: 1 }));
    const conn = () => ({ where: () => ({ first: async () => ({ employee_name: 'Sample Employee', pay_date: '2026-11-27' }) }), raw: (x) => x });
    conn.raw = (x) => x;
    expect(await alerts.raisePaymentAlert('failed', { id: payment.id, check_id: 'c1', amount_cents: 123456 }, { conn, raise })).toBe(true);
    const [category, spec, opts] = raise.mock.calls[0];
    expect(category).toBe('payroll');
    expect(spec.who).toBe('person');
    expect(opts).toMatchObject({ bellDefault: true, dedupeKey: `payroll-pay:${payment.id}:failed` });
    expect(opts.bell).toBeUndefined();
  });

  test('a bell that cannot be written never throws', async () => {
    const raise = jest.fn(async () => { throw new Error('db down'); });
    const conn = () => ({ where: () => ({ first: async () => null }) });
    conn.raw = (x) => x;
    await expect(alerts.raisePaymentAlert('failed', { id: payment.id, check_id: 'c1', amount_cents: 100 }, { conn, raise })).resolves.toBe(false);
  });

  test('the key bell composes and carries its own key', async () => {
    const raise = jest.fn(async (_c, spec) => { composeAdminAlert(spec); return { id: 2 }; });
    expect(await alerts.raiseKeyAlert({ raise })).toBe(true);
    expect(raise.mock.calls[0][2]).toMatchObject({ dedupeKey: 'payroll-mercury-key', dedupeOpenOnly: true, bellDefault: true });
  });

  test('a refused send request has its own key bell, so a good read cannot clear it', async () => {
    const raise = jest.fn(async (_c, spec) => { composeAdminAlert(spec); return { id: 3 }; });
    await alerts.raiseKeyAlert({ kind: 'send', raise });
    expect(raise.mock.calls[0][2]).toMatchObject({ dedupeKey: 'payroll-mercury-key-send' });
    const episodes = { openAdminAlertKeys: jest.fn(), closeAdminAlertKeys: jest.fn(async () => 1) };
    await alerts.closeKeyBell({ conn: {}, episodes });
    expect(episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['payroll-mercury-key']);
    await alerts.closeKeyBell({ kind: 'send', conn: {}, episodes });
    expect(episodes.closeAdminAlertKeys.mock.calls[1][1]).toEqual(['payroll-mercury-key-send']);
  });
});

describe('poller decisions', () => {
  const row = {
    id: 'p1', state: 'requested', mercury_request_id: 'req-1', amount_cents: 81240, recipient_id: 'rec-1', note: 'waves-pay:p1',
    created_at: '2026-11-02T14:00:00Z', posted_on: null, mercury_transaction_id: null,
  };

  test('a pending request keeps the row as it is; approved moves it; rejected and cancelled close it with a bell', () => {
    expect(poller.patchForRequest({ status: 'pendingApproval' }).patch).toEqual({});
    expect(poller.patchForRequest({ status: 'approved' })).toMatchObject({ patch: { state: 'approved' }, bell: null });
    expect(poller.patchForRequest({ status: 'rejected' })).toMatchObject({ patch: { state: 'rejected' }, bell: 'rejected' });
    expect(poller.patchForRequest({ status: 'cancelled' })).toMatchObject({ patch: { state: 'cancelled' }, bell: 'cancelled' });
    expect(poller.patchForRequest({ status: 'somethingNew' }).patch).toEqual({});
  });

  test('an approved request: a pending transaction is only linked, a sent one is sent with the day it posted, a failed one fails', () => {
    const tx = (status, extra = {}) => ({ id: 'tx-1', status, amountCents: 81240, postedAt: '2026-11-04T15:00:00Z', failedAt: null, ...extra });
    expect(poller.patchForTransaction(row, null).patch).toEqual({});
    expect(poller.patchForTransaction(row, tx('pending')).patch).toEqual({ mercury_transaction_id: 'tx-1' });
    expect(poller.patchForTransaction(row, tx('sent')).patch).toMatchObject({ state: 'sent', mercury_transaction_id: 'tx-1', posted_on: '2026-11-04' });
    expect(poller.patchForTransaction(row, tx('sent', { hasReturn: true }))).toMatchObject({ patch: { state: 'returned' }, bell: 'returned' });
    expect(poller.patchForTransaction(row, tx('failed'))).toMatchObject({ patch: { state: 'failed' }, bell: 'failed' });
    expect(poller.patchForTransaction(row, tx('reversed'))).toMatchObject({ patch: { state: 'returned' }, bell: 'returned' });
  });

  test('the transaction is the one carrying the request id and the amount', () => {
    const txs = [
      { id: 'a', requestId: 'other', amountCents: 81240, note: null, counterpartyId: 'rec-1' },
      { id: 'b', requestId: 'req-1', amountCents: 100, note: null, counterpartyId: 'rec-1' },
      { id: 'c', requestId: 'req-1', amountCents: 81240, note: null, counterpartyId: 'rec-1' },
    ];
    expect(poller.transactionFor(row, txs).id).toBe('c');
    expect(poller.transactionFor(row, [txs[0], txs[1]])).toBeNull();
    // Without a request id link, our note + amount + recipient still finds it.
    // The transaction already linked to the payment is found by its id.
    expect(poller.transactionFor({ ...row, mercury_transaction_id: 'z' }, [{ id: 'z', requestId: null, amountCents: 1, note: null, counterpartyId: 'x' }]).id).toBe('z');
    expect(poller.transactionFor(row, [{ id: 'd', requestId: null, amountCents: 81240, note: 'waves-pay:p1', counterpartyId: 'rec-1' }]).id).toBe('d');
  });

  test('a sent payment read again: a failed, reversed or refunded transaction is returned; a posted day fills in once', () => {
    const sent = { ...row, state: 'sent' };
    expect(poller.patchForSentReread(sent, { status: 'sent', hasReturn: false, postedAt: null })).toEqual({ patch: {}, bell: null });
    expect(poller.patchForSentReread(sent, { status: 'sent', hasReturn: false, postedAt: '2026-11-05T01:00:00Z' }).patch).toEqual({ posted_on: '2026-11-04' });
    expect(poller.patchForSentReread(sent, { status: 'failed' })).toMatchObject({ patch: { state: 'returned' }, bell: 'returned' });
    expect(poller.patchForSentReread(sent, { status: 'sent', hasReturn: true })).toMatchObject({ patch: { state: 'returned' } });
    expect(poller.patchForSentReread({ ...sent, posted_on: '2026-11-04' }, { status: 'sent', hasReturn: false, postedAt: '2026-11-04T15:00:00Z' }).patch).toEqual({});
  });

  test('an unknown payment: our note links it; a same-amount request without it is only probably ours; nothing stays unknown', () => {
    const unknown = { ...row, state: 'unknown', mercury_request_id: null };
    const base = { recipientId: 'rec-1', createdAt: '2026-11-02T14:00:30Z', status: 'pendingApproval' };
    expect(poller.matchUnknown(unknown, [{ ...base, requestId: 'r9', amountCents: 81240, memo: 'waves-pay:p1' }])).toMatchObject({ kind: 'ours', request: { requestId: 'r9' } });
    expect(poller.matchUnknown(unknown, [{ ...base, requestId: 'r9', amountCents: 81240, memo: null }])).toEqual({ kind: 'probably_ours' });
    expect(poller.matchUnknown(unknown, [{ ...base, requestId: 'r9', amountCents: 5000, memo: null }])).toEqual({ kind: 'none' });
    expect(poller.matchUnknown(unknown, [{ ...base, recipientId: 'rec-2', requestId: 'r9', amountCents: 81240, memo: 'waves-pay:p1' }])).toEqual({ kind: 'none' });
    expect(poller.matchUnknown(unknown, [{ ...base, createdAt: '2026-11-01T10:00:00Z', requestId: 'r9', amountCents: 81240, memo: 'waves-pay:p1' }])).toEqual({ kind: 'none' });
    expect(poller.matchUnknown(unknown, [{ ...base, status: 'rejected', requestId: 'r9', amountCents: 81240, memo: null }])).toEqual({ kind: 'none' });
  });

  test('our note alone never links: the amount and account must match too, else a person reviews it', () => {
    const unknown = { ...row, account_id: 'acct-1', state: 'unknown', mercury_request_id: null };
    const base = { recipientId: 'rec-1', createdAt: '2026-11-02T14:00:30Z', status: 'approved', memo: 'waves-pay:p1', requestId: 'r9' };
    expect(poller.matchUnknown(unknown, [{ ...base, amountCents: 81240, accountId: unknown.account_id }])).toMatchObject({ kind: 'ours', request: { requestId: 'r9' } });
    expect(poller.matchUnknown(unknown, [{ ...base, amountCents: 81241, accountId: unknown.account_id }])).toEqual({ kind: 'probably_ours' });
    expect(poller.matchUnknown(unknown, [{ ...base, amountCents: 81240, accountId: 'another-account' }])).toEqual({ kind: 'probably_ours' });
  });

  test('gates off: the poll returns before any Mercury call or query', async () => {
    const client = { configured: true, getRequest: jest.fn(), listRequests: jest.fn(), listTransactions: jest.fn() };
    const conn = jest.fn();
    delete process.env.GATE_PAYROLL_MERCURY_STATUS;
    process.env.GATE_PAYROLL = 'true';
    expect(await poller.pollPayments({ client, conn })).toMatchObject({ skipped: 'gate_off' });
    process.env.GATE_PAYROLL_MERCURY_STATUS = 'true';
    delete process.env.GATE_PAYROLL;
    expect(await poller.pollPayments({ client, conn })).toMatchObject({ skipped: 'gate_off' });
    expect(client.getRequest).not.toHaveBeenCalled();
    expect(client.listRequests).not.toHaveBeenCalled();
    expect(conn).not.toHaveBeenCalled();
    delete process.env.GATE_PAYROLL_MERCURY_STATUS;
  });

  test('gates on but no key: the poll reads nothing', async () => {
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_MERCURY_STATUS = 'true';
    const conn = jest.fn();
    expect(await poller.pollPayments({ client: { configured: false }, conn })).toMatchObject({ skipped: 'not_configured' });
    expect(conn).not.toHaveBeenCalled();
    delete process.env.GATE_PAYROLL_MERCURY_STATUS;
    delete process.env.GATE_PAYROLL;
  });
});

describe('the routes answer 404 until their gate is on, and make no Mercury call', () => {
  let server;
  let baseUrl;
  const KEYS = ['GATE_PAYROLL', 'GATE_PAYROLL_MERCURY_STATUS', 'GATE_PAYROLL_MERCURY_PAY', 'MERCURY_API_TOKEN', 'MERCURY_ACCOUNT_ID'];
  const OLD = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const ID = '44444444-4444-4444-8444-444444444444';
  const call = (method, path, body) => fetch(`${baseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let realFetch;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payroll`;
    realFetch = global.fetch;
  });
  afterAll(async () => {
    await new Promise((resolve) => { server.close(resolve); });
    for (const key of KEYS) { if (OLD[key] === undefined) delete process.env[key]; else process.env[key] = OLD[key]; }
  });
  beforeEach(() => {
    process.env.GATE_PAYROLL = 'true';
    delete process.env.GATE_PAYROLL_MERCURY_STATUS;
    delete process.env.GATE_PAYROLL_MERCURY_PAY;
    process.env.MERCURY_API_TOKEN = 'token-for-tests';
    process.env.MERCURY_ACCOUNT_ID = '55555555-5555-4555-8555-555555555555';
  });

  const NEW_ROUTES = [
    ['PUT', `/technicians/${ID}/mercury-recipient`, { recipientId: null }, 'status'],
    ['GET', `/runs/${ID}/send-preview`, undefined, 'status'],
    ['POST', `/checks/${ID}/paper`, { checkNumber: '1001' }, 'status'],
    ['POST', `/payments/${ID}/link-request`, { requestId: 'req-1' }, 'status'],
    ['POST', `/runs/${ID}/send`, {}, 'pay'],
    ['POST', `/checks/${ID}/send-again`, {}, 'pay'],
  ];

  test.each(NEW_ROUTES)('%s %s with both gates off: 404 before any query, no network', async (method, path, body) => {
    const spy = jest.spyOn(global, 'fetch');
    const res = await call(method, path, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ enabled: false });
    // The only fetch is the test's own call to this server.
    expect(spy.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1'))).toBe(true);
    spy.mockRestore();
  });

  test.each(NEW_ROUTES.filter((r) => r[3] === 'pay'))('%s %s with only the status gate on: still 404', async (method, path, body) => {
    process.env.GATE_PAYROLL_MERCURY_STATUS = 'true';
    expect((await call(method, path, body)).status).toBe(404);
  });

  test.each(NEW_ROUTES)('%s %s with only the pay gate on: 404, because pay needs status too', async (method, path, body) => {
    process.env.GATE_PAYROLL_MERCURY_PAY = 'true';
    expect((await call(method, path, body)).status).toBe(404);
  });

  test('a value other than exactly true is off', async () => {
    process.env.GATE_PAYROLL_MERCURY_STATUS = 'TRUE';
    process.env.GATE_PAYROLL_MERCURY_PAY = '1';
    expect((await call('POST', `/runs/${ID}/send`, {})).status).toBe(404);
    expect((await call('GET', `/runs/${ID}/send-preview`)).status).toBe(404);
  });

  test('GATE_PAYROLL off answers 404 for all of them too', async () => {
    delete process.env.GATE_PAYROLL;
    process.env.GATE_PAYROLL_MERCURY_STATUS = 'true';
    process.env.GATE_PAYROLL_MERCURY_PAY = 'true';
    for (const [method, path, body] of NEW_ROUTES) expect((await call(method, path, body)).status).toBe(404);
    global.fetch = realFetch;
  });
});
