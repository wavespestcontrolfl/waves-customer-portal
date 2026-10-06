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
