// Real migrated PostgreSQL, isolated schema: the payer text's window-hold queue row (payer-invoice-sms.js
// queueHeldPayerText) against the real sms_log columns and jsonb metadata, and its one-row-per-episode rule under
// genuinely concurrent holds (the key's transaction lock). The replay itself is payer-invoice-sms-window-hold.test.js.
const { randomUUID } = require('node:crypto');

let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.raw = (...args) => mockPg.raw(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'portal.wavespestcontrol.com/l/x'),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/billing-email-details', () => ({
  invoicePropertyAddress: jest.fn(async () => '123 Palm Ave, Bradenton, FL'),
  invoiceServiceDetails: jest.fn(async () => ({ label: '' })),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { sendPayerInvoiceText } = require('../services/payer-invoice-sms');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `payer_text_hold_${randomUUID().replaceAll('-', '')}`;
const WINDOW_OPEN = '2026-11-04T13:00:00.000Z';
let admin;

jest.setTimeout(30000);

postgres('payer text window hold queue (private PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && target.hostname === 'localhost' && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = require('knex')({
      client: 'pg', connection, searchPath: [schema, 'public'], pool: { min: 0, max: 6 },
    });
    await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', ['sms_log', 'public.sms_log']);
  });

  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  let customerId;
  let key;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_PAYER_INVOICE_SMS = 'true';
    await mockPg('sms_log').del();
    customerId = randomUUID();
    key = `invoice:inv-1:payer_sms:${randomUUID()}`;
    sendCustomerMessage.mockResolvedValue({
      sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: WINDOW_OPEN, deliveryOutcome: 'not_sent',
    });
  });

  afterAll(() => { delete process.env.GATE_PAYER_INVOICE_SMS; });

  // The invoice, payer and customer reads go to fixed rows (the queue is what this suite proves); sms_log is the
  // real table in the private schema.
  function facts() {
    const real = mockPg;
    const rows = {
      invoices: { id: 'inv-1', customer_id: customerId, payer_id: 7, payer_statement_id: null, status: 'sending', total: '150.00', credit_applied: 0, amount_paid: 0, token: 'tok', service_type: 'Lawn Care', service_date: null },
      payers: { id: 7, display_name: 'Pat Rowe', company_name: null, ap_phone: '(941) 555-0123', active: true },
      customers: { id: customerId, first_name: 'Sam', phone: '+19415550111' },
    };
    const handle = (table) => {
      if (table === 'sms_log') return real(table);
      const q = { where: () => q, first: async () => rows[table] };
      return q;
    };
    handle.raw = (...args) => real.raw(...args);
    handle.transaction = (...args) => real.transaction(...args);
    return handle;
  }

  const emailMessageId = () => key.split(':').pop();

  test('an automatic hold writes one scheduled row the jsonb predicates find', async () => {
    const res = await sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: emailMessageId(), database: facts() });
    expect(res).toMatchObject({ sent: false, code: 'held_for_window', nextAllowedAt: WINDOW_OPEN });
    const found = await mockPg('sms_log')
      .where({ customer_id: customerId, message_type: 'payer_invoice', status: 'scheduled' })
      .whereRaw("metadata->>'entry_point' = ?", ['payer_invoice_sms_deferred'])
      .whereRaw("metadata->>'notificationEventKey' = ?", [key]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ to_phone: '+19415550123', direction: 'outbound' });
    expect(new Date(found[0].scheduled_for).toISOString()).toBe(WINDOW_OPEN);
    expect(found[0].metadata).toMatchObject({
      requires_registered_dispatch: true, replay_purpose: 'payer_payment_link', invoice_id: 'inv-1', payer_id: 7, payer_ap_phone: '9415550123',
    });
  });

  test('concurrent holds for one episode queue one row', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => (
      sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: emailMessageId(), database: facts() })
    )));
    results.forEach((r) => expect(r).toMatchObject({ code: 'held_for_window' }));
    const count = await mockPg('sms_log').where({ customer_id: customerId, status: 'scheduled' }).count('* as n').first();
    expect(Number(count.n)).toBe(1);
  });
});
