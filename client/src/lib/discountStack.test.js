import { describe, expect, test } from 'vitest';
import {
  stackDiscounts,
  stackVisitDiscounts,
  stackGroupConflict,
  stackablePresets,
} from './discountStack';

// Same worked examples as server/tests/discount-stack.test.js — the two
// modules must agree to the cent.
const SILVER = { id: 'silver', name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, stack_group: 'tier', is_stackable: false };
const GOLD = { id: 'gold', name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, stack_group: 'tier', is_stackable: false };
const MILITARY = { id: 'military', name: 'Military Discount', discount_type: 'percentage', amount: 5, is_stackable: true };
const REFERRAL = { id: 'referral', name: 'Referral Credit', discount_type: 'fixed_amount', amount: 25, is_stackable: true };

describe('stackDiscounts', () => {
  test('10% then 5% compounds to $16.10 off $111 (net $94.90)', () => {
    const result = stackDiscounts(111, [SILVER, MILITARY]);
    expect(result.items.map((i) => i.dollars)).toEqual([11.1, 5]);
    expect(result.net).toBe(94.9);
  });

  test('a $25 credit comes off before the 10%', () => {
    const result = stackDiscounts(111, [SILVER, REFERRAL]);
    expect(result.items.map((i) => i.dollars)).toEqual([8.6, 25]);
    expect(result.net).toBe(77.4);
  });

  test('accepts the camelCase stamp shape too', () => {
    expect(stackDiscounts(111, [{ discountType: 'percentage', discountAmount: 10 }]).net).toBe(99.9);
  });

  test('clamps at zero', () => {
    expect(stackDiscounts(20, [REFERRAL, REFERRAL]).items.map((i) => i.dollars)).toEqual([20, 0]);
  });
});

describe('stackVisitDiscounts', () => {
  test('Silver on the pest line, Military scoped to it, membership line untouched', () => {
    const result = stackVisitDiscounts({
      lines: [
        { gross: 111, lineDiscount: SILVER, eligible: true },
        { gross: 60, lineDiscount: null, eligible: false },
      ],
      appointmentDiscount: MILITARY,
    });
    expect(result.lines[0]).toEqual({ lineDiscountDollars: 11.1, net: 99.9 });
    expect(result.lines[1]).toEqual({ lineDiscountDollars: 0, net: 60 });
    expect(result.appointmentDiscountDollars).toBe(5);
    expect(result.total).toBe(154.9);
  });

  test('a fixed appointment credit is spread pro rata before line percentages', () => {
    const result = stackVisitDiscounts({
      lines: [
        { gross: 100, lineDiscount: SILVER, eligible: true },
        { gross: 50, lineDiscount: SILVER, eligible: true },
        { gross: 40, lineDiscount: null, eligible: false },
      ],
      appointmentDiscount: { discount_type: 'fixed_amount', amount: 30 },
    });
    expect(result.lines.map((l) => l.lineDiscountDollars)).toEqual([8, 4, 0]);
    expect(result.total).toBe(148);
  });
});

describe('stack groups', () => {
  test('two tiers clash; a tier plus stackable rows does not', () => {
    expect(stackGroupConflict([SILVER, GOLD])?.group).toBe('tier');
    expect(stackGroupConflict([SILVER, MILITARY, REFERRAL])).toBeNull();
  });

  test('a line picker keeps the tier another LINE already uses, and drops the rest', () => {
    const offered = stackablePresets(
      [SILVER, GOLD, MILITARY, REFERRAL],
      [{ ...SILVER, scope: 'line:0' }],
      { scope: 'line:1' },
    );
    expect(offered.map((d) => d.id)).toEqual(['silver', 'military', 'referral']);
    expect(stackablePresets([SILVER, GOLD, MILITARY], []).length).toBe(3);
  });

  test('a document-wide picker drops every tier a line uses, including that same tier', () => {
    const offered = stackablePresets(
      [SILVER, GOLD, MILITARY],
      [{ ...SILVER, scope: 'line:0' }],
      { spansAll: true },
    );
    expect(offered.map((d) => d.id)).toEqual(['military']);
  });

  test('a line picker drops the tier the document-wide slot already carries', () => {
    const offered = stackablePresets(
      [SILVER, GOLD, MILITARY],
      [{ ...SILVER, spansAll: true }],
      { scope: 'line:0' },
    );
    expect(offered.map((d) => d.id)).toEqual(['military']);
  });

  test('the same lane never gets its own tier twice', () => {
    const offered = stackablePresets(
      [SILVER, MILITARY],
      [{ ...SILVER, scope: 'line:0' }],
      { scope: 'line:0' },
    );
    expect(offered.map((d) => d.id)).toEqual(['military']);
  });
});
