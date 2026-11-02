/**
 * The advisor hook for negative keyword bells (owner plan A, 2026-11-02, PR 2): a MODEL-written report, once stored, hands
 * itself to queueAdvisorNegatives; the outage fallback never does; a failure there only logs and never fails the report.
 */
process.env.ANTHROPIC_API_KEY = 'test-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../services/seo/search-console-v2', () => ({ getPerformanceSummary: jest.fn().mockResolvedValue({ current: { clicks: 0 } }) }));
jest.mock('../services/ads/google-ads', () => ({ isConfigured: () => false }));
jest.mock('../services/ads/budget-manager', () => ({
  getTechCountForArea: jest.fn().mockResolvedValue(1),
  getCapacityForArea: jest.fn().mockResolvedValue({ utilization: 0.4 }),
}));
jest.mock('../services/ads/negative-keyword-actions', () => ({ queueAdvisorNegatives: jest.fn().mockResolvedValue({ queued: 1, rang: 1 }) }));
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));

const CAMPAIGN = {
  id: '11111111-1111-4111-8111-111111111111', campaign_name: 'Synthetic Search', platform: 'google_ads',
  status: 'active', daily_budget_base: 5, daily_budget_current: 5, budget_mode: 'base', platform_campaign_id: '9000000001',
};
const mockStored = [];
jest.mock('../models/db', () => jest.fn((table) => {
  const b = {
    where: () => b, orderBy: () => b, select: () => b, distinct: () => b, limit: () => b,
    first: () => Promise.resolve(table === 'system_settings'
      ? { key: 'ads.search_terms.last_synced_at', value: new Date(Date.now() - 3600 * 1000).toISOString() }
      : null),
    insert: (row) => {
      mockStored.push([table, row]);
      return Object.assign(Promise.resolve([1]), { onConflict: () => ({ ignore: () => ({ returning: () => Promise.resolve([{ date: row.date }]) }) }) });
    },
    then: (r, j) => Promise.resolve(table === 'ad_campaigns' ? [CAMPAIGN] : []).then(r, j),
  };
  return b;
}));

const logger = require('../services/logger');
const negativeActions = require('../services/ads/negative-keyword-actions');
const advisor = require('../services/ads/campaign-advisor');

const REPORT = {
  overall_assessment: 'About $46 over 30 days and 2 conversions is too little data to conclude anything.',
  grade: 'B',
  recommendations: [{
    priority: 'low', campaign: 'Synthetic Search', campaign_id: CAMPAIGN.id, action: 'Block "squirrel"',
    reasoning: 'Six clicks and $9.50 spent on squirrel searches with no conversions.', estimated_impact: '$9/month', apply_action: 'add_negative', apply_value: 'Squirrel',
  }],
  waste_alerts: [], scaling_opportunities: [], capacity_warnings: [], seo_insights: [], insights: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStored.length = 0;
  mockDispatch.mockReset();
});

test('a model-written report is stored first, then handed over with its add_negative value normalized and its campaign stamped', async () => {
  mockDispatch.mockResolvedValue({ ok: true, json: { ...REPORT, recommendations: REPORT.recommendations.map((r) => ({ ...r })) }, provider: 'anthropic', model: 'm' });
  await advisor.generateDailyAdvice();
  expect(mockStored.some(([table]) => table === 'ad_advisor_reports')).toBe(true);
  expect(negativeActions.queueAdvisorNegatives).toHaveBeenCalledTimes(1);
  const [advice] = negativeActions.queueAdvisorNegatives.mock.calls[0];
  expect(advice.recommendations).toHaveLength(1);
  expect(advice.recommendations[0]).toMatchObject({ apply_action: 'add_negative', apply_value: 'squirrel', campaign_id: CAMPAIGN.id });
});

test('a failure in the hook only logs: the report is still returned', async () => {
  negativeActions.queueAdvisorNegatives.mockRejectedValueOnce(new Error('bell down'));
  mockDispatch.mockResolvedValue({ ok: true, json: { ...REPORT }, provider: 'anthropic', model: 'm' });
  const advice = await advisor.generateDailyAdvice();
  expect(advice.grade).toBe('B');
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bell down'));
  expect(logger.error).not.toHaveBeenCalled();
});

test('the outage fallback never reaches the hook', async () => {
  mockDispatch.mockRejectedValue(new Error('both providers down'));
  const advice = await advisor.generateDailyAdvice();
  expect(advice.overall_assessment).toContain('AI advisor unavailable');
  expect(negativeActions.queueAdvisorNegatives).not.toHaveBeenCalled();
});
