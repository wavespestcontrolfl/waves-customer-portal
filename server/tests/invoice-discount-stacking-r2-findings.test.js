/**
 * GitHub Codex round 2 on PR #4655 (714f0ca821) — two server findings.
 *
 * P1 (invoice.js ~754): the invoice editor must enforce the same
 * non-stackable stack_group rule DiscountEngine.calculateDiscounts
 * applies to its own eligible list — WaveGuard Silver on one line and
 * Gold on another must be rejected, not silently compounded.
 *
 * P1 (invoice.js ~641): buildRetentionOfferLineForMint must size its
 * retention credit from the discount-stack-RESOLVED subtotal (honoring an
 * orphaned scoped stamp's collapse to $0), not the raw, unresolved
 * line-item sum a frozen stamp still carries before create()'s own
 * scope resolution runs.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-09-22'),
  addETDays: jest.fn(() => new Date('2026-10-22T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/cancellation-processor', () => ({
  familyOfServiceRow: jest.fn(() => 'pest_control'),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

function setupDb({ customer, discounts = [] }) {
  const discountById = new Map(discounts.map((d) => [String(d.id), d]));
  db.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => customer) })) };
    }
    if (table === 'discounts') {
      const q = {
        _ids: null,
        whereIn: jest.fn((_field, ids) => { q._ids = ids.map(String); return q; }),
        where: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => {
          const rows = q._ids ? q._ids.map((id) => discountById.get(id)).filter(Boolean) : discounts;
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return q;
    }
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        whereNot: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => ({ returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]) })),
      };
      return q;
    }
    const q = {
      where: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      andWhere: jest.fn(() => q),
      leftJoin: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      select: jest.fn(async () => []),
      first: jest.fn(async () => null),
      insert: jest.fn(async () => []),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return q;
  });
}

const CUSTOMER = { id: 'customer-1', property_type: 'residential' };
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

function tierRow(overrides) {
  return {
    discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true,
    stack_group: 'tier', is_stackable: false, max_discount_dollars: null,
    ...overrides,
  };
}

describe('P1: non-stackable groups enforced across LINES, not just within one', () => {
  test('WaveGuard Silver on line one plus Gold on line two is REJECTED under the gate', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDb({
      customer: CUSTOMER,
      discounts: [
        tierRow({ id: 'silver-id', name: 'WaveGuard Silver' }),
        tierRow({ id: 'gold-id', name: 'WaveGuard Gold', amount: 15 }),
      ],
    });
    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Two-tier invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        { discount_id: 'silver-id', discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
        { discount_id: 'gold-id', discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
      ],
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });

  test('the SAME tier row on two different lines is still allowed (same-row carve-out)', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDb({
      customer: CUSTOMER,
      discounts: [tierRow({ id: 'silver-id', name: 'WaveGuard Silver' })],
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Same-tier-twice invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        { discount_id: 'silver-id', discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
        { discount_id: 'silver-id', discount_for: 'line-2', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });
    expect(invoice.discount_amount).toBe(20);
  });

  test('gate OFF: the same two-tier fixture is NOT rejected — byte-identical to before this lane', async () => {
    setupDb({
      customer: CUSTOMER,
      discounts: [
        tierRow({ id: 'silver-id', name: 'WaveGuard Silver' }),
        tierRow({ id: 'gold-id', name: 'WaveGuard Gold', amount: 15 }),
      ],
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Two-tier invoice (gate off)',
      lineItems: [
        { client_id: 'line-1', description: 'Pest', quantity: 1, unit_price: 100, amount: 100 },
        { client_id: 'line-2', description: 'Lawn', quantity: 1, unit_price: 100, amount: 100 },
        { discount_id: 'silver-id', discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
        { discount_id: 'gold-id', discount_for: 'line-2', description: 'WaveGuard Gold', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });
    expect(invoice.discount_amount).toBe(25);
  });
});

describe('P1: retention offer sizing resolves scoped stamps FIRST', () => {
  function offerRow(overrides) {
    return {
      id: 'offer-1', customer_id: 'customer-1', family_key: 'pest_control', status: 'granted',
      percent_off: 15, cap_amount: 1000, amount_applied: 0, max_charges: 2, charges_applied: 0,
      granted_at: new Date('2026-01-01'), expires_at: null,
      ...overrides,
    };
  }
  function visitRow() {
    return { service_type: 'Pest Control', is_recurring: true, recurring_ongoing: false, is_callback: false, source: null, service_key: 'pest_control', service_name: 'Pest Control' };
  }

  test('a $100 visit with an orphaned frozen $30 stamp sizes retention off the resolved $100, not the raw $70 (15% => $15, not $10.50)', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const offer = offerRow();
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') {
        return { leftJoin: jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => visitRow()) })) })) };
      }
      if (table === 'retention_offers') {
        return { where: jest.fn(() => ({ orderBy: jest.fn(() => ({ first: jest.fn(async () => offer) })) })) };
      }
      if (table === 'discounts') {
        const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), first: jest.fn(async () => null), then: (resolve) => Promise.resolve([]).then(resolve) };
        return q;
      }
      const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
      return q;
    });
    const lineItems = [
      {
        client_id: 'line-1', description: 'Mosquito', quantity: 1, unit_price: 100, amount: 100,
        service_key: 'mosquito', service_category: 'mosquito',
      },
      {
        discount_id: 'lawn-credit', discount_for: null, document_discount: true,
        document_scope_service_key: 'lawn_care', document_scope_service_category: 'lawn',
        description: 'Lawn Add-on Credit', quantity: 1, unit_price: -30, amount: -30,
        discount_type: 'fixed_amount', discount_amount: 30, discount_dollars: 30,
        use_stored_discount: true, stored_discount_source: 'scheduled_service',
      },
    ];
    const result = await InvoiceService.buildRetentionOfferLineForMint({
      customerId: 'customer-1',
      scheduledServiceId: 'sched-1',
      lineItems,
    });
    expect(result).not.toBeNull();
    expect(result.amount).toBe(15);
  });

  test('gate OFF: the same fixture sizes retention off the raw $70 — byte-identical to before this lane', async () => {
    const offer = offerRow();
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') {
        return { leftJoin: jest.fn(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => visitRow()) })) })) };
      }
      if (table === 'retention_offers') {
        return { where: jest.fn(() => ({ orderBy: jest.fn(() => ({ first: jest.fn(async () => offer) })) })) };
      }
      const q = { where: jest.fn(() => q), first: jest.fn(async () => null) };
      return q;
    });
    const lineItems = [
      { client_id: 'line-1', description: 'Mosquito', quantity: 1, unit_price: 100, amount: 100, service_key: 'mosquito', service_category: 'mosquito' },
      {
        discount_id: 'lawn-credit', discount_for: null, document_discount: true,
        document_scope_service_key: 'lawn_care', document_scope_service_category: 'lawn',
        description: 'Lawn Add-on Credit', quantity: 1, unit_price: -30, amount: -30,
        discount_type: 'fixed_amount', discount_amount: 30, discount_dollars: 30,
        use_stored_discount: true, stored_discount_source: 'scheduled_service',
      },
    ];
    const result = await InvoiceService.buildRetentionOfferLineForMint({
      customerId: 'customer-1',
      scheduledServiceId: 'sched-1',
      lineItems,
    });
    expect(result.amount).toBe(10.5);
  });
});
