// Real migration and query proof, synthetic rows in this worktree's private QA.
let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  Object.defineProperty(database, 'schema', { get: () => mockPg.schema });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-credit', () => ({ autoApplyAccountCreditIfEnabled: jest.fn(async () => null), reverseAppliedCredit: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(), classifyDeliveryCertainty: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn(async () => null) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url), invoiceShortCodePrefix: () => 'qa' }));
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const annual = require('../services/annual-prepay-renewals');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const migration = require('../models/migrations/20260927000001_annual_prepay_reminder_attempt_date');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = 'annual_resume_' + randomUUID().replaceAll('-', '');
const today = etDateString();
const visit = etDateString(addETDays(new Date(), 3));
const tomorrow = etDateString(addETDays(new Date(), 1));
let admin;

postgres('annual reminder resumption and migration (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const owned = process.env.WAVES_LOCAL_DEV === '1'
      && target.pathname === '/waves_qa_' + process.env.WAVES_WORKTREE_ID.replaceAll('-', '');
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!owned && !ci) throw new Error('Use this worktree private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await mockPg.schema.createTable('annual_prepay_terms', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.uuid('prepay_invoice_id');
      table.text('status'); table.date('term_start'); table.date('first_visit_date'); table.timestamp('updated_at');
      for (const stage of [3, 1]) {
        table.timestamp('payment_reminder_' + stage + 'd_sent_at'); table.timestamp('payment_reminder_' + stage + 'd_claimed_at');
      }
    });
    await mockPg.schema.createTable('invoices', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.text('status'); table.text('token');
      table.decimal('total'); table.decimal('credit_applied'); table.uuid('payer_id'); table.timestamp('paid_at');
    });
    await mockPg.schema.createTable('customers', (table) => {
      table.uuid('id').primary(); table.text('first_name'); table.text('phone'); table.timestamp('deleted_at');
    });
    await mockPg.schema.createTable('notification_prefs', (table) => { table.uuid('customer_id').primary(); table.jsonb('billing_channels'); });
    await mockPg.schema.createTable('invoice_followup_sequences', (table) => {
      table.uuid('invoice_id'); table.text('status'); table.timestamp('last_touch_at'); table.timestamp('next_touch_at');
    });
    await migration.up(mockPg);
  }, 30000);
  beforeEach(async () => {
    jest.clearAllMocks(); annual._private.resetCachesForTests();
    for (const table of ['annual_prepay_terms', 'invoices', 'customers', 'notification_prefs']) await mockPg(table).delete();
  });
  afterAll(async () => { await mockPg?.destroy(); if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); } });

  async function fixture({ channels = ['email'], marker = null, marker1d = null, firstVisit = visit } = {}) {
    const customerId = randomUUID(); const invoiceId = randomUUID(); const id = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', phone: '+12025550123' });
    await mockPg('notification_prefs').insert({ customer_id: customerId, billing_channels: channels === null ? null : JSON.stringify(channels) });
    await mockPg('invoices').insert({ id: invoiceId, customer_id: customerId, status: 'draft', total: 392.04, token: randomUUID() });
    await mockPg('annual_prepay_terms').insert({ id, customer_id: customerId, prepay_invoice_id: invoiceId,
      status: 'payment_pending', term_start: visit, first_visit_date: firstVisit,
      payment_reminder_3d_attempted_for: marker, payment_reminder_1d_attempted_for: marker1d });
    return { id, customerId, term: await mockPg('annual_prepay_terms').where({ id }).first() };
  }

  test('up/down is idempotent, adds nullable DATE markers without backfilling attempt evidence', async () => {
    const f = await fixture();
    await migration.up(mockPg);
    expect((await mockPg('annual_prepay_terms').columnInfo()).payment_reminder_3d_attempted_for)
      .toMatchObject({ type: 'date', nullable: true });
    expect((await mockPg('annual_prepay_terms').columnInfo()).payment_reminder_1d_attempted_for)
      .toMatchObject({ type: 'date', nullable: true });
    const before = await mockPg('annual_prepay_terms').where({ id: f.id }).first();
    expect(before.payment_reminder_3d_attempted_for).toBeNull();
    expect(before.payment_reminder_1d_attempted_for).toBeNull();
    await migration.down(mockPg); await migration.down(mockPg);
    expect(await mockPg.schema.hasColumn('annual_prepay_terms', 'payment_reminder_3d_attempted_for')).toBe(false);
    expect(await mockPg.schema.hasColumn('annual_prepay_terms', 'payment_reminder_1d_attempted_for')).toBe(false);
    await migration.up(mockPg); await migration.up(mockPg);
    expect((await mockPg('annual_prepay_terms').where({ id: f.id }).first()).payment_reminder_3d_attempted_for).toBeNull();
    expect((await mockPg('annual_prepay_terms').where({ id: f.id }).first()).payment_reminder_1d_attempted_for).toBeNull();
  });

  test('an invoice read failure leaves an explicit attempt resumable two days out', async () => {
    const f = await fixture();
    await mockPg.schema.renameTable('invoices', 'invoices_unavailable');
    try { await expect(annual.sendPaymentPendingReminder(f.term, 3)).rejects.toThrow(); }
    finally { await mockPg.schema.renameTable('invoices_unavailable', 'invoices'); }
    const term = await mockPg('annual_prepay_terms').where({ id: f.id }).first();
    expect(dateOnlyString(term.payment_reminder_3d_attempted_for)).toBe(visit);
    expect(term.payment_reminder_3d_claimed_at).toBeNull();
    await annual.checkAndSendPaymentReminders({ today: tomorrow });
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a failed legacy attempt cannot become a resumed episode after selecting Email', async () => {
    const f = await fixture({ channels: null });
    await annual.sendPaymentPendingReminder(f.term, 3);
    expect((await mockPg('annual_prepay_terms').where({ id: f.id }).first()).payment_reminder_3d_attempted_for).toBeNull();
    await mockPg('notification_prefs').where({ customer_id: f.customerId }).update({ billing_channels: JSON.stringify(['email']) });
    renderSmsTemplate.mockClear();
    await annual.checkAndSendPaymentReminders({ today: tomorrow });
    expect(renderSmsTemplate).not.toHaveBeenCalled();
  });

  test.each([
    ['never attempted', { marker: null }], ['moved visit', { marker: visit, firstVisit: etDateString(addETDays(new Date(), 5)) }],
    ['mismatched date', { marker: tomorrow }], ['cleared choice', { marker: visit, channels: null }],
    ['empty choice', { marker: visit, channels: [] }], ['contextless choice', { marker: visit, channels: { sms: true } }],
  ])('does not resume a %s term', async (_label, opts) => {
    await fixture(opts);
    await annual.checkAndSendPaymentReminders({ today: tomorrow });
    expect(renderSmsTemplate).not.toHaveBeenCalled(); expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a legacy term date can resume its explicitly attempted episode', async () => {
    await fixture({ marker: visit, firstVisit: null });
    await annual.checkAndSendPaymentReminders({ today: tomorrow });
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
  });

  test('the afternoon sweep retries the attempted 3-day day-two episode without starting a new one', async () => {
    await fixture({ marker: visit });
    await fixture();
    await annual.checkAndSendPaymentReminders({ today: tomorrow, retryStartedOnly: true });
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([
    { first_visit_date: tomorrow }, { customer_id: randomUUID() }, { prepay_invoice_id: randomUUID() },
  ])('a changed episode loses the conditional claim and cannot restamp evidence: %j', async (change) => {
    const f = await fixture();
    await mockPg('annual_prepay_terms').where({ id: f.id }).update(change);
    await expect(annual.sendPaymentPendingReminder(f.term, 3)).resolves.toEqual({ sent: false, reason: 'already_claimed' });
    expect((await mockPg('annual_prepay_terms').where({ id: f.id }).first()).payment_reminder_3d_attempted_for).toBeNull();
  });

  test('does not resume the 1-day stage two days out', async () => {
    await fixture();
    await annual.checkAndSendPaymentReminders({ today });
    renderSmsTemplate.mockClear();
    await annual.checkAndSendPaymentReminders({ today: tomorrow });
    // The marked explicit 3-day attempt alone resumes; there is no 1-day attempt.
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(renderSmsTemplate.mock.calls[0][2]).toMatchObject({ entity_type: 'annual_prepay_term' });
  });

  test('an unfinished explicit 1-day episode retries on the day before, even without an arrival hour', async () => {
    const f = await fixture({ firstVisit: tomorrow });
    await annual.sendPaymentPendingReminder(f.term, 1);
    const attempted = await mockPg('annual_prepay_terms').where({ id: f.id }).first();
    expect(dateOnlyString(attempted.payment_reminder_1d_attempted_for)).toBe(tomorrow);
    expect(attempted.payment_reminder_1d_claimed_at).toBeNull();
    renderSmsTemplate.mockClear();
    await annual.checkAndSendPaymentReminders({ today, retryStartedOnly: true });
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([
    [3, tomorrow, visit, { marker: visit }, false],
    [1, today, tomorrow, { marker1d: tomorrow }, true],
  ])('an attempted %i-day episode reaches its held final Email guard on the bounded retry day', async (daysOut, scanDate, firstVisit, marker, retryStartedOnly) => {
    const f = await fixture({ firstVisit, ...marker });
    const delivery = require('../services/billing-reminder-delivery');
    const progress = jest.spyOn(delivery, 'reminderProgress').mockResolvedValue([]);
    const dispatch = jest.spyOn(delivery, 'sendReminderChannels').mockImplementation(async (args) => {
      expect(args.eventKey).toBe(`annual-prepay-payment:${f.id}:${daysOut}`);
      const outcome = await args.send('email', { id: randomUUID() });
      return { complete: false, deliveredNow: [], results: { email: outcome } };
    });
    renderSmsTemplate.mockResolvedValue('Synthetic pay reminder');
    sendCustomerMessage.mockImplementation(async (input) => {
      const boundary = await mockPg.transaction((held) => input.preSendCheck({ database: held }));
      expect(boundary).toEqual({ ok: true });
      return { sent: true, deliveryOutcome: 'accepted' };
    });
    try {
      await expect(annual.checkAndSendPaymentReminders({ today: scanDate, retryStartedOnly })).resolves.toEqual({ sent: 1 });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
        annual_prepay_term_id: f.id, days_out: daysOut, first_visit_date: firstVisit,
      });
    } finally {
      progress.mockRestore(); dispatch.mockRestore();
    }
  });

  test.each([
    ['never attempted', { marker1d: null }],
    ['moved visit', { marker1d: tomorrow, firstVisit: etDateString(addETDays(new Date(), 2)) }],
    ['cleared choice', { marker1d: tomorrow, channels: null }],
    ['legacy choice', { marker1d: tomorrow, channels: [] }],
  ])('the afternoon sweep does not start a %s 1-day episode', async (_label, opts) => {
    await fixture({ firstVisit: tomorrow, ...opts });
    await annual.checkAndSendPaymentReminders({ today, retryStartedOnly: true });
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('visit-day retry does not select even a previously marked 1-day episode', async () => {
    await fixture({ firstVisit: today, marker1d: today });
    await annual.checkAndSendPaymentReminders({ today });
    await annual.checkAndSendPaymentReminders({ today, retryStartedOnly: true });
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the afternoon sweep leaves a claimed explicit episode to its current sender', async () => {
    const f = await fixture({ firstVisit: tomorrow, marker1d: tomorrow });
    await mockPg('annual_prepay_terms').where({ id: f.id })
      .update({ payment_reminder_1d_claimed_at: new Date() });
    await annual.checkAndSendPaymentReminders({ today, retryStartedOnly: true });
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
