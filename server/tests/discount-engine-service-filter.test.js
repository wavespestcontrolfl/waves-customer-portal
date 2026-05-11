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
});
