// A report push opens the visit's own report page and a receipt push opens
// the invoice's own receipt page (owner 2026-10-09: the app push landed on
// the portal home, not the report). The customer-wide tab stays the fallback
// whenever no page can be named: no ids, no token, a suppressed typed report,
// another customer's invoice, or a lookup failure.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/reports-public', () => ({
  suppressedTypedReport: (record) => {
    const mode = record?.structured_notes?.typedReportDelivery;
    return Boolean(mode) && mode !== 'auto_send';
  },
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { _test } = require('../services/messaging/push-channel-routing');

const { resolvePushDestination, pushPresentation, PRESENTATION } = _test;
const customerId = 'cust-1';

function tableFake({ serviceRecords = [], invoice = null, fail = null } = {}) {
  return (table) => {
    if (fail) throw new Error(fail);
    const chain = {
      where: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(async () => serviceRecords),
      first: jest.fn(async () => invoice),
    };
    chain.table = table;
    return chain;
  };
}

beforeEach(() => {
  db.mockReset();
  logger.warn.mockClear();
});

describe('report pushes', () => {
  it('open the visit report when the visit has an auto-send v1 report with a token', async () => {
    db.mockImplementation(tableFake({ serviceRecords: [{ report_view_token: 'a'.repeat(32), structured_notes: null }] }));
    const dest = await resolvePushDestination(pushPresentation('service_report_v1'), 'service_report_v1', { customerId, appointmentId: 'visit-1' });
    expect(dest).toEqual({ title: 'Your service report is ready', link: `/report/${'a'.repeat(32)}`, category: 'service' });
    // Scoped to this customer's record for this visit.
    const chain = db.mock.results[0].value;
    expect(chain.table).toBe('service_records');
    expect(chain.where).toHaveBeenCalledWith({
      scheduled_service_id: 'visit-1', customer_id: customerId, status: 'completed', report_template_version: 'service_report_v1',
    });
  });

  it('every completion family member opens the report, including the paid-receipt completion text', async () => {
    db.mockImplementation(tableFake({ serviceRecords: [{ report_view_token: 'b'.repeat(32), structured_notes: null }] }));
    for (const type of ['service_complete', 'service_complete_with_invoice', 'service_complete_paid_receipt']) {
      const dest = await resolvePushDestination(pushPresentation(type), type, { customerId, appointmentId: 'visit-1' });
      expect(dest.link).toBe(`/report/${'b'.repeat(32)}`);
    }
  });

  it('skips a suppressed typed report and takes the next qualifying record', async () => {
    db.mockImplementation(tableFake({ serviceRecords: [
      { report_view_token: 'held'.repeat(8), structured_notes: { typedReportDelivery: 'hold' } },
      { report_view_token: 'open'.repeat(8), structured_notes: { typedReportDelivery: 'auto_send' } },
    ] }));
    const dest = await resolvePushDestination(pushPresentation('service_complete'), 'service_complete', { customerId, appointmentId: 'visit-1' });
    expect(dest.link).toBe(`/report/${'open'.repeat(8)}`);
  });

  it('falls back to Documents without a visit id, without a record, or when every record is suppressed', async () => {
    db.mockImplementation(tableFake({ serviceRecords: [] }));
    expect((await resolvePushDestination(pushPresentation('service_complete'), 'service_complete', { customerId })).link).toBe('/?tab=documents');
    expect(db).not.toHaveBeenCalled();
    expect((await resolvePushDestination(pushPresentation('service_complete'), 'service_complete', { customerId, appointmentId: 'visit-1' })).link).toBe('/?tab=documents');
    db.mockImplementation(tableFake({ serviceRecords: [{ report_view_token: 'c'.repeat(32), structured_notes: { typedReportDelivery: 'hold' } }] }));
    expect((await resolvePushDestination(pushPresentation('service_complete'), 'service_complete', { customerId, appointmentId: 'visit-1' })).link).toBe('/?tab=documents');
  });

  it('falls back to Documents and warns when the lookup throws', async () => {
    db.mockImplementation(tableFake({ fail: 'connection reset' }));
    const dest = await resolvePushDestination(pushPresentation('service_complete'), 'service_complete', { customerId, appointmentId: 'visit-1' });
    expect(dest.link).toBe('/?tab=documents');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deep link lookup failed'));
  });
});

describe('receipt pushes', () => {
  it("open the invoice's receipt page when the invoice is this customer's", async () => {
    db.mockImplementation(tableFake({ invoice: { token: 'inv-token' } }));
    const dest = await resolvePushDestination(PRESENTATION.receipt, 'receipt', { customerId, invoiceId: 'inv-1' });
    expect(dest).toEqual({ title: 'Payment receipt', link: '/receipt/inv-token', category: 'billing' });
    const chain = db.mock.results[0].value;
    expect(chain.table).toBe('invoices');
    expect(chain.where).toHaveBeenCalledWith({ id: 'inv-1', customer_id: customerId });
  });

  it('deposit receipts open the receipt page too', async () => {
    db.mockImplementation(tableFake({ invoice: { token: 'dep-token' } }));
    const dest = await resolvePushDestination(pushPresentation('deposit_receipt'), 'deposit_receipt', { customerId, invoiceId: 'inv-2' });
    expect(dest.link).toBe('/receipt/dep-token');
  });

  it("falls back to Billing without an invoice id or when the invoice is not the customer's", async () => {
    db.mockImplementation(tableFake({ invoice: null }));
    expect((await resolvePushDestination(PRESENTATION.receipt, 'receipt', { customerId })).link).toBe('/?tab=billing');
    expect(db).not.toHaveBeenCalled();
    expect((await resolvePushDestination(PRESENTATION.receipt, 'receipt', { customerId, invoiceId: 'inv-9' })).link).toBe('/?tab=billing');
  });
});

describe('other pushes', () => {
  it('are returned untouched with no lookup', async () => {
    db.mockImplementation(tableFake({ invoice: { token: 'x' }, serviceRecords: [{ report_view_token: 'y'.repeat(32) }] }));
    for (const type of ['appointment_reminder', 'tech_en_route', 'billing_reminder', 'lawn_watering_instruction']) {
      const presentation = pushPresentation(type);
      expect(await resolvePushDestination(presentation, type, { customerId, appointmentId: 'visit-1', invoiceId: 'inv-1' })).toBe(presentation);
    }
    expect(db).not.toHaveBeenCalled();
  });
});
