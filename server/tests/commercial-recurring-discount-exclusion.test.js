// Regression for Codex R7 P0: an existing commercial customer's flat commercial
// price must NOT be WaveGuard-discounted on accept. The accept path normalizes
// any "lawn"/"tree" service to lawn_care/tree_shrub (which ARE WaveGuard-
// qualifying); commercial lines must keep a distinct, non-qualifying key.
const {
  recurringServiceKey,
  recurringServiceReceivesTierDiscount,
  recurringServiceCountsTowardTier,
  detectPestRecurring,
} = require('../routes/estimate-public');

describe('commercial recurring lines are excluded from WaveGuard discounts on accept', () => {
  test('commercial pest-family services keep a distinct service key (not normalized to residential)', () => {
    expect(recurringServiceKey({ service: 'commercial_lawn' })).toBe('commercial_lawn');
    expect(recurringServiceKey({ service: 'commercial_tree_shrub' })).toBe('commercial_tree_shrub');
    expect(recurringServiceKey({ service: 'commercial_pest' })).toBe('commercial_pest');
    expect(recurringServiceKey({ service: 'commercial_mosquito' })).toBe('commercial_mosquito');
    expect(recurringServiceKey({ service: 'commercial_termite_bait' })).toBe('commercial_termite_bait');
    // commercial_rodent_bait is the trap case — the residential rodent check runs
    // first, so this MUST keep its commercial key (else it reads as the
    // WaveGuard-discountable residential rodent_bait).
    expect(recurringServiceKey({ service: 'commercial_rodent_bait' })).toBe('commercial_rodent_bait');
    // Match by display name too (persisted rows may only carry a label).
    expect(recurringServiceKey({ name: 'Commercial Turf Treatment Program' })).toBe('commercial_lawn');
    // Backward compat: the OLD "Commercial Lawn Treatment" label on already-
    // persisted rows must still normalize to commercial_lawn (not residential).
    expect(recurringServiceKey({ name: 'Commercial Lawn Treatment' })).toBe('commercial_lawn');
    expect(recurringServiceKey({ name: 'Commercial Tree & Shrub' })).toBe('commercial_tree_shrub');
    expect(recurringServiceKey({ name: 'Commercial Pest Control' })).toBe('commercial_pest');
    expect(recurringServiceKey({ name: 'Commercial Mosquito' })).toBe('commercial_mosquito');
    expect(recurringServiceKey({ name: 'Commercial Termite Bait Monitoring' })).toBe('commercial_termite_bait');
    expect(recurringServiceKey({ name: 'Commercial Rodent Bait Stations' })).toBe('commercial_rodent_bait');
  });

  test('commercial termite/rodent keys require a bait/monitoring/station term (not any commercial termite/rodent text)', () => {
    // The recurring bait PROGRAMS classify as the bait key…
    expect(recurringServiceKey({ name: 'Commercial Termite Bait Monitoring' })).toBe('commercial_termite_bait');
    expect(recurringServiceKey({ name: 'Commercial Rodent Bait Stations' })).toBe('commercial_rodent_bait');
    expect(recurringServiceKey({ service: 'commercial_termite_bait' })).toBe('commercial_termite_bait');
    expect(recurringServiceKey({ service: 'commercial_rodent_bait' })).toBe('commercial_rodent_bait');
    // …but non-bait commercial termite/rodent specialty work must NOT inherit the
    // recurring bait key (else accept-discount/tax/scheduling treat it as the line).
    expect(recurringServiceKey({ name: 'Commercial Termite Trenching' })).not.toBe('commercial_termite_bait');
    expect(recurringServiceKey({ name: 'Commercial Termite WDO Inspection' })).not.toBe('commercial_termite_bait');
    expect(recurringServiceKey({ name: 'Commercial Rodent Exclusion' })).not.toBe('commercial_rodent_bait');
    expect(recurringServiceKey({ name: 'Commercial Rodent Trapping' })).not.toBe('commercial_rodent_bait');
  });

  test('residential lawn_care / tree_shrub normalization is unchanged', () => {
    expect(recurringServiceKey({ service: 'lawn_care' })).toBe('lawn_care');
    expect(recurringServiceKey({ service: 'tree_shrub' })).toBe('tree_shrub');
    expect(recurringServiceKey({ name: 'Lawn Care' })).toBe('lawn_care');
    // Residential lawn still receives the tier discount (regression guard).
    expect(recurringServiceReceivesTierDiscount({ service: 'lawn_care' })).toBe(true);
  });

  test('commercial lines never receive a tier discount — even with no exclusion flags', () => {
    // Structural: commercial_* is not a WaveGuard-qualifying key.
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_lawn' })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_tree_shrub' })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_pest' })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_mosquito' })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_termite_bait' })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({ service: 'commercial_rodent_bait' })).toBe(false);
    expect(recurringServiceCountsTowardTier({ service: 'commercial_mosquito' })).toBe(false);
    expect(recurringServiceCountsTowardTier({ service: 'commercial_termite_bait' })).toBe(false);
    expect(recurringServiceCountsTowardTier({ service: 'commercial_rodent_bait' })).toBe(false);
    // And with the carried exclusion flags.
    expect(recurringServiceReceivesTierDiscount({
      service: 'commercial_lawn', excludeFromPctDiscount: true, discountable: false,
    })).toBe(false);
    expect(recurringServiceReceivesTierDiscount({
      service: 'commercial_pest', excludeFromPctDiscount: true, discountable: false,
    })).toBe(false);
  });

  test('commercial lines do not count toward the WaveGuard tier', () => {
    expect(recurringServiceCountsTowardTier({ service: 'commercial_lawn' })).toBe(false);
    expect(recurringServiceCountsTowardTier({ service: 'commercial_tree_shrub' })).toBe(false);
    expect(recurringServiceCountsTowardTier({ service: 'commercial_pest' })).toBe(false);
  });

  test('commercial pest is NOT a residential pest line (no interior/exterior opt-out discount)', () => {
    // The $10/visit interior-spray / exterior-sweep preference discount applies
    // only to residential pest_control. Commercial pest is flat — matching it by
    // a /pest/i name substring would let a customer subtract those discounts from
    // the commercial price. (Regression for the PR bot's preferences P0.)
    expect(detectPestRecurring([
      { service: 'commercial_pest', name: 'Commercial Pest Control', mo: 190 },
    ])).toBeNull();
    // A residential pest line is still detected.
    expect(detectPestRecurring([
      { service: 'pest_control', name: 'Pest Control', mo: 60 },
    ])).toMatchObject({ count: 1 });
    // Mixed: only the residential pest counts.
    expect(detectPestRecurring([
      { service: 'pest_control', name: 'Pest Control', mo: 60 },
      { service: 'commercial_pest', name: 'Commercial Pest Control', mo: 190 },
    ])).toMatchObject({ count: 1 });
  });
});
