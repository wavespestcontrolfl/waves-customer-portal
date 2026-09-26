/**
 * Owner ruling 2026-09-26 ("auto-fill, staff can remove it"): the New
 * Appointment modal preselects a Silver/Gold/Platinum customer's WaveGuard
 * tier discount on a recurring line so staff stop forgetting to pick one by
 * hand — three real Silver customers were booked at full price this way
 * (scheduled_services.source='admin', no discount).
 *
 * autoTierDiscountForLine is the pure decision helper the modal's own
 * effect calls per line; it never re-implements scope/stack-group/tier-
 * exclusivity eligibility itself — `offeredDiscounts` is exactly what the
 * SAME line's manual picker would offer (offeredLineDiscounts in the
 * modal), so a discount the picker itself would not show is never force-
 * fed through here either. These tests exercise the helper directly, the
 * same convention as CreateAppointmentModal.discount-scope-r2.test.jsx —
 * no need to mount the 200-property modal.
 */
import { describe, it, expect } from 'vitest';
import { autoTierDiscountForLine } from './CreateAppointmentModal';

const SILVER = {
  id: 'd-silver', name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10,
  is_waveguard_tier_discount: true, requires_waveguard_tier: 'Silver',
  is_stackable: false, stack_group: 'tier',
};
const GOLD = {
  id: 'd-gold', name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15,
  is_waveguard_tier_discount: true, requires_waveguard_tier: 'Gold',
  is_stackable: false, stack_group: 'tier',
};
const BRONZE = {
  id: 'd-bronze', name: 'WaveGuard Bronze', discount_type: 'percentage', amount: 0,
  is_waveguard_tier_discount: true, requires_waveguard_tier: 'Bronze',
  is_stackable: false, stack_group: 'tier',
};
const MILITARY = {
  id: 'd-military', name: 'Military Discount', discount_type: 'percentage', amount: 5,
};

const base = (overrides = {}) => ({
  customerTier: 'Silver',
  cadence: 'quarterly',
  linkedEstimate: false,
  linePrepaid: false,
  hasLineDiscount: false,
  autoTierRemoved: false,
  offeredDiscounts: [SILVER, MILITARY],
  ...overrides,
});

describe('autoTierDiscountForLine (owner ruling 2026-09-26)', () => {
  it('Silver customer + recurring line with nothing chosen -> preselects Silver', () => {
    const picked = autoTierDiscountForLine(base());
    expect(picked?.id).toBe('d-silver');
  });

  it('Gold and Platinum customers pick their own tier row the same way', () => {
    expect(autoTierDiscountForLine(base({
      customerTier: 'Gold', offeredDiscounts: [GOLD, MILITARY],
    }))?.id).toBe('d-gold');
    expect(autoTierDiscountForLine(base({
      customerTier: 'Platinum',
      offeredDiscounts: [{ ...GOLD, id: 'd-plat', requires_waveguard_tier: 'Platinum' }],
    }))?.id).toBe('d-plat');
  });

  it('Bronze, no tier, and One-Time customers never get an auto pick', () => {
    expect(autoTierDiscountForLine(base({ customerTier: 'Bronze', offeredDiscounts: [BRONZE] }))).toBeNull();
    expect(autoTierDiscountForLine(base({ customerTier: null }))).toBeNull();
    expect(autoTierDiscountForLine(base({ customerTier: 'One-Time' }))).toBeNull();
  });

  it('a one-time (or blank-cadence) line is never touched, even for a Silver+ customer', () => {
    expect(autoTierDiscountForLine(base({ cadence: 'one_time' }))).toBeNull();
    expect(autoTierDiscountForLine(base({ cadence: null }))).toBeNull();
    expect(autoTierDiscountForLine(base({ cadence: undefined }))).toBeNull();
  });

  it('a booking linked to an estimate is skipped — the quoted price may already bake in the tier %', () => {
    expect(autoTierDiscountForLine(base({ linkedEstimate: true }))).toBeNull();
  });

  it('a prepaid / pay-in-full line is skipped', () => {
    expect(autoTierDiscountForLine(base({ linePrepaid: true }))).toBeNull();
  });

  it('a line that already has ANY discount chosen is left alone (never overridden)', () => {
    expect(autoTierDiscountForLine(base({ hasLineDiscount: true }))).toBeNull();
  });

  it('an operator who removed (or changed) the preselected discount on this line never gets it back', () => {
    expect(autoTierDiscountForLine(base({ autoTierRemoved: true }))).toBeNull();
  });

  it('a conflicting tier already committed elsewhere in the group -> the picker offers nothing, so neither does this', () => {
    // The line's own picker (offeredLineDiscounts) already excludes Silver
    // here via stack-group exclusivity — Gold sits on another line in the
    // same submit group. The helper must not reach past that and apply
    // Silver anyway.
    expect(autoTierDiscountForLine(base({ offeredDiscounts: [MILITARY] }))).toBeNull();
  });

  it('the catalog row itself missing (deactivated, or the exact tier variant not offered) -> none', () => {
    expect(autoTierDiscountForLine(base({
      offeredDiscounts: [{ ...SILVER, requires_waveguard_tier: 'Gold' }],
    }))).toBeNull();
  });

  it('is scope/eligibility-blind by design — it trusts offeredDiscounts completely, never re-deriving from raw catalog fields', () => {
    // A row could carry is_waveguard_tier_discount + a matching tier but
    // still legitimately be absent from offeredDiscounts (scope filter,
    // an in-flight stacking-gate check, etc.) — absence alone is enough.
    expect(autoTierDiscountForLine(base({ offeredDiscounts: [] }))).toBeNull();
  });
});
