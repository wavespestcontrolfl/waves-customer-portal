import { describe, expect, it } from 'vitest';
import { LAWN_FINDINGS_TYPE, isLawnFastCompleteEligible } from './lawn-fast-complete';

const lawn = (overrides = {}) => ({
  lawnFastCompleteEnabled: true,
  status: 'confirmed',
  completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null },
  ...overrides,
});

describe('isLawnFastCompleteEligible', () => {
  it('needs the schedule flag, the lawn category and an open visit', () => {
    expect(isLawnFastCompleteEligible(lawn())).toBe(true);
    expect(isLawnFastCompleteEligible(lawn({ lawnFastCompleteEnabled: false }))).toBe(false);
    expect(isLawnFastCompleteEligible(lawn({ lawnFastCompleteEnabled: 'true' }))).toBe(false);
    expect(isLawnFastCompleteEligible(lawn({ completionProfile: { category: 'pest_control' } }))).toBe(false);
    expect(isLawnFastCompleteEligible(null)).toBe(false);
    for (const status of ['completed', 'cancelled', 'skipped', 'no_show']) {
      expect(isLawnFastCompleteEligible(lawn({ status }))).toBe(false);
    }
  });

  it('takes every lawn visit type: recurring, one-time (typed lawn findings) and per-application', () => {
    expect(isLawnFastCompleteEligible(lawn({ completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_one_time', findingsType: LAWN_FINDINGS_TYPE } }))).toBe(true);
    expect(isLawnFastCompleteEligible(lawn({ completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_per_application', findingsType: null } }))).toBe(true);
  });

  it('leaves out what has its own lane: re-service, assessment visit, and another service\'s typed findings', () => {
    expect(isLawnFastCompleteEligible(lawn({ completionProfile: { category: 'lawn_care', serviceKey: 'lawn_re_service' } }))).toBe(false);
    expect(isLawnFastCompleteEligible(lawn({ completionProfile: { category: 'lawn_care', serviceKey: 'lawn_inspection' } }))).toBe(false);
    expect(isLawnFastCompleteEligible(lawn({ completionProfile: { category: 'lawn_care', findingsType: 'tree_shrub' } }))).toBe(false);
  });
});

describe('an area add-on is never a lawn visit', () => {
  it('stays out of the lawn sheet by its catalog key, whatever its lawn category or name says', () => {
    const keys = ['area_addon_lawn_insect_spot', 'area_addon_lawn_insect_preventive', 'area_addon_bed_pre_emergent', 'area_addon_hardscape_weed', 'area_addon_fire_ant_yard'];
    for (const serviceKey of keys) {
      expect(isLawnFastCompleteEligible(lawn({ completionProfile: { category: 'lawn_care', serviceKey, findingsType: null } }))).toBe(false);
    }
    // The key can ride the schedule row instead of the profile.
    expect(isLawnFastCompleteEligible(lawn({ serviceKey: 'area_addon_lawn_insect_spot' }))).toBe(false);
    // An ordinary lawn visit with a look-alike key is unaffected.
    expect(isLawnFastCompleteEligible(lawn({ completionProfile: { category: 'lawn_care', serviceKey: 'lawn_insect_control', findingsType: null } }))).toBe(true);
  });
});
