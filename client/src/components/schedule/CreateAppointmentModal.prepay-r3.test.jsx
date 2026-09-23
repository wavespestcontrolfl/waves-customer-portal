/**
 * PR #4405 Codex round 3 — the prepayment projection and the shared
 * custom-preset predicate.
 *
 * P1: `prepaid.totalAmount` multiplied `groupSubtotal`, which carries the
 * LINE discounts only. A four-visit $100 series with a 10% appointment-level
 * discount therefore recorded $400 prepaid while the created visits total
 * $360, and stampSeriesPrepaid trusts that client total and splits the
 * overstatement across the series.
 *
 * P2: the Edit Appointment picker's copy of the custom-preset test missed
 * the variable_* types, so picking one skipped the operator prompt and the
 * server dropped the zero-valued slot. All four pickers now share one
 * predicate.
 */
import { describe, it, expect } from 'vitest';
import { recurringGroupRequestFields } from './CreateAppointmentModal';
import { isCustomAmountPreset, isCustomPercentagePreset } from '../../lib/discountStack';

const GROUP = { cadence: 'quarterly', lines: [{ boosterMonths: [] }] };
const base = {
  isRecurring: true,
  group: GROUP,
  recurringCount: '4',
  skipWeekends: false,
  weekendShift: 'forward',
  collectPrepay: true,
  prepayMethod: 'cash',
  prepayNote: '',
};

describe('prepaid.totalAmount projects the STACKED per-visit total (r3 P1)', () => {
  it('a 4-visit $100 series with a 10% appointment discount records $360, not $400', () => {
    const fields = recurringGroupRequestFields({
      ...base, groupSubtotal: 100, prepayPerVisitAmount: 90,
    });
    expect(fields.prepaid.totalAmount).toBe(360);
  });

  it('falls back to the subtotal when the group carries no appointment discount', () => {
    const fields = recurringGroupRequestFields({ ...base, groupSubtotal: 100 });
    expect(fields.prepaid.totalAmount).toBe(400);
  });

  it('an explicit per-visit amount equal to the subtotal is the same projection', () => {
    const fields = recurringGroupRequestFields({
      ...base, groupSubtotal: 100, prepayPerVisitAmount: 100,
    });
    expect(fields.prepaid.totalAmount).toBe(400);
  });

  it('no prepay collected → no prepaid block at all', () => {
    const fields = recurringGroupRequestFields({
      ...base, collectPrepay: false, groupSubtotal: 100, prepayPerVisitAmount: 90,
    });
    expect(fields.prepaid).toBeUndefined();
  });

  it('an ongoing series still uses the 4-visit default against the stacked total', () => {
    const fields = recurringGroupRequestFields({
      ...base, recurringCount: '', groupSubtotal: 100, prepayPerVisitAmount: 90,
    });
    expect(fields.prepaid.totalAmount).toBe(360);
    expect(fields.recurringOngoing).toBe(true);
  });
});

describe('the shared custom-preset predicate covers the variable_* types (r3 P2)', () => {
  it('recognizes variable presets, which the Edit Appointment copy used to miss', () => {
    expect(isCustomPercentagePreset({ discount_type: 'variable_percentage', amount: 0 })).toBe(true);
    expect(isCustomAmountPreset({ discount_type: 'variable_amount', amount: 0 })).toBe(true);
  });

  it('still recognizes the seeded zero-amount custom rows', () => {
    expect(isCustomPercentagePreset({ discount_type: 'percentage', discount_key: 'custom_percent', amount: 0 })).toBe(true);
    expect(isCustomAmountPreset({ discount_type: 'fixed_amount', discount_key: 'custom_dollar', amount: 0 })).toBe(true);
  });

  it('leaves an ordinary priced preset alone', () => {
    expect(isCustomPercentagePreset({ discount_type: 'percentage', discount_key: 'loyalty', amount: 10 })).toBe(false);
    expect(isCustomAmountPreset({ discount_type: 'fixed_amount', discount_key: 'promo', amount: 30 })).toBe(false);
  });
});
