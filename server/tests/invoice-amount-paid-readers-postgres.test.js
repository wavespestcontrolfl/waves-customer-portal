// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Partial payments (owner 2026-10-29): invoices.amount_paid is money already received on an invoice
// that is still open. Every reader of "what is owed" must agree: the open-balance reader, the pay page's
// amount_due and combined total, AR aging and the visit balance facts. A $200 invoice with $100 paid
// is a $100 invoice everywhere; amount_paid 0 gives the numbers the portal gave before the column.
// Nothing writes amount_paid yet, so the tests set it directly.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(120000);

postgres('every reader of the amount owed subtracts amount_paid', () => {
  let database;
  let trx;
  let customerId;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use disposable CI or a private local QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Partial', phone: '+12025550123',
      email: `${customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false,
    });
  });

  afterEach(async () => {
    await trx.rollback();
    require('../models/db').connection = database;
  });

  afterAll(async () => {
    if (database) await database.destroy();
  });

  async function seedInvoice({ total = 200, credit = 0, paid = 0, status = 'sent', daysLate = 0 } = {}) {
    const id = randomUUID();
    const due = new Date(Date.now() - daysLate * 86400000).toISOString().slice(0, 10);
    await trx('invoices').insert({
      id, customer_id: customerId, invoice_number: `TEST-${id.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status, total, subtotal: total, credit_applied: credit, amount_paid: paid, due_date: due,
      service_date: due, created_at: new Date(Date.now() - 86400000 * (daysLate + 1)),
    });
    return trx('invoices').where({ id }).first();
  }

  test('the column is numeric(10,2) NOT NULL default 0 and starts at 0', async () => {
    const cols = await trx.raw(
      `SELECT column_name, numeric_precision, numeric_scale, is_nullable, column_default
         FROM information_schema.columns WHERE table_name = 'invoices' AND column_name IN ('total', 'amount_paid')`,
    );
    const byName = Object.fromEntries(cols.rows.map((c) => [c.column_name, c]));
    expect(byName.amount_paid).toMatchObject({ numeric_precision: byName.total.numeric_precision, numeric_scale: byName.total.numeric_scale, is_nullable: 'NO' });
    expect(String(byName.amount_paid.column_default)).toMatch(/^0|'0'/);
    const plain = await trx('invoices').insert({
      id: randomUUID(), customer_id: customerId, invoice_number: `TEST-${randomUUID().slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: 'sent', total: 50, subtotal: 50,
    }).returning('amount_paid');
    expect(Number(plain[0].amount_paid ?? plain[0])).toBe(0);
  });

  test('open-balance reader: $200 invoice with $100 paid is a $100 open balance', async () => {
    const { openBalanceInvoices, openBalanceSummary, openBalanceExists, openSelfPayInvoicesByAmountDue } = require('../services/open-balance');
    const inv = await seedInvoice({ total: 200, paid: 100 });

    const summary = await openBalanceSummary(customerId, { database: trx });
    expect(summary.total).toBe(100);
    expect(summary.count).toBe(1);
    const rows = await openBalanceInvoices(customerId, { database: trx });
    expect(rows.map((r) => String(r.id))).toEqual([String(inv.id)]);
    expect(await openBalanceExists(customerId, { database: trx })).toBe(true);

    // The Zelle whole-balance match prices by amount due but never matches an invoice that already holds a part payment (the writer PR:
    // the office records what is left by hand): neither the $100 remainder nor the gross $200 finds it.
    const at100 = await openSelfPayInvoicesByAmountDue(10000, { database: trx });
    const at200 = await openSelfPayInvoicesByAmountDue(20000, { database: trx });
    expect(at100.map((r) => String(r.id))).not.toContain(String(inv.id));
    expect(at200.map((r) => String(r.id))).not.toContain(String(inv.id));
  });

  test('open-balance reader: credit and a part payment both come off; paid in full by parts is not open', async () => {
    const { openBalanceSummary, openBalanceExists } = require('../services/open-balance');
    await seedInvoice({ total: 200, credit: 50, paid: 100 });
    expect((await openBalanceSummary(customerId, { database: trx })).total).toBe(50);

    await trx('invoices').where({ customer_id: customerId }).update({ amount_paid: 150 });
    expect((await openBalanceSummary(customerId, { database: trx })).total).toBe(0);
    expect(await openBalanceExists(customerId, { database: trx })).toBe(false);
  });

  test('pay page: amount_due, the combined cents and the previous-balance total all say 100', async () => {
    const InvoiceService = require('../services/invoice');
    const PayCombined = require('../services/pay-combined');
    const inv = await seedInvoice({ total: 200, paid: 100 });

    const data = await InvoiceService.getByToken(inv.token, { recordView: false, database: trx });
    expect(Number(data.amount_due)).toBe(100);
    expect(Number(data.total)).toBe(200);
    expect(PayCombined.amountDueCents(data)).toBe(10000);
    expect(PayCombined.amountDueCents(inv)).toBe(10000);

    // A second open invoice: the reminder's combined total is the sum of what each owes.
    const other = await seedInvoice({ total: 80, daysLate: 10 });
    const { openBalanceSummary } = require('../services/open-balance');
    const summary = await openBalanceSummary(customerId, { database: trx });
    expect(summary.total).toBe(180);
    expect(PayCombined.amountDueCents(inv) + PayCombined.amountDueCents(other)).toBe(Math.round(summary.total * 100));
  });

  test('AR aging and the visit balance facts say 100', async () => {
    const { executeTaxTool } = require('../services/intelligence-bar/tax-tools');
    const { openInvoiceFacts } = require('../services/visit-context/balance');
    await seedInvoice({ total: 200, paid: 100, daysLate: 45 });

    // Inside this rolled-back transaction the one invoice is the whole receivable.
    const aging = await executeTaxTool('get_ar_aging', {});
    expect(aging.total_outstanding).toBe(100);
    expect(aging.aging['31_60_days']).toBe(100);
    expect(aging.top_balances.map((i) => i.amount)).toEqual([100]);

    const facts = await openInvoiceFacts(customerId, { db: trx });
    expect(facts.balance).toBe(100);
    expect(facts.count).toBe(1);
  });

  test('amount_paid 0 gives the numbers the readers gave before the column', async () => {
    const InvoiceService = require('../services/invoice');
    const { openBalanceSummary, openSelfPayInvoicesByAmountDue } = require('../services/open-balance');
    const { executeTaxTool } = require('../services/intelligence-bar/tax-tools');
    const { openInvoiceFacts } = require('../services/visit-context/balance');
    const plain = await seedInvoice({ total: 200, credit: 0, paid: 0, daysLate: 45 });
    const credited = await seedInvoice({ total: 100, credit: 40, paid: 0, daysLate: 5 });

    expect((await openBalanceSummary(customerId, { database: trx })).total).toBe(260);
    expect((await openSelfPayInvoicesByAmountDue(20000, { database: trx })).map((r) => String(r.id))).toContain(String(plain.id));
    expect((await openSelfPayInvoicesByAmountDue(6000, { database: trx })).map((r) => String(r.id))).toContain(String(credited.id));
    expect(Number((await InvoiceService.getByToken(plain.token, { recordView: false, database: trx })).amount_due)).toBe(200);
    expect(Number((await InvoiceService.getByToken(credited.token, { recordView: false, database: trx })).amount_due)).toBe(60);
    expect(Number((await executeTaxTool('get_ar_aging', {})).total_outstanding)).toBe(260);
    expect((await openInvoiceFacts(customerId, { db: trx })).balance).toBe(260);
  });
});
