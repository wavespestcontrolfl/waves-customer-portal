/**
 * Multi-Home Discount eligibility with the "Same family" link (owner 2026-11-04): a requires_multi_home discount
 * passes when customers.has_multi_home is true OR the profile is in a family with 2+ active live profiles.
 * The family table is asked only when the discount needs it and the flag is not already true; a lookup error
 * fails closed. The Postgres half is multi-home-family-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockEligible = jest.fn();
jest.mock('../services/multi-home-family', () => ({
  ...jest.requireActual('../services/multi-home-family'),
  familyMultiHomeEligible: (...args) => mockEligible(...args),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const DiscountEngine = require('../services/discount-engine');
const realFamily = jest.requireActual('../services/multi-home-family');

const multiHome = (overrides = {}) => ({
  id: 'discount-mh', discount_key: 'multi_home', name: 'Multi-Home Discount', discount_type: 'percentage', amount: 10,
  is_waveguard_tier_discount: false, promo_code: null, is_auto_apply: true,
  requires_military: false, requires_senior: false, requires_multi_home: true, requires_new_customer: false,
  requires_referral: false, requires_prepayment: false, requires_waveguard_tier: null,
  service_key_filter: null, service_category_filter: null, min_subtotal: null, min_service_count: null,
  show_in_invoices: true, show_in_estimates: true, is_stackable: true, stack_group: null, priority: 1,
  ...overrides,
});

beforeEach(() => { jest.clearAllMocks(); DiscountEngine.clearCache(); });

describe('manualEligibilityFailures', () => {
  const fakeConn = { fake: true };

  test('a linked single-home profile passes, and the lookup uses the connection the caller passed', async () => {
    mockEligible.mockResolvedValue(true);
    const failures = await DiscountEngine.manualEligibilityFailures(multiHome(), { id: 'c1', has_multi_home: false }, {}, fakeConn);
    expect(failures).toEqual([]);
    expect(mockEligible).toHaveBeenCalledWith(fakeConn, 'c1');
  });

  test('a profile that is not linked still fails with multi-home status', async () => {
    mockEligible.mockResolvedValue(false);
    const failures = await DiscountEngine.manualEligibilityFailures(multiHome(), { id: 'c1', has_multi_home: false }, {}, fakeConn);
    expect(failures).toEqual(['multi-home status']);
  });

  test('no family query when has_multi_home is already true', async () => {
    const failures = await DiscountEngine.manualEligibilityFailures(multiHome(), { id: 'c1', has_multi_home: true }, {}, fakeConn);
    expect(failures).toEqual([]);
    expect(mockEligible).not.toHaveBeenCalled();
  });

  test('no family query when the discount does not need multi-home', async () => {
    const failures = await DiscountEngine.manualEligibilityFailures(multiHome({ requires_multi_home: false }), { id: 'c1', has_multi_home: false }, {}, fakeConn);
    expect(failures).toEqual([]);
    expect(mockEligible).not.toHaveBeenCalled();
  });

  test('no family query without a customer id', async () => {
    const failures = await DiscountEngine.manualEligibilityFailures(multiHome(), { has_multi_home: false }, {}, fakeConn);
    expect(failures).toEqual(['multi-home status']);
    expect(mockEligible).not.toHaveBeenCalled();
  });
});

describe('familyMultiHomeEligible fails closed', () => {
  test('a lookup error answers false and logs a warning', async () => {
    const conn = () => { throw new Error('connection reset'); };
    await expect(realFamily.familyMultiHomeEligible(conn, 'c1')).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('a missing table (42P01) answers false', async () => {
    const conn = () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); };
    await expect(realFamily.familyMultiHomeEligible(conn, 'c1')).resolves.toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a customer id of null answers false without a query', async () => {
    const conn = jest.fn();
    await expect(realFamily.familyMultiHomeEligible(conn, null)).resolves.toBe(false);
    expect(conn).not.toHaveBeenCalled();
  });
});

describe('calculateDiscounts auto-apply', () => {
  function mockTables(customer, discounts) {
    const chain = (result) => {
      const q = {};
      for (const m of ['where', 'whereNotIn', 'whereRaw', 'countDistinct', 'count', 'select']) q[m] = jest.fn(() => q);
      q.first = jest.fn(async () => result);
      q.orderBy = jest.fn(async () => result);
      q.then = (resolve, reject) => Promise.resolve(Array.isArray(result) ? result : []).then(resolve, reject);
      return q;
    };
    db.mockImplementation((table) => {
      if (table === 'customers') return chain(customer);
      if (table === 'discounts') return chain(discounts);
      if (table === 'customer_discounts') return chain([]);
      if (table === 'scheduled_services' || table === 'service_records') return chain({ cnt: 0 });
      throw new Error(`Unexpected table ${table}`);
    });
  }

  test('a family-eligible single-home customer gets the 10% and the family is asked once for two such discounts', async () => {
    mockEligible.mockResolvedValue(true);
    mockTables({ id: 'c1', has_multi_home: false },
      [multiHome(), multiHome({ id: 'discount-mh-2', discount_key: 'multi_home_2', stack_group: 'g2', priority: 2 })]);
    const result = await DiscountEngine.calculateDiscounts('c1', { subtotal: 100 });
    expect(result.discounts.length).toBeGreaterThanOrEqual(1);
    expect(result.totalDiscount).toBeGreaterThan(0);
    expect(mockEligible).toHaveBeenCalledTimes(1);
  });

  test('a customer who is not linked gets no multi-home discount', async () => {
    mockEligible.mockResolvedValue(false);
    mockTables({ id: 'c1', has_multi_home: false }, [multiHome()]);
    const result = await DiscountEngine.calculateDiscounts('c1', { subtotal: 100 });
    expect(result.discounts).toEqual([]);
    expect(result.totalDiscount).toBe(0);
  });

  test('has_multi_home true skips the family query', async () => {
    mockTables({ id: 'c1', has_multi_home: true }, [multiHome()]);
    const result = await DiscountEngine.calculateDiscounts('c1', { subtotal: 100 });
    expect(result.totalDiscount).toBe(10);
    expect(mockEligible).not.toHaveBeenCalled();
  });
});
