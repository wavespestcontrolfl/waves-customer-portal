// Real PostgreSQL transactions (rolled back): GATE_MONEY_NOTICE_CATCHUP on the annual-prepay
// 30/15/7 notice ladder (owner 2026-11-06, "jobs 1-6"). A notice whose day passed at most 3
// days ago and is still unsent goes out once; the stamped sent column keeps the next day's
// run from sending it again; a 4-day-late notice, a notice whose later rung already went out,
// and a freshly claimed notice are never sent. Gate off, the late notice is not sent.
// Messaging is faked; names are synthetic. Harness from prepay-year-end-bell-postgres.test.js.
// The exact marker line CI's DB-gated step greps for (.github/workflows/tests.yml); any other gate form never runs there.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(), classifyDeliveryCertainty: jest.fn(() => 'sent'),
}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipRenewalReminder: jest.fn(async () => ({ sent: false, reason: 'test_no_email' })),
  sendTermiteRenewalReminder: jest.fn(), findAcceptedTermiteRenewalReminder: jest.fn(async () => null),
}));

const { randomUUID } = require('node:crypto');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendMembershipRenewalReminder } = require('../services/account-membership-email');
const { _private } = require('../services/annual-prepay-renewals');

const TODAY = '2026-11-10';
const plus = (n, from = TODAY) => _private.addDaysYmd(from, n);

jest.setTimeout(30000);
postgres('annual-prepay notice catch-up (PostgreSQL)', () => {
  let database;
  let trx;

  const customer = async () => {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Sample', last_name: 'Owner', phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      email: `${id}@example.invalid`, billing_mode: 'annual_prepay', active: true,
    });
    return id;
  };
  const term = async (termEnd, fields = {}) => {
    const id = randomUUID();
    await trx('annual_prepay_terms').insert({
      id, customer_id: await customer(), status: 'active', term_start: plus(-365, termEnd), term_end: termEnd,
      prepay_amount: 444.6, plan_label: 'Synthetic Annual', ...fields,
    });
    return id;
  };
  const row = (id) => trx('annual_prepay_terms').where({ id }).first();
  const ladder = (today = TODAY) => _private.runGenericNoticeLadder(today, true);

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    renderSmsTemplate.mockResolvedValue('Hi Sample, your prepaid year with Waves ends soon.');
    sendCustomerMessage.mockImplementation(async () => ({ sent: true, deliveryOutcome: 'accepted', sentAt: new Date() }));
    delete process.env.GATE_MONEY_NOTICE_CATCHUP;
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });
  afterEach(async () => {
    delete process.env.GATE_MONEY_NOTICE_CATCHUP;
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  test('gate off: a 30-day notice whose day was 2 days ago is not sent (exact day only)', async () => {
    const id = await term(plus(28));
    expect(await ladder()).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await row(id)).notice_30_sent_at).toBeNull();
  });

  test('gate on: that notice goes out once, and the next day\'s run does not send it again', async () => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    const id = await term(plus(28));
    expect(await ladder()).toBe(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ annual_prepay_term_id: id, days_out: 30 });
    // The email states the 28 days actually left; the rung keys the send (Codex #7715).
    expect(sendMembershipRenewalReminder).toHaveBeenCalledWith(expect.objectContaining({ daysOut: 30, noticeDaysLeft: 28 }));
    expect((await row(id)).notice_30_sent_at).toBeInstanceOf(Date);

    expect(await ladder(plus(1))).toBe(0); // 27 days out: still inside the 30 window, already sent
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('gate on: the on-time notice is unchanged (exact day still matches)', async () => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    const id = await term(plus(15));
    expect(await ladder()).toBe(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ annual_prepay_term_id: id, days_out: 15 });
  });

  test('gate on: a notice 4 days late is never sent (the 3-day bound)', async () => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    await term(plus(26));
    await term(plus(11));
    await term(plus(3));
    expect(await ladder()).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('gate on: a late 15-day notice is not sent once the 7-day notice went out', async () => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    const id = await term(plus(13), { notice_7_sent_at: new Date('2026-11-01T15:00:00Z') });
    expect(await ladder()).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await row(id)).notice_15_sent_at).toBeNull();
  });

  test('gate on: a fresh claim on the rung (a send in flight) blocks the catch-up', async () => {
    process.env.GATE_MONEY_NOTICE_CATCHUP = 'true';
    await term(plus(29), { notice_30_claimed_at: new Date() });
    expect(await ladder()).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
