// InvoiceService.create `serviceTypeLabel`: the annual-prepay invoice (no visit
// behind it) stores a reporting label in invoices.service_type at insert. It
// must not feed the tax-basis lookup, and a linked visit's own service_type wins.
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
  acquireEstimateDepositLedgerLock: jest.fn().mockResolvedValue(undefined),
  pendingDepositCredit: (...args) => mockPendingDepositCredit(...args),
  consumeDepositCredit: (...args) => mockConsumeDepositCredit(...args),
}));
const mockTriggerNotification = jest.fn();
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));
const mockRescheduleForInvoiceEdit = jest.fn();
jest.mock('../services/invoice-followups', () => ({
  scheduleForInvoice: jest.fn(),
  stopSequence: jest.fn(),
  rescheduleForInvoiceEdit: (...args) => mockRescheduleForInvoiceEdit(...args),
}));
// Payer Phase 2 surface (skipAccrual coverage below): gate defaults OFF —
// matching prod and every pre-existing test in this file — and the accrual
// describe flips it on per-test. The statements service is mocked so accrual
// is observable as calls, not table traffic.
const mockIsGateEnabled = jest.fn(() => false);
jest.mock('../config/feature-gates', () => ({
  isEnabled: (...args) => mockIsGateEnabled(...args),
  gateEnvValue: jest.fn(() => false),
  // GATE_DISCOUNT_STACKING off — matches prod default and every existing
  // test in this file; InvoiceService.create reads this directly (slice 5
  // of #4405), independent of isEnabled/mockIsGateEnabled above.
  discountStackingLive: jest.fn(() => false),
}));
const mockGetOrCreateOpenStatement = jest.fn();
const mockRollupStatement = jest.fn();
jest.mock('../services/payer-statements', () => ({
  getOrCreateOpenStatement: (...args) => mockGetOrCreateOpenStatement(...args),
  rollupStatement: (...args) => mockRollupStatement(...args),
}));

const db = require('../models/db');

// InvoiceService.create's billed-elsewhere guard (scheduled-invoice-mint):
// no Billing Recovery disposition is recorded for these visits.
const mockNoBilledElsewhere = () => {
  const q = { join: () => q, where: () => q, whereNotIn: () => q, first: async () => null };
  return q;
};

// Match knex's transaction identity; the root client is not its own trx.
async function mockTransaction(callback) {
  const trx = (...args) => db(...args);
  trx.isTransaction = true;
  trx.raw = db.raw;
  trx.fn = db.fn;
  trx.transaction = async (inner) => inner(trx);
  return callback(trx);
}

// The send-progress snapshot passes db.raw(...) aggregate columns into
// .first(); the table mocks ignore first()'s arguments, but raw must exist.
// Plain function (not jest.fn) so clearAllMocks can't blank it.
db.raw = (sql) => sql;
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


describe('InvoiceService.create serviceTypeLabel', () => {
  beforeEach(() => jest.clearAllMocks());

  const line = { description: 'WaveGuard annual prepay', quantity: 1, unit_price: 600 };

  it('stores the label in invoices.service_type when no visit supplies one', async () => {
    const { getInsertedInvoice } = setupDb({ customer: { id: 'cust-1', property_type: 'residential' } });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'WaveGuard Gold - Annual Prepay (12 months)',
      serviceTypeLabel: 'Annual prepay',
      lineItems: [line],
      taxRate: 0,
    });
    const row = getInsertedInvoice();
    expect(row.service_type).toBe('Annual prepay');
    expect(row.title).toBe('WaveGuard Gold - Annual Prepay (12 months)');
    expect(row.subtotal).toBe(600);
    expect(row.total).toBe(600);
  });

  it('leaves service_type unset without a label (existing behaviour)', async () => {
    const { getInsertedInvoice } = setupDb({ customer: { id: 'cust-1', property_type: 'residential' } });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'Anything',
      lineItems: [line],
      taxRate: 0,
    });
    expect(getInsertedInvoice()).not.toHaveProperty('service_type');
  });

  it('does not change the tax-basis lookup (still keyed on the title, not the label)', async () => {
    const TaxCalculator = require('../services/tax-calculator');
    setupDb({ customer: { id: 'cust-1', property_type: 'commercial' } });
    await InvoiceService.create({
      customerId: 'cust-1',
      title: 'WaveGuard Gold - Annual Prepay (12 months)',
      serviceTypeLabel: 'Annual prepay',
      lineItems: [line],
    });
    expect(TaxCalculator.calculateTax).toHaveBeenCalledWith(
      'cust-1',
      'WaveGuard Gold - Annual Prepay (12 months)',
      expect.any(Number),
      expect.any(Object),
    );
  });
});
