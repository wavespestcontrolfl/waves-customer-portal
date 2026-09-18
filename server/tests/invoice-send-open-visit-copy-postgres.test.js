// Synthetic PostgreSQL regression for invoice copy before and after visit completion.
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const InvoiceService = require('../services/invoice');

const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;

postgres('invoice_sent copy selection for a linked visit (pre-push P1 #4131)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    sendCustomerMessage.mockImplementation(async () => ({ sent: true, channel: 'sms', providerMessageId: `SM${randomUUID().slice(0, 8)}` }));
    mockPg = await database.transaction();
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  // customer + a linked scheduled_services visit + a draft invoice billing
  // it, with the visit's date/status and the invoice's service_date set to
  // the scenario under test.
  async function fixture({ visitStatus, serviceYmd }) {
    const customerId = randomUUID();
    const visitId = randomUUID();
    const invoiceId = randomUUID();
    await mockPg('customers').insert({
      id: customerId, first_name: 'Fixture', last_name: 'CopySelect', phone: '+12025550199',
      email: `${customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application',
    });
    await mockPg('scheduled_services').insert({
      id: visitId, customer_id: customerId, service_type: 'Fixture Quarterly Pest Control Service',
      scheduled_date: serviceYmd, window_start: '09:00', window_end: '10:00', status: visitStatus,
    });
    await mockPg('invoices').insert({
      id: invoiceId, customer_id: customerId, scheduled_service_id: visitId,
      invoice_number: `TST-${invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status: 'draft', total: 117, subtotal: 117, service_date: serviceYmd,
      line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]),
    });
    return { customerId, visitId, invoiceId };
  }

  const sentBody = () => sendCustomerMessage.mock.calls[0]?.[0]?.body || '';

  test('today + OPEN visit (confirmed): selects the pre-service copy — no date, no completion claim', async () => {
    const { invoiceId } = await fixture({ visitStatus: 'confirmed', serviceYmd: etDateString() });
    const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
    expect(result.sent).toBe(true);
    // THE bug: without the fix this reaches the standard invoice_sent copy
    // (which names the service date) because serviceDateIsFutureET is false
    // for today — a visit that has NOT happened yet.
    expect(sentBody()).toMatch(/get started/i);
  });

  test('today + COMPLETED visit: keeps the standard dated copy', async () => {
    const { invoiceId } = await fixture({ visitStatus: 'completed', serviceYmd: etDateString() });
    const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
    expect(result.sent).toBe(true);
    expect(sentBody()).not.toMatch(/get started/i);
  });

  test('today + EN_ROUTE visit: selects the pre-service copy — technician is still on the way, not done', async () => {
    const { invoiceId } = await fixture({ visitStatus: 'en_route', serviceYmd: etDateString() });
    const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
    expect(result.sent).toBe(true);
    // THE round-2 bug: isLiveVisitStatus (borrowed from the closeout
    // resolver) reads en_route as NOT live/open, so without the fix this
    // falls through to the standard invoice_sent copy — telling the
    // customer the service is done while the tech is still en route.
    expect(sentBody()).toMatch(/get started/i);
  });

  test('today + ON_SITE visit: selects the pre-service copy — technician is on site, service not yet complete', async () => {
    const { invoiceId } = await fixture({ visitStatus: 'on_site', serviceYmd: etDateString() });
    const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
    expect(result.sent).toBe(true);
    // Same round-2 bug as en_route: on_site also reads as NOT live/open
    // under isLiveVisitStatus, wrongly selecting the completed-service copy.
    expect(sentBody()).toMatch(/get started/i);
  });

  test('future + OPEN visit: keeps the existing pre-service (upfront) copy', async () => {
    const { invoiceId } = await fixture({ visitStatus: 'confirmed', serviceYmd: etDateString(addETDays(new Date(), 3)) });
    const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
    expect(result.sent).toBe(true);
    expect(sentBody()).toMatch(/get started/i);
  });

  test('past + COMPLETED visit: keeps the standard dated copy', async () => {
    const { invoiceId } = await fixture({ visitStatus: 'completed', serviceYmd: etDateString(addETDays(new Date(), -3)) });
    const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
    expect(result.sent).toBe(true);
    expect(sentBody()).not.toMatch(/get started/i);
  });

  test.each(['confirmed', 'rescheduled'])('past + %s visit: selects pre-service copy without claiming completion', async (visitStatus) => {
    const { invoiceId } = await fixture({ visitStatus, serviceYmd: etDateString(addETDays(new Date(), -3)) });
    const result = await InvoiceService.sendViaSMS(invoiceId, { operatorInitiated: true });
    expect(result.sent).toBe(true);
    expect(sentBody()).toMatch(/get started/i);
  });
});
