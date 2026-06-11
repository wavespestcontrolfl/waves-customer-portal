// previewInvoiceTotals MUST predict exactly what create() stores — the WDO
// combined-send dry-run shows the preview, the send bills the create. The
// preview/billed mirror has drifted three times (legacy fallback rate, the
// service-record tax key, the #1520 scheduled-service tax key), so this suite
// drives BOTH paths with identical inputs and asserts identical totals. The
// mocked TaxCalculator returns a DIFFERENT rate per service-type key, so any
// future drift in key resolution fails the parity assertions, not just a
// rounding check.

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'now()') };
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
// Distinct rate per tax key: keying on the scheduled service's type yields
// 6.5%; falling back to the 'WDO Inspection' title yields 7.5%. Drift in
// either direction changes the totals and fails parity.
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async (customerId, serviceType, amount) => {
    const rate = serviceType === 'Commercial Pest Control' ? 0.065 : 0.075;
    return { rate, amount: Math.round(amount * rate * 100) / 100 };
  }),
}));

const db = require('../models/db');
const TaxCalculator = require('../services/tax-calculator');
const InvoiceService = require('../services/invoice');

const COMMERCIAL_CUSTOMER = {
  id: 'cust-1',
  property_type: 'commercial',
  first_name: 'Acme',
  last_name: 'Corp',
};

const SCHEDULED_SERVICE = {
  id: 'sched-1',
  customer_id: 'cust-1',
  service_type: 'Commercial Pest Control',
  technician_id: 'tech-1',
  scheduled_date: '2026-06-15',
  tech_name: 'Adam Tech',
};

// Table-routing db mock covering everything create() touches on the
// scheduled-service path: customers read, scheduled_services context lookup,
// nextInvoiceNumber's invoices read, and insertInvoiceRow's insert→returning.
// The inserted row is captured so the test can compare stored financials.
function mockCreateDb({ customer = COMMERCIAL_CUSTOMER, scheduled = SCHEDULED_SERVICE } = {}) {
  const inserted = [];
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereIn = jest.fn(() => q);
    q.andWhere = jest.fn(() => q);
    q.leftJoin = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.update = jest.fn(() => q);
    q.returning = jest.fn(async () => (inserted.length ? [{ id: 'inv-1', ...inserted[inserted.length - 1] }] : []));
    q.insert = jest.fn((row) => {
      inserted.push(row);
      return q;
    });
    q.first = jest.fn(async () => {
      if (table === 'customers') return customer;
      if (table === 'scheduled_services') return scheduled;
      if (table === 'invoices') return null; // nextInvoiceNumber: no prior invoice
      if (table === 'service_records') return null;
      return null;
    });
    return q;
  });
  return inserted;
}

const FEE = 175;

async function runCreate() {
  return InvoiceService.create({
    customerId: 'cust-1',
    scheduledServiceId: 'sched-1',
    title: 'WDO Inspection',
    lineItems: [{ description: 'WDO inspection', quantity: 1, unit_price: FEE, amount: FEE }],
    notes: 'parity test',
  });
}

async function runPreview() {
  return InvoiceService.previewInvoiceTotals({
    customerId: 'cust-1',
    customer: COMMERCIAL_CUSTOMER,
    amount: FEE,
    scheduledServiceId: 'sched-1',
    title: 'WDO Inspection',
  });
}

describe('previewInvoiceTotals ↔ create parity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('scheduled-service tax key: preview matches what create stores', async () => {
    const inserted = mockCreateDb();
    await runCreate();
    const stored = inserted[inserted.length - 1];
    const preview = await runPreview();

    // Both keyed on the scheduled service's type → 6.5%, not the title's 7.5%.
    expect(preview.subtotal).toBe(stored.subtotal);
    expect(preview.tax_rate).toBe(stored.tax_rate);
    expect(preview.tax_amount).toBe(stored.tax_amount);
    expect(preview.total).toBe(stored.total);
    expect(preview.tax_rate).toBe(0.065);

    // The calculator received the SAME key from both paths.
    const keys = TaxCalculator.calculateTax.mock.calls.map((c) => c[1]);
    expect(keys).toEqual(['Commercial Pest Control', 'Commercial Pest Control']);
  });

  test('scheduled service for another customer: both paths fall back to the title key', async () => {
    const foreign = { ...SCHEDULED_SERVICE, customer_id: 'other-customer' };
    const inserted = mockCreateDb({ scheduled: foreign });
    await runCreate();
    const stored = inserted[inserted.length - 1];
    const preview = await runPreview();

    expect(preview.tax_rate).toBe(0.075);
    expect(preview.tax_amount).toBe(stored.tax_amount);
    expect(preview.total).toBe(stored.total);
  });

  test('TaxCalculator failure: both paths use the same 7% legacy fallback', async () => {
    TaxCalculator.calculateTax.mockRejectedValueOnce(new Error('boom'));
    const inserted = mockCreateDb();
    await runCreate();
    const stored = inserted[inserted.length - 1];

    TaxCalculator.calculateTax.mockRejectedValueOnce(new Error('boom'));
    const preview = await runPreview();

    expect(stored.tax_rate).toBe(0.07);
    expect(preview.tax_rate).toBe(0.07);
    expect(preview.tax_amount).toBe(stored.tax_amount);
    expect(preview.total).toBe(stored.total);
  });

  test('residential customer: zero tax, calculator never consulted', async () => {
    const residential = { ...COMMERCIAL_CUSTOMER, property_type: 'residential' };
    const inserted = mockCreateDb({ customer: residential });
    await runCreate();
    const stored = inserted[inserted.length - 1];

    const preview = await InvoiceService.previewInvoiceTotals({
      customerId: 'cust-1',
      customer: residential,
      amount: FEE,
      scheduledServiceId: 'sched-1',
      title: 'WDO Inspection',
    });

    expect(stored.tax_amount).toBe(0);
    expect(preview.tax_amount).toBe(0);
    expect(preview.total).toBe(stored.total);
    expect(TaxCalculator.calculateTax).not.toHaveBeenCalled();
  });

  test('preview keys on the linked service record before the scheduled service', async () => {
    db.mockImplementation((table) => {
      const q = {};
      q.where = jest.fn(() => q);
      q.first = jest.fn(async () => {
        if (table === 'customers') return COMMERCIAL_CUSTOMER;
        if (table === 'service_records') return { id: 'sr-1', customer_id: 'cust-1', service_type: 'Commercial Pest Control' };
        throw new Error(`unexpected table ${table}`);
      });
      return q;
    });

    const preview = await InvoiceService.previewInvoiceTotals({
      customerId: 'cust-1',
      amount: FEE,
      serviceRecordId: 'sr-1',
      scheduledServiceId: 'sched-1',
      title: 'WDO Inspection',
    });

    expect(preview.tax_rate).toBe(0.065);
    expect(TaxCalculator.calculateTax).toHaveBeenCalledWith('cust-1', 'Commercial Pest Control', FEE);
  });

  test('preview throws like create when the service record is not the customer\'s', async () => {
    db.mockImplementation((table) => {
      const q = {};
      q.where = jest.fn(() => q);
      q.first = jest.fn(async () => {
        if (table === 'customers') return COMMERCIAL_CUSTOMER;
        if (table === 'service_records') return null;
        return null;
      });
      return q;
    });

    await expect(
      InvoiceService.previewInvoiceTotals({
        customerId: 'cust-1',
        amount: FEE,
        serviceRecordId: 'sr-other',
        title: 'WDO Inspection',
      }),
    ).rejects.toThrow(/Service record not found/);
  });
});
