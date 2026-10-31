/**
 * The office alert after a "report only, no pay link" completion (owner
 * 2026-10-30, tech portal gaps option A). Pure checks run everywhere; the
 * live-Postgres suite runs the whole pass (records -> invoice -> bell -> close)
 * inside a rolled-back transaction.
 */
// Every query the pass makes runs on the test's own transaction (rolled back
// after each test), the same stand-in invoice-issued-closeout-postgres uses.
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
const { randomUUID } = require('crypto');
const { _private: { stillOwed, alertSpec, alertKey } } = require('../services/report-only-payment-alert');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

describe('report-only payment alert: which bills still need the office', () => {
  const owed = { id: 'inv-1', status: 'draft', total: 129, amount_paid: 0, credit_applied: 0, payer_id: null };

  test('an open bill with a balance and no payer is owed, in any live status', () => {
    for (const status of ['draft', 'scheduled', 'sent', 'viewed', 'overdue']) {
      expect(stillOwed({ ...owed, status })).toBe(true);
    }
  });

  test('paid, voided, processing, payer-billed, withdrawn or zero-balance bills are not', () => {
    expect(stillOwed(null)).toBe(false);
    for (const status of ['paid', 'prepaid', 'processing', 'void', 'refunded', 'cancelled']) {
      expect(stillOwed({ ...owed, status })).toBe(false);
    }
    expect(stillOwed({ ...owed, amount_paid: 129 })).toBe(false);
    expect(stillOwed({ ...owed, credit_applied: 129 })).toBe(false);
    expect(stillOwed({ ...owed, payer_id: randomUUID() })).toBe(false);
    expect(stillOwed({ ...owed, scheduled_send_error: 'payer_billed:abc' })).toBe(false);
  });

  test('the alert passes the notification rule: who, how much, when, linked to the bill', () => {
    const record = { first_name: 'Avery', last_name: 'Example', technician_name: 'Taylor Sample', created_at: '2026-10-30T16:00:00Z' };
    const spec = alertSpec({ ...owed, id: 'abc' }, record);
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe("Billing — record Avery Example's $129.00 payment");
    expect(composed.why).toBe('Taylor Sample closed Oct 30 with no pay link, and the $129.00 bill is still open.');
    expect(composed.link).toBe('/admin/invoices?invoice=abc');
    expect(composed.metadata).toMatchObject({ severity: 'needs-you', subject: { type: 'invoice', id: 'abc' }, doneWhen: 'invoice_paid', who: 'person' });
  });

  test('a long name still fits the 60-character headline', () => {
    const record = { first_name: 'Maximiliana-Constance', last_name: 'Worthington-Fairweather', technician_name: null, created_at: '2026-10-30T16:00:00Z' };
    const composed = composeAdminAlert(alertSpec({ ...owed, id: 'abc', total: 1234.5 }, record));
    expect(composed.headline.length).toBeLessThanOrEqual(60);
    expect(composed.why).toBe('The visit closed Oct 30 with no pay link, and the $1234.50 bill is still open.');
  });
});

postgres('report-only payment alert (live Postgres)', () => {
  let database;
  let trx;
  let customerId;
  let techId;
  const { runReportOnlyPaymentCheck } = require('../services/report-only-payment-alert');
  // Fixed clock: "today" is Mar 4 2040 (ET); a completion on Mar 3 is a day old.
  // The first raise loads the whole notification stack; keep room for it.
  const DB_TIMEOUT_MS = 60000;
  const NOW = new Date('2040-03-04T15:00:00Z');
  const YESTERDAY_AT = '2040-03-03T16:00:00Z';

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    techId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    await trx('technicians').insert({ id: techId, name: 'Fixture Tech', role: 'technician', active: true });
  });
  afterEach(async () => { await trx.rollback(); require('../models/db').connection = database; });
  afterAll(async () => { await database.destroy(); });

  async function completion({ createdAt = YESTERDAY_AT, notes = { payLinkOmitted: true }, invoice = {} } = {}) {
    const serviceId = randomUUID();
    const recordId = randomUUID();
    const day = createdAt.slice(0, 10);
    await trx('scheduled_services').insert({ id: serviceId, customer_id: customerId, scheduled_date: day, service_type: 'Quarterly Pest Control Service', status: 'completed' });
    await trx('service_records').insert({
      id: recordId, customer_id: customerId, scheduled_service_id: serviceId, technician_id: techId, service_date: day,
      service_type: 'Quarterly Pest Control Service', structured_notes: JSON.stringify(notes), created_at: createdAt,
    });
    const invoiceId = randomUUID();
    if (invoice !== null) {
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, invoice_number: `TST-${invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
        status: 'draft', total: 117, subtotal: 117, service_date: day, service_type: 'Quarterly Pest Control Service',
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]),
        service_record_id: recordId, scheduled_service_id: serviceId, ...invoice,
      });
    }
    return { serviceId, recordId, invoiceId };
  }
  const bells = (invoiceId) => trx('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [alertKey(invoiceId)]);

  test('a report-only completion from yesterday with an open bill raises one bell, and a second pass does not ring again', async () => {
    const { invoiceId } = await completion();
    const first = await runReportOnlyPaymentCheck({ now: NOW });
    expect(first.checked).toBe(1);
    const rows = await bells(invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Billing — record Synthetic Fixture's $117.00 payment");
    expect(rows[0].link).toBe(`/admin/invoices?invoice=${invoiceId}`);
    await runReportOnlyPaymentCheck({ now: NOW });
    expect(await bells(invoiceId)).toHaveLength(1);
  }, DB_TIMEOUT_MS);

  test('no bell for a completion from today, one without the marker, one older than 30 days, a bill to a payer, or no bill', async () => {
    const today = await completion({ createdAt: '2040-03-04T13:00:00Z' });
    const noMarker = await completion({ notes: {} });
    const old = await completion({ createdAt: '2040-01-20T16:00:00Z' });
    const [payerId] = await trx('payers').insert({ display_name: 'Fixture Bill-To' }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const payer = await completion({ invoice: { payer_id: payerId } });
    await completion({ invoice: null });
    expect((await runReportOnlyPaymentCheck({ now: NOW })).checked).toBe(0);
    for (const { invoiceId } of [today, noMarker, old, payer]) expect(await bells(invoiceId)).toHaveLength(0);
  }, DB_TIMEOUT_MS);

  test('a bank payment that is processing closes the bell; a debit that returns reopens it and rings again', async () => {
    const { invoiceId } = await completion();
    await runReportOnlyPaymentCheck({ now: NOW });
    await trx('invoices').where({ id: invoiceId }).update({ status: 'processing' });
    expect((await runReportOnlyPaymentCheck({ now: NOW })).closed).toBe(1);
    expect((await bells(invoiceId))[0].metadata.autoCleared).toBe(true);
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sent' });
    await runReportOnlyPaymentCheck({ now: NOW });
    const [row] = await bells(invoiceId);
    expect(row.metadata.autoCleared).toBe(false);
    expect(row.metadata.recurrenceGeneration).toBe(1);
    expect(row.read_at).toBeNull();
  }, DB_TIMEOUT_MS);

  test('the bell closes once the bill is paid, even after the visit leaves the 30-day window', async () => {
    const { invoiceId } = await completion();
    await runReportOnlyPaymentCheck({ now: NOW });
    // Still owed, visit now 40 days old: the bell stays open.
    expect((await runReportOnlyPaymentCheck({ now: new Date('2040-04-12T15:00:00Z') })).closed).toBe(0);
    await trx('invoices').where({ id: invoiceId }).update({ status: 'paid', amount_paid: 117 });
    expect((await runReportOnlyPaymentCheck({ now: new Date('2040-04-12T15:00:00Z') })).closed).toBe(1);
    const [row] = await bells(invoiceId);
    expect(row.done_at).not.toBeNull();
    expect(row.metadata.autoCleared).toBe(true);
  }, DB_TIMEOUT_MS);
});
