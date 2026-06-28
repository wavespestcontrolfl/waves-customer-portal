// Regression for Codex R7 P0: an existing commercial customer's flat commercial
// price must NOT be WaveGuard-discounted on accept. The accept path normalizes
// any "lawn"/"tree" service to lawn_care/tree_shrub (which ARE WaveGuard-
// qualifying); commercial lines must keep a distinct, non-qualifying key.
const {
  recurringServiceKey,
  recurringServiceReceivesTierDiscount,
  recurringServiceCountsTowardTier,
} = require('../routes/estimate-public');

describe('commercial recurring lines are excluded from WaveGuard discounts on accept', () => {
  test('commercial lawn/tree keep a distinct service key (not normalized to lawn_care/tree_shrub)', () => {
    expect(recurringServiceKey({ service: 'commercial_lawn' })).toBe('commercial_lawn');
    expect(recurringServiceKey({ service: 'commercial_tree_shrub' })).toBe('commercial_tree_shrub');
    // Match by display name too (persisted rows may only carry a label).
    expect(recurringServiceKey({ name: 'Commercial Lawn Treatment' })).toBe('commercial_lawn');
    expect(recurringServiceKey({ name: 'Commercial Tree & Shrub' })).toBe('commercial_tree_shrub');
  });

  test('residential lawn_care / tree_shrub normalization is unchanged', () => {
    expect(recurringServiceKey({ service: 'lawn_care' })).toBe('lawn_care');
    expect(recurringServiceKey({ service: 'tree_shrub' })).toBe('tree_shrub');
    expect(recurringServiceKey({ name: 'Lawn Care' })).toBe('lawn_care');
    // Residential lawn still receives the tier discount (regression guard).
    expect(recurringServiceReceivesTierDiscount({ service: 'lawn_care' })).toBe(true);
  });

  test('commercial lines never receive a tier discount — even with no exclusion flags', () => {
    // Structural: commercial_lawn is not a WaveGuard-qualifying key.
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_lawn' })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_tree_shrub' })).toBe(false);
    // And with the carried exclusion flags.
    expect(recurringServiceReceivesTierDiscount({
      service: 'commercial_lawn', excludeFromPctDiscount: true, discountable: false,
    })).toBe(false);
  });

  test('commercial lines do not count toward the WaveGuard tier', () => {
    expect(recurringServiceCountsTowardTier({ service: 'commercial_lawn' })).toBe(false);
    expect(recurringServiceCountsTowardTier({ service: 'commercial_tree_shrub' })).toBe(false);
  });
});
