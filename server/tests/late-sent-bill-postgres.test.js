// Runs with the existing CI PostgreSQL pass; never a production connection.
// Owner 2026-11-06 ("fix"): an annual prepay bill reached its customer a week
// after its due date, so it read past due on the day it arrived. Real-Postgres
// proof for the SQL a mock cannot check: the first-delivery due-date move
// (invoice-helpers.js firstDeliveryDueDate) reads the row as it was before its
// UPDATE, and the nightly late-sent check (late-sent-bill-check.js) compares
// the due date with the Eastern day of the first delivery. Every fixture
// rolls back. Synthetic names and numbers only.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('node:crypto');

let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { firstDeliveryDueDate } = require('../services/invoice-helpers');
const { _private: { readLateSentBills } } = require('../services/late-sent-bill-check');

jest.setTimeout(30000);

(SKIP ? describe.skip : describe)('late-sent bills on real Postgres', () => {
  let database;
  let trx;
  let customerId;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or a labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Latebill', active: true,
      phone: `+1202555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`, email: `${customerId}@example.invalid`,
    });
  });

  afterEach(async () => { await trx.rollback(); mockConnection = database; });
  afterAll(async () => { await database.destroy(); });

  const insertInvoice = async (row) => {
    const id = randomUUID();
    await trx('invoices').insert({
      id, customer_id: customerId, invoice_number: `WPC-TEST-${id.slice(0, 8)}`, token: randomUUID(),
      total: 117, subtotal: 117, line_items: '[]', ...row,
    });
    return id;
  };
  const dueDay = async (id) => (await trx('invoices').where({ id }).first(trx.raw('due_date::text AS due'))).due;

  describe('firstDeliveryDueDate', () => {
    const SEND_DAY = '2026-11-06';
    const earlier = new Date('2026-10-30T14:00:00Z');
    test.each([
      ['a never-sent draft due before the send day moves', { status: 'draft', due_date: '2026-10-30' }, SEND_DAY],
      ['a scheduled send due before the send day moves', { status: 'scheduled', due_date: '2026-10-30' }, SEND_DAY],
      ['a claimed send not yet delivered moves', { status: 'sending', due_date: '2026-10-30' }, SEND_DAY],
      ['a draft due on the send day stays', { status: 'draft', due_date: SEND_DAY }, SEND_DAY],
      ['a draft due after the send day stays', { status: 'draft', due_date: '2026-11-20' }, '2026-11-20'],
      ['a draft with no due date stays empty', { status: 'draft', due_date: null }, null],
      ['a resend of a delivered bill stays', { status: 'sent', due_date: '2026-10-30', sent_at: earlier }, '2026-10-30'],
      ['a retry after its Text was delivered stays', { status: 'sending', due_date: '2026-10-30', sms_sent_at: earlier }, '2026-10-30'],
      ['a retry after its Email was delivered stays', { status: 'scheduled', due_date: '2026-10-30', email_sent_at: earlier }, '2026-10-30'],
      ['a viewed bill stays', { status: 'viewed', due_date: '2026-10-30' }, '2026-10-30'],
    ])('%s', async (_name, row, expected) => {
      const id = await insertInvoice(row);
      // The claim sets the status in the same UPDATE: the CASE reads the row as it was before it.
      await trx('invoices').where({ id }).update({ status: 'sending', due_date: firstDeliveryDueDate(trx, SEND_DAY) });
      expect(await dueDay(id)).toBe(expected);
    });
  });

  describe('readLateSentBills', () => {
    test('finds an open bill first delivered after its due day, on the Eastern day of that delivery', async () => {
      const late = await insertInvoice({
        status: 'sent', due_date: '2026-11-03',
        sms_sent_at: new Date('2026-11-04T15:00:00Z'), sent_at: new Date('2026-11-04T15:00:01Z'),
      });
      const others = [
        // 10:30 PM ET on Nov 3 is still Nov 3 in Eastern time; UTC already reads Nov 4.
        await insertInvoice({ status: 'sent', due_date: '2026-11-03', email_sent_at: new Date('2026-11-04T03:30:00Z'), sent_at: new Date('2026-11-04T03:30:00Z') }),
        // Due on its send day.
        await insertInvoice({ status: 'viewed', due_date: '2026-11-04', sent_at: new Date('2026-11-04T15:00:00Z') }),
        // Paid, so not open.
        await insertInvoice({ status: 'paid', due_date: '2026-11-01', sent_at: new Date('2026-11-04T15:00:00Z'), amount_paid: 117 }),
        // First delivered before the window.
        await insertInvoice({ status: 'overdue', due_date: '2026-10-01', sent_at: new Date('2026-10-20T14:00:00Z') }),
        // Never delivered.
        await insertInvoice({ status: 'draft', due_date: '2026-10-01' }),
      ];

      // The CI database is shared: keep this fixture's rows only.
      const fixtureIds = new Set([late, ...others]);
      const mine = (await readLateSentBills(trx, new Date('2026-10-30T00:00:00Z'))).filter((r) => fixtureIds.has(r.id));

      expect(mine.map((r) => r.id)).toEqual([late]);
      expect(new Date(mine[0].first_delivered_at).toISOString()).toBe('2026-11-04T15:00:00.000Z');
    });
  });
});
