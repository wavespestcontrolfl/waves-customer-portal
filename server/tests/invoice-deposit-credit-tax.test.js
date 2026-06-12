// Deposit credits are PRIOR PAYMENT, not price reductions: they must not
// shrink the commercial tax base or fold into discount reporting. The
// category: 'deposit_credit' line is excluded from the discount machinery
// and subtracted AFTER tax in InvoiceService.create.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-06-12'),
  addETDays: jest.fn(() => new Date('2026-07-12T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
const mockPendingDepositCredit = jest.fn();
const mockConsumeDepositCredit = jest.fn();
jest.mock('../services/estimate-deposits', () => ({
  pendingDepositCredit: (...args) => mockPendingDepositCredit(...args),
  consumeDepositCredit: (...args) => mockConsumeDepositCredit(...args),
}));
const mockTriggerNotification = jest.fn();
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

function setupDb({ customer }) {
  let insertedInvoice = null;
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const q = {
        where: jest.fn(() => q),
        first: jest.fn(async () => customer),
      };
      return q;
    }
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => {
          insertedInvoice = data;
          return {
            returning: jest.fn(async () => [{ id: 'invoice-1', ...data }]),
          };
        }),
      };
      return q;
    }
    throw new Error(`Unexpected table query: ${table}`);
  });
  return { getInsertedInvoice: () => insertedInvoice };
}

describe('deposit credit is after-tax prior payment, never a discount', () => {
  beforeEach(() => jest.clearAllMocks());

  const depositLine = {
    description: 'Deposit credit (paid at acceptance)',
    quantity: 1,
    unit_price: -70,
    category: 'deposit_credit',
  };
  const serviceLine = {
    description: 'First service application',
    quantity: 1,
    unit_price: 200,
  };

  it('COMMERCIAL: tax is computed on the full charge, then the deposit subtracts after tax', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'commercial' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine, depositLine],
      taxRate: 0.07,
    });
    const row = getInsertedInvoice();
    expect(row.subtotal).toBe(200);
    expect(row.discount_amount).toBe(0);          // deposit is NOT a discount
    expect(row.tax_amount).toBe(14);              // 7% of 200, not of 130
    expect(row.total).toBe(144);                  // 200 + 14 − 70
    // The line stays visible on the invoice.
    expect(JSON.parse(row.line_items).some((i) => i.category === 'deposit_credit')).toBe(true);
  });

  it('RESIDENTIAL: no tax, total is charge minus deposit, discount stays zero', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine, depositLine],
    });
    const row = getInsertedInvoice();
    expect(row.subtotal).toBe(200);
    expect(row.discount_amount).toBe(0);
    expect(row.tax_amount).toBe(0);
    expect(row.total).toBe(130);
  });

  it('depositCredit REQUEST is capped at the POST-discount invoice value — discounted dollars never consume ledger money (P1)', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    const invoice = await InvoiceService.create({
      customerId: 'cust-1',
      title: 'Discounted first visit',
      lineItems: [
        { description: 'Service', quantity: 1, unit_price: 100 },
        { description: 'Promo', quantity: 1, unit_price: -80 }, // pre-tax discount
      ],
      depositCredit: { amount: 99 },
    });
    const row = getInsertedInvoice();
    // $100 − $80 discount = $20 of invoice value. Only $20 of the requested
    // $99 applies; create() reports the effective amount so the caller
    // consumes exactly that and the other $79 stays on the ledger.
    expect(invoice.applied_deposit_credit).toBe(20);
    expect(row.total).toBe(0);
    const credit = JSON.parse(row.line_items).find((i) => i.category === 'deposit_credit');
    expect(credit.unit_price).toBe(-20);
    expect(row.discount_amount).toBe(80);
  });

  it('depositCredit REQUEST on a commercial invoice caps at the after-tax value, not the pre-tax subtotal', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'commercial' },
    });
    const invoice = await InvoiceService.create({
      customerId: 'cust-1',
      title: 'Discounted first visit',
      lineItems: [
        { description: 'Service', quantity: 1, unit_price: 100 },
        { description: 'Promo', quantity: 1, unit_price: -80 },
      ],
      taxRate: 0.07,
      depositCredit: { amount: 99 },
    });
    const row = getInsertedInvoice();
    // After-discount $20 + 7% tax $1.40 = $21.40 of absorbable value.
    expect(invoice.applied_deposit_credit).toBe(21.4);
    expect(row.total).toBe(0);
  });

  it('the depositCredit line carries its estimate_id stamp — the application record void-restore reads (P1)', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First visit',
      lineItems: [{ description: 'Service', quantity: 1, unit_price: 100 }],
      depositCredit: { amount: 49, estimateId: 'est-1' },
    });
    const credit = JSON.parse(getInsertedInvoice().line_items).find((i) => i.category === 'deposit_credit');
    expect(credit.estimate_id).toBe('est-1');
  });

  it('a zero-value invoice applies NO depositCredit — the full balance rolls forward', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'residential' },
    });
    const invoice = await InvoiceService.create({
      customerId: 'cust-1',
      title: 'Fully discounted visit',
      lineItems: [
        { description: 'Service', quantity: 1, unit_price: 100 },
        { description: 'Promo', quantity: 1, unit_price: -100 },
      ],
      depositCredit: { amount: 99 },
    });
    const row = getInsertedInvoice();
    expect(invoice.applied_deposit_credit).toBe(0);
    expect(JSON.parse(row.line_items).some((i) => i.category === 'deposit_credit')).toBe(false);
    expect(row.total).toBe(0);
  });

  it('REGRESSION GUARD: a plain negative line WITHOUT the category still behaves as a pre-tax discount', async () => {
    const { getInsertedInvoice } = setupDb({
      customer: { id: 'cust-1', property_type: 'commercial' },
    });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'First Service Application',
      lineItems: [serviceLine, { description: 'Promo', quantity: 1, unit_price: -70 }],
      taxRate: 0.07,
    });
    const row = getInsertedInvoice();
    expect(row.discount_amount).toBe(70);
    expect(row.tax_amount).toBe(9.1);             // 7% of 130
    expect(row.total).toBe(139.1);
  });
});

describe('createFromService — estimate-deposit roll-forward', () => {
  beforeEach(() => jest.clearAllMocks());

  // setupDb plus the service-record spine createFromService walks, and a
  // pass-through transaction (the atomicity itself is exercised against the
  // real knex by the converter/accept paths; here we test the wiring).
  function setupServiceDb({ sourceEstimateId = 'est-1' } = {}) {
    let insertedInvoice = null;
    db.mockImplementation((table) => {
      if (table === 'service_records') {
        const q = {
          where: jest.fn(() => q),
          andWhere: jest.fn(() => q),
          leftJoin: jest.fn(() => q),
          select: jest.fn(() => q),
          first: jest.fn(async () => ({
            id: 'sr-1', customer_id: 'cust-1', scheduled_service_id: 'ss-1',
            service_type: 'One-Time Pest Treatment', technician_id: null,
            service_date: '2026-06-12', tech_name: null,
          })),
        };
        return q;
      }
      if (table === 'service_products' || table === 'service_photos') {
        const q = {
          where: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          select: jest.fn(async () => []),
        };
        return q;
      }
      if (table === 'scheduled_services') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ source_estimate_id: sourceEstimateId })) };
        return q;
      }
      if (table === 'customers') {
        const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ id: 'cust-1', property_type: 'residential' })) };
        return q;
      }
      if (table === 'invoices') {
        const q = {
          where: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          first: jest.fn(async () => null),
          insert: jest.fn((data) => {
            insertedInvoice = data;
            return { returning: jest.fn(async () => [{ id: 'invoice-1', ...data }]) };
          }),
        };
        return q;
      }
      throw new Error(`Unexpected table query: ${table}`);
    });
    db.transaction = jest.fn(async (fn) => fn(db));
    return { getInsertedInvoice: () => insertedInvoice };
  }

  it('credits unapplied deposit money against the completed-visit invoice (one-time pay-at-visit lands here)', async () => {
    const { getInsertedInvoice } = setupServiceDb();
    mockPendingDepositCredit.mockResolvedValue({ amount: 99 });
    mockConsumeDepositCredit.mockResolvedValue(99);

    await InvoiceService.createFromService('sr-1', { amount: 250, description: 'Rodent exclusion' });

    const row = getInsertedInvoice();
    const lines = JSON.parse(row.line_items);
    expect(lines.some((i) => i.category === 'deposit_credit' && i.unit_price === -99 && i.estimate_id === 'est-1')).toBe(true);
    expect(row.total).toBe(151); // 250 − 99, residential no tax
    expect(mockConsumeDepositCredit).toHaveBeenCalledWith(
      expect.objectContaining({ estimateId: 'est-1', amount: 99, invoiceId: 'invoice-1' }),
    );
  });

  it('caps the credit at the invoice value — the remainder stays on the ledger for the next visit', async () => {
    const { getInsertedInvoice } = setupServiceDb();
    mockPendingDepositCredit.mockResolvedValue({ amount: 99 });
    mockConsumeDepositCredit.mockResolvedValue(60);

    await InvoiceService.createFromService('sr-1', { amount: 60, description: 'Small follow-up' });

    const row = getInsertedInvoice();
    const lines = JSON.parse(row.line_items);
    expect(lines.some((i) => i.category === 'deposit_credit' && i.unit_price === -60)).toBe(true);
    expect(mockConsumeDepositCredit).toHaveBeenCalledWith(expect.objectContaining({ amount: 60 }));
  });

  it('no traceable estimate or no balance = plain invoice, deposit machinery untouched', async () => {
    setupServiceDb({ sourceEstimateId: null });
    await InvoiceService.createFromService('sr-1', { amount: 250 });
    expect(mockPendingDepositCredit).not.toHaveBeenCalled();

    setupServiceDb();
    mockPendingDepositCredit.mockResolvedValue(null);
    const inv = await InvoiceService.createFromService('sr-1', { amount: 250 });
    expect(inv.total).toBe(250);
    expect(mockConsumeDepositCredit).not.toHaveBeenCalled();
  });

  it('an allocation mismatch never blocks visit invoicing — falls back to an uncredited invoice and alerts', async () => {
    const { getInsertedInvoice } = setupServiceDb();
    mockPendingDepositCredit.mockResolvedValue({ amount: 99 });
    mockConsumeDepositCredit.mockResolvedValue(0); // ledger flipped under us, twice

    const inv = await InvoiceService.createFromService('sr-1', { amount: 250 });

    expect(inv).toBeTruthy();
    const row = getInsertedInvoice();
    expect(JSON.parse(row.line_items).some((i) => i.category === 'deposit_credit')).toBe(false);
    expect(row.total).toBe(250);
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { estimateId: 'est-1' });
  });
});
