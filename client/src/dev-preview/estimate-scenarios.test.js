import { describe, expect, it } from 'vitest';
import { ESTIMATE_SCENARIOS } from './estimate-scenarios';

describe('estimate visual fixture gallery', () => {
  it('keeps every governed service and difficult customer state in the permanent gallery', () => {
    const keys = ESTIMATE_SCENARIOS.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining([
      'pest', 'lawn', 'mosquito', 'tree_shrub', 'termite_bait', 'rodent',
      'wdo', 'termite_foam', 'bora_care', 'trap_only', 'bundle', 'commercial',
      'quote_required', 'bundle_referral', 'lawn_member_upgrade', 'accepted',
      'expired', 'missing_contact', 'long_content',
    ]));
  });
});
