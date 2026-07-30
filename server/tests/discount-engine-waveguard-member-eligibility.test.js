jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const DiscountEngine = require('../services/discount-engine');

function memberDiscount(overrides = {}) {
  return {
    id: 'discount-1',
    discount_key: 'waveguard_member',
    name: 'WaveGuard Member Discount',
    discount_type: 'percentage',
    amount: 15,
    requires_waveguard_tier: 'Bronze',
    ...overrides,
  };
}

describe('WaveGuard member discount tier eligibility', () => {
  test('rejects a tierless one-off customer with no membership evidence', async () => {
    await expect(DiscountEngine.manualEligibilityFailures(memberDiscount(), {
      id: 'customer-1',
      waveguard_tier: null,
    })).resolves.toEqual(['WaveGuard Bronze']);
  });

  test('Bronze floor passes when the booking itself creates recurring coverage', async () => {
    await expect(DiscountEngine.manualEligibilityFailures(memberDiscount(), {
      id: 'customer-1',
      waveguard_tier: null,
    }, { recurringMembershipBooking: true })).resolves.toEqual([]);
  });

  test('Bronze floor recognizes a legacy member with a monthly rate but no tier label', async () => {
    await expect(DiscountEngine.manualEligibilityFailures(memberDiscount(), {
      id: 'customer-1',
      waveguard_tier: null,
      monthly_rate: 55,
    })).resolves.toEqual([]);
  });

  test('a churned customer keeps no member pricing off their stale monthly rate', async () => {
    // cancellation-processor churns with active=false but leaves the
    // historical monthly_rate populated — that rate is not live membership.
    await expect(DiscountEngine.manualEligibilityFailures(memberDiscount(), {
      id: 'customer-1',
      waveguard_tier: null,
      monthly_rate: 55,
      active: false,
    })).resolves.toEqual(['WaveGuard Bronze']);
    // Booking them onto a NEW recurring plan is a re-enrollment sale and
    // still qualifies.
    await expect(DiscountEngine.manualEligibilityFailures(memberDiscount(), {
      id: 'customer-1',
      waveguard_tier: null,
      monthly_rate: 55,
      active: false,
    }, { recurringMembershipBooking: true })).resolves.toEqual([]);
  });

  test('non-member tier sentinels stay ineligible without booking evidence', async () => {
    await expect(DiscountEngine.manualEligibilityFailures(memberDiscount(), {
      id: 'customer-1',
      waveguard_tier: 'One-Time',
    })).resolves.toEqual(['WaveGuard Bronze']);
  });

  test('a One-Time customer converting to a recurring plan qualifies on that booking', async () => {
    await expect(DiscountEngine.manualEligibilityFailures(memberDiscount(), {
      id: 'customer-1',
      waveguard_tier: 'One-Time',
    }, { recurringMembershipBooking: true })).resolves.toEqual([]);
  });

  test('Silver+ requirements stay strictly tier-based — booking evidence is not a tier', async () => {
    const silverDiscount = memberDiscount({ requires_waveguard_tier: 'Silver' });
    await expect(DiscountEngine.manualEligibilityFailures(silverDiscount, {
      id: 'customer-1',
      waveguard_tier: null,
      monthly_rate: 55,
    }, { recurringMembershipBooking: true })).resolves.toEqual(['WaveGuard Silver']);
    await expect(DiscountEngine.manualEligibilityFailures(silverDiscount, {
      id: 'customer-2',
      waveguard_tier: 'Gold',
    })).resolves.toEqual([]);
  });
});
