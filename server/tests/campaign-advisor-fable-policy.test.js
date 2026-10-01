/**
 * Daily ads advisor (owner ruling 2026-10-01): Claude Fable 5.1 at effort high
 * writes the report (OpenAI Sol backup), recommends only what is real and
 * number-backed (no quota — zero recommendations is a valid answer), and an
 * empty recommendations list flows through validate → store → SMS summary.
 */
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.ADAM_PHONE = '+15555550100';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockSendSMS = jest.fn().mockResolvedValue({});
jest.mock('../services/twilio', () => ({ sendSMS: (...a) => mockSendSMS(...a) }));
jest.mock('../services/seo/search-console-v2', () => ({
  getPerformanceSummary: jest.fn().mockResolvedValue({ current: { clicks: 0 } }),
}));
jest.mock('../services/ads/google-ads', () => ({ isConfigured: () => false }));
jest.mock('../services/ads/budget-manager', () => ({
  getTechCountForArea: jest.fn().mockResolvedValue(1),
  getCapacityForArea: jest.fn().mockResolvedValue({ utilization: 0.4 }),
}));

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));

const CAMPAIGN = {
  id: '11111111-1111-4111-8111-111111111111', campaign_name: 'Synthetic Search', platform: 'google_ads',
  status: 'active', daily_budget_base: 5, daily_budget_current: 5, budget_mode: 'base',
};
const SEARCH_TERMS = [
  { search_term: 'synthetic term spent', clicks: 4, cost: '3.50', conversions: '0', conversion_value: '0', roas: '0' },
  { search_term: 'synthetic term free', clicks: 0, cost: '0', conversions: '0', conversion_value: '0', roas: '0' },
];
const mockInsert = jest.fn().mockResolvedValue([1]);
jest.mock('../models/db', () => jest.fn((table) => {
  const rowsFor = {
    ad_campaigns: [CAMPAIGN],
    ad_search_terms: SEARCH_TERMS,
  };
  const b = {
    where: () => b, orderBy: () => b, limit: () => b, select: () => b,
    first: () => Promise.resolve(null),
    insert: (row) => mockInsert(table, row),
    then: (r, j) => Promise.resolve(rowsFor[table] || []).then(r, j),
  };
  return b;
}));

const MODELS = require('../config/models');
const advisor = require('../services/ads/campaign-advisor');

const EMPTY_REPORT = {
  overall_assessment: 'About $46 over 30 days and 2 conversions is too little data to conclude anything.',
  grade: 'B',
  recommendations: [],
  waste_alerts: [],
  insights: [],
};

beforeEach(() => {
  mockDispatch.mockReset();
  mockSendSMS.mockClear();
  mockInsert.mockClear();
});

describe('adsAdvisor policy wiring', () => {
  test('Fable 5.1 primary at effort high, OpenAI report-writer fallback, deep-catalog model', () => {
    const policy = MODELS.TEXT_POLICIES.adsAdvisor;
    expect(policy.name).toBe('adsAdvisor');
    expect(policy.primary).toEqual({ provider: 'anthropic', model: MODELS.ADS_ADVISOR, effort: 'high' });
    expect(policy.fallback).toEqual({ provider: 'openai', model: MODELS.OPENAI_REPORT_WRITER });
    expect(MODELS.ADS_ADVISOR).toBe(process.env.MODEL_ADS_ADVISOR || 'claude-fable-5-1');
    expect(MODELS.MODEL_CATALOG[MODELS.ADS_ADVISOR].requires).toBe('deep');
  });

  test('the advisor dispatches on adsAdvisor with room for thinking plus the full JSON', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'claude-fable-5-1' });
    await advisor.generateDailyAdvice();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [policy, payload] = mockDispatch.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.adsAdvisor);
    expect(payload.laneId).toBe('ads_advisor');
    expect(payload.maxTokens).toBeGreaterThanOrEqual(8000);
    expect(payload.timeoutMs).toBe(10 * 60 * 1000);
  });
});

describe('prompt rules', () => {
  test('forbids padding: no quota, zero is valid, numbers cited, thin data said plainly, no repeats', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    const { system, text } = mockDispatch.mock.calls[0][1];
    expect(system).toMatch(/There is no quota/);
    expect(system).toMatch(/Zero recommendations is a valid/);
    expect(system).toMatch(/one strong recommendation beats six weak ones/);
    expect(system).toMatch(/MUST cite the specific numbers/);
    expect(system).toMatch(/data volume is too small/);
    expect(system).toMatch(/already been done/);
    expect(system).not.toMatch(/4[–-]8 recommendations/);
    // The apply contract is intact.
    expect(system).toContain('increase_budget/decrease_budget/change_mode');
    expect(system).toContain('"apply_value": "REQUIRED for increase_budget/decrease_budget');
    expect(text).toMatch(/empty recommendations list is a valid answer/);
  });

  test('passes every search term that cost money (not a top-30 slice) and omits $0 terms', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    const { text } = mockDispatch.mock.calls[0][1];
    expect(text).toContain('synthetic term spent');
    expect(text).not.toContain('synthetic term free');
  });
});

describe('empty recommendations', () => {
  test('are accepted by the leg validator, stored with a zero count, stamped with the writing model, and texted as nothing-to-do', async () => {
    mockDispatch.mockImplementation(async (_policy, _payload, opts) => {
      const json = { ...EMPTY_REPORT };
      expect(opts.validate({ json })).toBeNull();
      return { ok: true, json, provider: 'anthropic', model: 'claude-fable-5-1' };
    });
    const out = await advisor.generateDailyAdvice();
    expect(out.recommendations).toEqual([]);
    expect(out.model).toBe('claude-fable-5-1');
    expect(out.provider).toBe('anthropic');

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0][1];
    expect(row.recommendation_count).toBe(0);
    expect(row.grade).toBe('B');
    expect(JSON.parse(row.report_data).model).toBe('claude-fable-5-1');

    expect(mockSendSMS).toHaveBeenCalledTimes(1);
    const body = mockSendSMS.mock.calls[0][1];
    expect(body).toContain('No changes recommended today.');
    expect(body).not.toContain('Top actions');
  });

  test('isUsableAdsReport / normalize accept an empty list; a missing list is fine too', () => {
    expect(advisor.isUsableAdsReport({ ...EMPTY_REPORT })).toBe(true);
    const { recommendations, ...noList } = EMPTY_REPORT;
    expect(advisor.isUsableAdsReport(noList)).toBe(true);
    expect(advisor.normalizeAdsReport({ ...EMPTY_REPORT }).recommendations).toEqual([]);
  });

  test('the rule-based fallback with no actions stores and reads as an empty list', () => {
    const fb = advisor.generateFallbackAdvice([], null);
    expect(fb.recommendations).toEqual([]);
    expect(advisor.isUsableAdsReport(fb)).toBe(true);
  });
});
