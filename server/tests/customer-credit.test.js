/**
 * Unit coverage for the customer-credit service guard rails. These checks
 * run before any DB work, so they exercise validation without a live
 * Postgres connection.
 */
const CustomerCredit = require('../services/customer-credit');

describe('customer-credit round2', () => {
  test('rounds to two decimals and coerces junk to 0', () => {
    expect(CustomerCredit.round2(10.005)).toBe(10.01);
    expect(CustomerCredit.round2(10.004)).toBe(10);
    expect(CustomerCredit.round2('25.50')).toBe(25.5);
    expect(CustomerCredit.round2(undefined)).toBe(0);
    expect(CustomerCredit.round2(NaN)).toBe(0);
  });
});

describe('customer-credit postCreditMovement validation', () => {
  test('rejects a missing customer', async () => {
    await expect(
      CustomerCredit.postCreditMovement({ customerId: '', delta: 10, source: 'manual' }),
    ).rejects.toThrow('customerId is required');
  });

  test('rejects a zero or non-finite delta', async () => {
    await expect(
      CustomerCredit.postCreditMovement({ customerId: 'c1', delta: 0, source: 'manual' }),
    ).rejects.toThrow('non-zero amount');
    await expect(
      CustomerCredit.postCreditMovement({ customerId: 'c1', delta: 'abc', source: 'manual' }),
    ).rejects.toThrow('non-zero amount');
  });

  test('rejects an unknown source', async () => {
    await expect(
      CustomerCredit.postCreditMovement({ customerId: 'c1', delta: 10, source: 'bogus' }),
    ).rejects.toThrow('source must be one of');
  });

  test('whitelists the expected sources', () => {
    expect([...CustomerCredit.VALID_SOURCES]).toEqual([
      'manual', 'adjustment', 'invoice_application', 'invoice_prepaid', 'referral',
    ]);
  });
});
