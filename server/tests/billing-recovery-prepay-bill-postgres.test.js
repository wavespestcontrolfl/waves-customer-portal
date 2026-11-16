// Runs with the existing CI PostgreSQL pass; never a production connection.
// Owner 2026-11-06 ("fix"): an annual prepay term links its visits only once
// its prepay bill is paid, so the Billing recovery list offered to bill a
// visit that unpaid prepay bill already covered. Real-Postgres proof that the
// list names that bill (admin-billing-recovery.js unpaidPrepayBillByVisit:
// the term query, the canonical rule termBoughtVisit on the window first
// activation would give the term, and the Billed elsewhere step's refused
// statuses). Every fixture rolls back. Synthetic names and numbers only.
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
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url), invoiceShortCodePrefix: jest.fn(() => 'INV') }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.example') }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ executeDashboardTool: jest.fn(), INTERNAL_TEST_CUSTOMERS: [] }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const { etDateString } = require('../utils/datetime-et');

jest.setTimeout(30000);

(SKIP ? describe.skip : describe)('the Billing recovery list and an unpaid prepay bill on real Postgres', () => {
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
      id: customerId, first_name: 'Synthetic', last_name: 'Prepaybill', active: true,
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

  const SERVICE = 'Quarterly Pest Control Service';
  const yesterday = () => etDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

  // A completed visit with no invoice, and a payment_pending annual term
  // whose prepay bill is out with the customer (the 11-06 shape: the term
  // links its visits only once that bill is paid).
  async function fixture({ prepayStatus = 'sent', termStart = yesterday(), visitDay = termStart } = {}) {
    const prepayInvoiceId = await insertInvoice({ status: prepayStatus, due_date: termStart, total: 400, subtotal: 400 });
    const termId = randomUUID();
    await trx('annual_prepay_terms').insert({
      id: termId, customer_id: customerId, prepay_invoice_id: prepayInvoiceId, status: 'payment_pending',
      term_start: termStart, term_end: addDays(termStart, 364), first_visit_date: termStart,
      coverage_service_type: SERVICE, coverage_visit_count: 4, coverage_cadence: 'quarterly',
    });
    const visitId = randomUUID();
    await trx('scheduled_services').insert({
      id: visitId, customer_id: customerId, scheduled_date: visitDay, service_type: SERVICE, status: 'completed',
      estimated_price: 117, completed_at: new Date(`${visitDay}T17:00:00Z`),
    });
    await trx('service_records').insert({
      id: randomUUID(), customer_id: customerId, scheduled_service_id: visitId,
      service_date: visitDay, service_type: SERVICE, status: 'completed',
    });
    const prepayNumber = (await trx('invoices').where({ id: prepayInvoiceId }).first('invoice_number')).invoice_number;
    return { termId, visitId, prepayInvoiceId, prepayNumber };
  }
  const listed = async (visitId) => {
    const { listUninvoicedLeaks } = require('../routes/admin-billing-recovery');
    const list = await listUninvoicedLeaks(30);
    const leak = list.leaks.find((r) => r.scheduled_service_id === visitId);
    const review = list.needs_review.find((r) => r.scheduled_service_id === visitId);
    return { list: leak ? 'leaks' : (review ? 'needs_review' : null), row: leak || review || null };
  };

  test('names the prepay bill that covers the visit and lists the visit for review', async () => {
    const { visitId, prepayNumber } = await fixture();
    expect(await listed(visitId)).toMatchObject({ list: 'needs_review', row: { prepay_invoice_number: prepayNumber } });
  });

  test('a prepay bill the Billed elsewhere step refuses (void, draft) or a suspended term names nothing', async () => {
    const { visitId, prepayInvoiceId, termId } = await fixture();
    await trx('invoices').where({ id: prepayInvoiceId }).update({ status: 'void' });
    expect(await listed(visitId)).toMatchObject({ list: 'leaks', row: { prepay_invoice_number: null } });

    await trx('invoices').where({ id: prepayInvoiceId }).update({ status: 'draft' });
    expect(await listed(visitId)).toMatchObject({ list: 'leaks', row: { prepay_invoice_number: null } });

    await trx('invoices').where({ id: prepayInvoiceId }).update({ status: 'sent' });
    await trx('annual_prepay_terms').where({ id: termId }).update({ dispute_suspended_at: new Date() });
    expect(await listed(visitId)).toMatchObject({ list: 'leaks', row: { prepay_invoice_number: null } });
  });

  test('a never-paid term names its bill only inside the window first activation would give it: a later term caps the slide', async () => {
    // Minted 400 days ago and never paid: a payment today slides the window
    // 400 days past its stored end (ensureCoverageRowsForTerm), so a visit
    // done 10 days ago falls inside it and the bill covers that visit.
    const today = etDateString();
    const { visitId, prepayNumber } = await fixture({ termStart: addDays(today, -400), visitDay: addDays(today, -10) });
    expect(await listed(visitId)).toMatchObject({ list: 'needs_review', row: { prepay_invoice_number: prepayNumber } });

    // A later term for the customer starts 20 days ago. Activation stops the
    // slide the day before it, whatever that term's state, so paying the old
    // bill would not cover the visit: it names nothing. (This later term has
    // no bill of its own, so it covers nothing and is never named itself.)
    await trx('annual_prepay_terms').insert({
      id: randomUUID(), customer_id: customerId, status: 'payment_pending',
      term_start: addDays(today, -20), term_end: addDays(today, 344),
      coverage_service_type: SERVICE, coverage_visit_count: 4, coverage_cadence: 'quarterly',
    });
    expect(await listed(visitId)).toMatchObject({ list: 'leaks', row: { prepay_invoice_number: null } });
  });

  test('a visit of another service type is outside the term\'s coverage and names nothing', async () => {
    const { visitId } = await fixture();
    await trx('scheduled_services').where({ id: visitId }).update({ service_type: 'Mosquito Control' });
    await trx('service_records').where({ scheduled_service_id: visitId }).update({ service_type: 'Mosquito Control' });
    expect(await listed(visitId)).toMatchObject({ list: 'leaks', row: { prepay_invoice_number: null } });
  });
});
