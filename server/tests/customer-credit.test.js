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

describe('customer-credit portalCreditsFromLedger', () => {
  test('maps issuances to the portal credit shape with source→type', () => {
    const rows = [
      { id: 'a', delta: 25, source: 'referral', note: 'Referral reward', created_at: '2026-06-19' },
      { id: 'b', delta: 10, source: 'manual', note: null, created_at: '2026-06-18' },
      { id: 'c', delta: 5, source: 'adjustment', note: 'Goodwill', created_at: '2026-06-17' },
    ];
    expect(CustomerCredit.portalCreditsFromLedger(rows)).toEqual([
      { id: 'a', type: 'referral', description: 'Referral reward', amount: 25, date: '2026-06-19' },
      { id: 'b', type: 'promo', description: null, amount: 10, date: '2026-06-18' },
      { id: 'c', type: 'promo', description: 'Goodwill', amount: 5, date: '2026-06-17' },
    ]);
  });

  test('excludes consumption (delta <= 0) and rounds amounts', () => {
    const rows = [
      { id: 'a', delta: 25.005, source: 'referral', created_at: 't1' },
      { id: 'b', delta: -25, source: 'invoice_application', created_at: 't2' },
      { id: 'c', delta: 0, source: 'manual', created_at: 't3' },
    ];
    const out = CustomerCredit.portalCreditsFromLedger(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', type: 'referral', amount: 25.01 });
  });

  test('returns [] for empty or non-array input', () => {
    expect(CustomerCredit.portalCreditsFromLedger()).toEqual([]);
    expect(CustomerCredit.portalCreditsFromLedger(null)).toEqual([]);
    expect(CustomerCredit.portalCreditsFromLedger('nope')).toEqual([]);
  });
});
