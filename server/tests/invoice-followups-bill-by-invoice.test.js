// The reminder ladder's Auto Pay hold waits for Auto Pay to collect the bill. Auto Pay never collects a bill from a
// won Bill-by-invoice proposal (owner 2026-10-30, bill-by-invoice.js), so the hold would wait forever and the bill
// would never be reminded: such a bill arms its reminders. planFollowupSequence is the read-only plan the send card
// shows; newSequencePlanFor takes the same exception (source pin in bill-by-invoice.test.js).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn(),
  invoiceWithdrawnFromCustomer: (invoice) => /^payer_billed:/.test(String(invoice?.scheduled_send_error || '')),
}));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {} }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn() }));
jest.mock('../services/email-template-library', () => ({}));
jest.mock('../services/customer-contact', () => ({ getInvoiceEmailRecipients: jest.fn() }));
jest.mock('../services/email-template', () => ({ currency: jest.fn() }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn() }));

const { customerOnAutopay } = require('../services/autopay-eligibility');
const { planFollowupSequence } = require('../services/invoice-followups');

const proposal = {
  enabled: true,
  title: 'Bayview Office Proposal',
  buildings: [{ name: 'Main building', lineItems: [{ description: 'Quarterly pest', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true, amount: 300 }] }],
  commercialTerms: { paymentTerms: 'net30' },
};
const TABLES = {
  invoice_followup_sequences: [],
  payment_plans: [],
  scheduled_services: [{ id: 'ss-bbi', source_estimate_id: 'est-bbi' }, { id: 'ss-card', source_estimate_id: 'est-card' }],
  estimates: [
    { id: 'est-bbi', status: 'accepted', bill_by_invoice: true, estimate_data: { proposal } },
    { id: 'est-card', status: 'accepted', bill_by_invoice: false, estimate_data: { proposal } },
  ],
};

// A knex-style fake: where(object) filters rows by equality, whereIn(column, ids) by id. `fail` names a table whose
// read rejects; `calls` lists the tables read.
function fakeConn({ fail = null } = {}) {
  const calls = [];
  const conn = (table) => {
    const filters = {};
    let ids = null;
    const rows = () => {
      calls.push(table);
      if (fail === table) return Promise.reject(new Error(`${table} read failed`));
      return Promise.resolve((TABLES[table] || []).filter((row) => (ids
        ? ids.includes(String(row.id))
        : Object.entries(filters).every(([key, value]) => String(row[key]) === String(value)))));
    };
    const q = {
      where(filter) { if (filter && typeof filter === 'object') Object.assign(filters, filter); return q; },
      whereIn(_column, values) { ids = values.map(String); return q; },
      first: () => rows().then((found) => found[0] || null),
      select: () => rows(),
    };
    return q;
  };
  conn.calls = calls;
  return conn;
}

const sentBill = (visitId) => ({
  id: 'inv-1', customer_id: 'c-1', status: 'sent', payer_id: null, scheduled_service_id: visitId, service_record_id: null,
});
const customer = { id: 'c-1', autopay_enabled: true };

describe('planFollowupSequence: the Auto Pay hold skips a Bill-by-invoice bill', () => {
  beforeEach(() => customerOnAutopay.mockReset());

  test('an Auto Pay customer\'s Bill-by-invoice bill arms its reminders', async () => {
    customerOnAutopay.mockResolvedValue(true);
    const plan = await planFollowupSequence(sentBill('ss-bbi'), fakeConn(), customer);
    expect(plan).toMatchObject({ arms: true, state: 'active' });
  });

  test('the same customer\'s card-paid bill keeps the Auto Pay hold', async () => {
    customerOnAutopay.mockResolvedValue(true);
    const plan = await planFollowupSequence(sentBill('ss-card'), fakeConn(), customer);
    expect(plan).toMatchObject({ arms: true, state: 'autopay_hold' });
  });

  test('an unreadable proposal reads as unreadable, like an unreadable Auto Pay check', async () => {
    customerOnAutopay.mockResolvedValue(true);
    const plan = await planFollowupSequence(sentBill('ss-bbi'), fakeConn({ fail: 'estimates' }), customer);
    expect(plan).toMatchObject({ arms: true, state: 'autopay_unreadable' });
  });

  test('a customer not on Auto Pay reads no proposal', async () => {
    customerOnAutopay.mockResolvedValue(false);
    const conn = fakeConn();
    const plan = await planFollowupSequence(sentBill('ss-bbi'), conn, customer);
    expect(plan).toMatchObject({ arms: true, state: 'active' });
    expect(conn.calls).not.toContain('estimates');
  });
});
