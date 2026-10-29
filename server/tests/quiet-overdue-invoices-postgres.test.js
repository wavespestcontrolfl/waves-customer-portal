// Quiet overdue invoices (owner 2026-10-24): the candidate query against a
// real PostgreSQL in a disposable schema (skipped without
// APP_TEST_DATABASE_URL, run for real in CI). Proves the SQL side: the
// published / homeowner-billed / unarchived / money-due / no-plan /
// no-open-customer-schedule filters, and the Eastern-calendar ages behind the
// 7-day Auto Pay hold and 14-day quiet thresholds (a DATE due_date, the hold
// counted from the later of the row's last change, when it entered the hold,
// and the due date).
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const database = (...args) => mockDatabase(...args);
  database.raw = (...args) => mockDatabase.raw(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Quiet = require('../services/quiet-overdue-invoices');

const { candidatesQuery, listItems } = Quiet._private;
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `quiet_overdue_${randomUUID().replaceAll('-', '')}`;
jest.setTimeout(60000);

// Monday 2026-10-26 11:47 ET (the cron's tick). Eastern "today" = 2026-10-26.
const NOW = new Date('2026-10-26T15:47:00Z');

postgres('quiet overdue invoices query (PostgreSQL)', () => {
  let admin;
  let app;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    mockDatabase = app;
    // The columns the query reads, with production's types.
    await app.schema.createTable('customers', (t) => { t.uuid('id').primary(); t.text('first_name'); t.text('last_name'); t.timestamp('deleted_at'); });
    await app.schema.createTable('invoices', (t) => {
      t.uuid('id').primary();
      t.string('invoice_number');
      t.uuid('customer_id');
      t.string('status');
      t.decimal('total', 10, 2).notNullable().defaultTo(0);
      t.decimal('credit_applied', 10, 2).notNullable().defaultTo(0);
      t.decimal('amount_paid', 10, 2).notNullable().defaultTo(0);
      t.date('due_date');
      t.timestamp('sent_at');
      t.timestamp('sms_sent_at');
      t.timestamp('created_at').defaultTo(app.fn.now());
      t.uuid('payer_id');
      t.text('scheduled_send_error');
      t.timestamp('archived_at');
    });
    await app.schema.createTable('invoice_followup_sequences', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('invoice_id').unique();
      t.uuid('customer_id');
      t.string('status', 20);
      t.timestamp('next_touch_at');
      t.timestamp('paused_until');
      t.text('stopped_reason');
      t.uuid('stopped_by_admin_id');
      t.integer('autopay_failures_observed').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(app.fn.now());
      t.timestamp('updated_at').defaultTo(app.fn.now());
    });
    await app.schema.createTable('payment_plans', (t) => { t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.uuid('invoice_id'); t.string('status'); });
    await app.schema.createTable('customer_dunning_schedules', (t) => { t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.uuid('customer_id'); t.string('status'); });
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  beforeEach(async () => {
    for (const table of ['customer_dunning_schedules', 'payment_plans', 'invoice_followup_sequences', 'invoices', 'customers']) await app(table).del();
  });

  async function customer(over = {}) {
    const id = randomUUID();
    await app('customers').insert({ id, first_name: 'Pat', last_name: 'Synthetic', ...over });
    return id;
  }

  // dueDate: 'YYYY-MM-DD' (a DATE, like production). seq: null = no sequence row.
  async function invoice(number, { customerId = null, dueDate, status = 'viewed', total = 100, credit = 0, seq = { status: 'completed' }, ...over }) {
    const id = randomUUID();
    const cust = customerId || await customer();
    await app('invoices').insert({
      id, invoice_number: number, customer_id: cust, status, total, credit_applied: credit,
      due_date: dueDate, sent_at: new Date(`${dueDate}T14:00:00Z`), ...over,
    });
    if (seq) await app('invoice_followup_sequences').insert({ invoice_id: id, customer_id: cust, ...seq });
    return { id, customerId: cust };
  }

  const listed = async () => listItems(await candidatesQuery(NOW, app), NOW);

  test('the quiet states past their thresholds are listed, oldest first, with Eastern-calendar ages', async () => {
    await invoice('FINISHED', { dueDate: '2026-06-01', total: 996 });
    await invoice('PAUSED', { dueDate: '2026-07-07', seq: { status: 'paused' } });
    await invoice('NEVER', { dueDate: '2026-08-13', seq: null });
    await invoice('STOPPED', { dueDate: '2026-08-25', seq: { status: 'stopped', stopped_reason: 'Check', stopped_by_admin_id: randomUUID() } });
    await invoice('HOLD', { dueDate: '2026-10-08', seq: { status: 'autopay_hold', created_at: new Date('2026-10-14T16:00:00Z'), updated_at: new Date('2026-10-14T16:00:00Z') } });
    const items = await listed();
    expect(items.map((i) => [i.invoiceNumber, i.reason, i.daysLate])).toEqual([
      ['FINISHED', 'finished', 147],
      ['PAUSED', 'paused', 111],
      ['NEVER', 'never_set_up', 74],
      ['STOPPED', 'stopped', 62],
      ['HOLD', 'autopay_hold', 18],
    ]);
    expect(items.find((i) => i.invoiceNumber === 'HOLD').holdDays).toBe(12);
  });

  test('thresholds: 14 days late for a quiet ladder, 7 days on hold for Auto Pay (from the later of entering the hold and the due date)', async () => {
    const created = new Date('2026-09-01T15:00:00Z'); // every sequence here is weeks old; only entering the hold counts
    await invoice('LATE-14', { dueDate: '2026-10-12' });
    await invoice('LATE-13', { dueDate: '2026-10-13' });
    // Due 20 days ago, but a paused row that entered the hold Oct 20 (6 days): not yet.
    await invoice('HOLD-6', { dueDate: '2026-10-06', seq: { status: 'autopay_hold', created_at: created, updated_at: new Date('2026-10-20T15:00:00Z') } });
    // Entered the hold late in the Eastern evening (Oct 19 23:30 ET is Oct 20 03:30Z): 7 Eastern days.
    await invoice('HOLD-7', { dueDate: '2026-10-01', seq: { status: 'autopay_hold', created_at: created, updated_at: new Date('2026-10-20T03:30:00Z') } });
    // Held since before the due date: the clock starts at the due date.
    await invoice('HOLD-DUE', { dueDate: '2026-10-19', seq: { status: 'autopay_hold', created_at: created, updated_at: new Date('2026-10-01T15:00:00Z') } });
    const items = await listed();
    expect(items.map((i) => i.invoiceNumber).sort()).toEqual(['HOLD-7', 'HOLD-DUE', 'LATE-14']);
    expect(items.filter((i) => i.reason === 'autopay_hold').map((i) => i.holdDays)).toEqual([7, 7]);
    expect(items.find((i) => i.invoiceNumber === 'LATE-14').daysLate).toBe(14);
  });

  test('a reminder still coming, or a pause with its end ahead, is not quiet; a passed end is', async () => {
    await invoice('ACTIVE', { dueDate: '2026-08-01', seq: { status: 'active', next_touch_at: new Date('2026-10-28T14:00:00Z') } });
    await invoice('ACTIVE-NONE', { dueDate: '2026-08-01', seq: { status: 'active', next_touch_at: null } });
    await invoice('PAUSE-AHEAD', { dueDate: '2026-08-01', seq: { status: 'paused', paused_until: new Date('2026-11-02T14:00:00Z') } });
    await invoice('PAUSE-PASSED', { dueDate: '2026-08-01', seq: { status: 'paused', paused_until: new Date('2026-10-02T14:00:00Z') } });
    expect((await listed()).map((i) => [i.invoiceNumber, i.reason]).sort()).toEqual([
      ['ACTIVE-NONE', 'unscheduled'],
      ['PAUSE-PASSED', 'pause_ended'],
    ]);
  });

  test('never listed: unpublished or settled, payer-billed or withdrawn, archived, deleted customer, nothing due, a payment plan, or an open customer-level schedule', async () => {
    const due = '2026-07-01';
    await invoice('KEEP', { dueDate: due });
    await invoice('DRAFT', { dueDate: due, status: 'draft' });
    await invoice('PAID', { dueDate: due, status: 'paid' });
    await invoice('PROCESSING', { dueDate: due, status: 'processing' });
    await invoice('PAYER', { dueDate: due, payer_id: randomUUID() });
    await invoice('WITHDRAWN', { dueDate: due, scheduled_send_error: 'payer_billed:withdrawn' });
    await invoice('ARCHIVED', { dueDate: due, archived_at: new Date('2026-09-01T12:00:00Z') });
    await invoice('DELETED', { dueDate: due, customerId: await customer({ deleted_at: new Date('2026-09-01T12:00:00Z') }) });
    await invoice('CREDITED', { dueDate: due, total: 80, credit: 80 });
    const planned = await invoice('PLAN', { dueDate: due });
    await app('payment_plans').insert({ invoice_id: planned.id, status: 'active' });
    const ended = await invoice('PLAN-ENDED', { dueDate: due });
    await app('payment_plans').insert({ invoice_id: ended.id, status: 'completed' });
    const owned = await invoice('ENGINE', { dueDate: due });
    await app('customer_dunning_schedules').insert({ customer_id: owned.customerId, status: 'held' });
    const released = await invoice('ENGINE-DONE', { dueDate: due });
    await app('customer_dunning_schedules').insert({ customer_id: released.customerId, status: 'completed' });
    expect((await listed()).map((i) => i.invoiceNumber).sort()).toEqual(['ENGINE-DONE', 'KEEP', 'PLAN-ENDED']);
  });

  test('an unsent invoice falls back to when it went out for its age', async () => {
    const id = randomUUID();
    const cust = await customer();
    await app('invoices').insert({ id, invoice_number: 'NO-DUE', customer_id: cust, status: 'sent', total: 50, due_date: null, sms_sent_at: new Date('2026-10-01T02:00:00Z') });
    const [item] = await listed();
    // Oct 1 02:00Z is Sep 30 at 10 PM Eastern: 26 Eastern days before Oct 26.
    expect(item).toMatchObject({ invoiceNumber: 'NO-DUE', reason: 'never_set_up', daysLate: 26 });
  });
});
