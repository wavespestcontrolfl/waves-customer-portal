jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  clearCache: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { __private } = require('../routes/admin-discounts');
const { buildDiscountData } = __private;

describe('admin discount validation', () => {
  test('normalizes generated keys, promo codes, service filters, and numeric fields', () => {
    const data = buildDiscountData({
      name: ' Spring Promo ',
      discount_type: 'fixed_amount',
      amount: '25.50',
      promo_code: ' spring25 ',
      service_key_filter: 'Termite Inspection',
      max_discount_dollars: '',
      promo_code_expiry: '',
      sort_order: '3',
      is_active: 1,
    }, { generateKey: true });

    expect(data).toMatchObject({
      discount_key: 'spring_promo',
      name: 'Spring Promo',
      amount: 25.5,
      promo_code: 'SPRING25',
      service_key_filter: 'termite_inspection',
      max_discount_dollars: null,
      promo_code_expiry: null,
      sort_order: 3,
      is_active: true,
    });
  });

  test('rejects invalid discount types, percentages over 100, and fractional integer fields', () => {
    expect(() => buildDiscountData({
      name: 'Bad Type',
      discount_type: 'bogus',
      amount: '10',
    }, { generateKey: true })).toThrow(/Invalid discount type/);

    expect(() => buildDiscountData({
      name: 'Too Much',
      discount_type: 'percentage',
      amount: '101',
    }, { generateKey: true })).toThrow(/Percentage discounts cannot exceed 100/);

    expect(() => buildDiscountData({
      name: 'Bad Sort',
      discount_type: 'fixed_amount',
      amount: '10',
      sort_order: '1.5',
    }, { generateKey: true })).toThrow(/sort_order must be a whole number/);
  });

  test('allows partial amount updates without assuming percentage semantics', () => {
    const data = buildDiscountData({ amount: '125.75' });

    expect(data).toEqual({ amount: 125.75 });
  });

  test('parses string booleans explicitly', () => {
    const data = buildDiscountData({
      name: 'Inactive Promo',
      discount_type: 'fixed_amount',
      amount: '10',
      is_active: 'false',
      show_in_invoices: 'true',
    }, { generateKey: true });

    expect(data.is_active).toBe(false);
    expect(data.show_in_invoices).toBe(true);
    expect(() => buildDiscountData({
      name: 'Bad Boolean',
      discount_type: 'fixed_amount',
      amount: '10',
      is_active: 'sometimes',
    }, { generateKey: true })).toThrow(/is_active must be a boolean/);
  });

  test('forces free-service discounts to a zero amount', () => {
    const data = buildDiscountData({
      name: 'Free Inspection',
      discount_type: 'free_service',
      amount: '99',
    }, { generateKey: true });

    expect(data.amount).toBe(0);
  });

  test('parses naive promo expiry values as Eastern Time', () => {
    const data = buildDiscountData({
      name: 'Summer Promo',
      discount_type: 'fixed_amount',
      amount: '10',
      promo_code_expiry: '2026-07-01T12:00',
    }, { generateKey: true });

    expect(data.promo_code_expiry.toISOString()).toBe('2026-07-01T16:00:00.000Z');
  });
});
