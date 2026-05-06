const { RETIRED_MESSAGE } = require('../services/dispatch/retired');

describe('legacy dispatch AI services', () => {
  test('schedule bridge no longer syncs canonical schedule into legacy tables', async () => {
    const bridge = require('../services/dispatch/schedule-bridge');

    await expect(bridge.syncJobsFromSchedule()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(bridge.syncTechnicians()).rejects.toThrow(RETIRED_MESSAGE);
  });

  test('legacy dispatch helpers fail loudly if reintroduced', async () => {
    const optimizer = require('../services/dispatch/route-optimizer');
    const matcher = require('../services/dispatch/tech-matcher');
    const insights = require('../services/dispatch/insight-engine');
    const csr = require('../services/dispatch/csr-booker');
    const scorer = require('../services/dispatch/job-scorer');

    await expect(optimizer.optimizeDay()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(optimizer.optimizeTechRoute()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(optimizer.absorbCancellation()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(matcher.matchJob()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(matcher.simulate()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(insights.getDashboardMetrics()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(csr.getRecommendedSlots()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(scorer.scoreJob()).rejects.toThrow(RETIRED_MESSAGE);
    await expect(scorer.scoreAll()).rejects.toThrow(RETIRED_MESSAGE);
    expect(() => scorer.ruleBasedScore()).toThrow(RETIRED_MESSAGE);
    expect(() => scorer.driveMins()).toThrow(RETIRED_MESSAGE);
  });
});
