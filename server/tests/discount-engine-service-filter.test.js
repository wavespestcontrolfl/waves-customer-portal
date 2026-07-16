jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');

function discountQuery(rows) {
  const query = {
    where: jest.fn(() => query),
    orderBy: jest.fn(async () => rows),
  };
  return query;
}

function mockDiscounts(rows) {
  const query = discountQuery(rows);
  db.mockImplementation((table) => {
    if (table === 'discounts') return query;
    throw new Error(`Unexpected table query: ${table}`);
  });
  return query;
}

function serviceScopedDiscount(overrides = {}) {
  return {
    id: 'discount-1',
    discount_key: 'free_termite_inspection',
    name: 'Free Termite Inspection',
    discount_type: 'free_service',
    amount: 0,
    is_waveguard_tier_discount: false,
    promo_code: null,
    is_auto_apply: true,
    requires_military: false,
    requires_senior: false,
    requires_multi_home: false,
    requires_new_customer: false,
    requires_referral: false,
    requires_prepayment: false,
    requires_waveguard_tier: null,
    service_key_filter: null,
    service_category_filter: null,
    min_subtotal: null,
    min_service_count: null,
    show_in_invoices: true,
    show_in_estimates: true,
    is_stackable: true,
    stack_group: null,
    priority: 1,
    ...overrides,
  };
}

describe('discount engine service filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    DiscountEngine.clearCache();
  });

  test('does not apply service-key discounts when no service context is provided', async () => {
    mockDiscounts([serviceScopedDiscount({ service_key_filter: 'termite_inspection' })]);

    const result = await DiscountEngine.calculateDiscounts(null, { subtotal: 149 });

    expect(result.discounts).toEqual([]);
    expect(result.totalDiscount).toBe(0);
    expect(result.afterDiscount).toBe(149);
  });

  test('applies service-key discounts only to the matching service', async () => {
    mockDiscounts([serviceScopedDiscount({ service_key_filter: 'termite_inspection' })]);

    const matching = await DiscountEngine.calculateDiscounts(null, {
      subtotal: 149,
      serviceKey: 'termite_inspection',
    });
    const mismatched = await DiscountEngine.calculateDiscounts(null, {
      subtotal: 149,
      serviceKey: 'general_pest',
    });

    expect(matching.discounts).toHaveLength(1);
    expect(matching.totalDiscount).toBe(149);
    expect(mismatched.discounts).toEqual([]);
    expect(mismatched.totalDiscount).toBe(0);
  });

  test('does not apply category-scoped discounts without the matching category', async () => {
    mockDiscounts([serviceScopedDiscount({
      discount_key: 'termite_category_credit',
      service_category_filter: 'termite',
      discount_type: 'fixed_amount',
      amount: 25,
    })]);

    const missingContext = await DiscountEngine.calculateDiscounts(null, { subtotal: 149 });
    const matching = await DiscountEngine.calculateDiscounts(null, {
      subtotal: 149,
      serviceCategory: 'termite',
    });
    const mismatched = await DiscountEngine.calculateDiscounts(null, {
      subtotal: 149,
      serviceCategory: 'pest_control',
    });

    expect(missingContext.discounts).toEqual([]);
    expect(matching.totalDiscount).toBe(25);
    expect(mismatched.discounts).toEqual([]);
  });

  test('manual selection still enforces customer and service eligibility', async () => {
    const discount = serviceScopedDiscount({
      requires_military: true,
      service_key_filter: 'termite_inspection',
      min_subtotal: 100,
    });

    await expect(DiscountEngine.manualEligibilityFailures(discount, {
      id: 'customer-1',
      is_military: false,
    }, {
      subtotal: 75,
      serviceKey: 'general_pest',
    })).resolves.toEqual([
      'military status',
      'service termite_inspection',
      'minimum subtotal $100',
    ]);
  });

  test('treats One-Time as an exact tier instead of an ordered membership tier', async () => {
    const discount = serviceScopedDiscount({ requires_waveguard_tier: 'One-Time' });

    await expect(DiscountEngine.manualEligibilityFailures(discount, {
      id: 'customer-1',
      waveguard_tier: 'One-Time',
    })).resolves.toEqual([]);
    await expect(DiscountEngine.manualEligibilityFailures(discount, {
      id: 'customer-2',
      waveguard_tier: 'Silver',
    })).resolves.toEqual(['WaveGuard One-Time']);
  });

  test('fails closed for expired, exhausted, or payment-restricted manual discounts', async () => {
    const discount = serviceScopedDiscount({
      promo_code_expiry: '2020-01-01T00:00:00.000Z',
      promo_code_max_uses: 5,
      promo_code_current_uses: 5,
      payment_method_condition: 'us_bank_account',
    });

    await expect(DiscountEngine.manualEligibilityFailures(discount, null, {
      subtotal: 100,
    })).resolves.toEqual([
      'promo code expiry',
      'promo code usage limit',
      'payment method us_bank_account',
    ]);
  });

  test('caps each applied result so recorded rows reconcile to the subtotal', async () => {
    mockDiscounts([
      serviceScopedDiscount({ id: 'discount-1', discount_type: 'fixed_amount', amount: 80 }),
      serviceScopedDiscount({ id: 'discount-2', discount_type: 'fixed_amount', amount: 80 }),
      serviceScopedDiscount({ id: 'discount-3', discount_type: 'fixed_amount', amount: 10 }),
    ]);

    const result = await DiscountEngine.calculateDiscounts(null, { subtotal: 100 });

    expect(result.discounts.map((row) => row.discount_dollars)).toEqual([80, 20]);
    expect(result.discounts.map((row) => row.id)).toEqual(['discount-1', 'discount-2']);
    expect(result.totalDiscount).toBe(100);
    expect(result.afterDiscount).toBe(0);
  });
});
