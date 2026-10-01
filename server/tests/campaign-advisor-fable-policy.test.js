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
const mockWhereCalls = [];
const mockBudgetRow = (i, budgetTo = 8) => ({
  campaign_id: `synthetic-campaign-${i}`, campaign_name: `Synthetic Search ${i}`, previous_mode: 'base', new_mode: 'base',
  previous_budget: '5.00', new_budget: String(budgetTo), trigger: 'advisor', reason: `synthetic raise ${i}`,
  created_at: '2026-09-30T12:00:00Z',
});
let mockBudgetLog = [];
let mockSearchTerms = SEARCH_TERMS;
let mockFirstRows = {};
const mockLimits = [];
jest.mock('../models/db', () => jest.fn((table) => {
  const rowsFor = {
    ad_campaigns: [CAMPAIGN],
    ad_search_terms: mockSearchTerms,
    ad_budget_log: mockBudgetLog,
  };
  const b = {
    where: (...args) => { mockWhereCalls.push({ table, args }); return b; }, orderBy: () => b, select: () => b, distinct: () => b,
    limit: (n) => { mockLimits.push([table, n]); return b; },
    first: () => Promise.resolve(mockFirstRows[table] || null),
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
  waste_alerts: [], scaling_opportunities: [], capacity_warnings: [], seo_insights: [],
  insights: [],
};

beforeEach(() => {
  mockBudgetLog = [mockBudgetRow(1)];
  mockLimits.length = 0;
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

describe('provenance and recent-change context (Codex r1 on #5486)', () => {
  test('stamps the provider-reported servedModel over the requested route model', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'claude-fable-5-1', servedModel: 'claude-fable-5-1-20260901' });
    const out = await advisor.generateDailyAdvice();
    expect(out.model).toBe('claude-fable-5-1-20260901');
  });

  test('recent budget changes carry the dollar amounts, so a same-mode budget change is visible', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    const { text } = mockDispatch.mock.calls[0][1];
    expect(text).toContain('"budget_from":5');
    expect(text).toContain('"budget_to":8');
  });

  test('every change in the 7-day window reaches the prompt, not just the newest 10 (Codex r2 on #5486)', async () => {
    mockBudgetLog = Array.from({ length: 35 }, (_, i) => mockBudgetRow(i + 1));
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    const { text } = mockDispatch.mock.calls[0][1];
    for (let i = 1; i <= 35; i++) expect(text).toContain(`"campaign":"Synthetic Search ${i}"`);
    expect(text).not.toMatch(/older changes in the 7-day window are omitted/);
  });

  test('a window past the hard cap is bounded and the prompt says it was cut', async () => {
    mockBudgetLog = Array.from({ length: 201 }, (_, i) => mockBudgetRow(i + 1));
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    expect(mockLimits).toContainEqual(['ad_budget_log', 201]);
    const { text } = mockDispatch.mock.calls[0][1];
    expect(text).toContain('"campaign":"Synthetic Search 200"');
    expect(text).not.toContain('"campaign":"Synthetic Search 201"');
    expect(text).toContain('Only the 200 most recent changes are listed; older changes in the 7-day window are omitted.');
  });
});

describe('Codex r4 on #5486', () => {
  test('search terms are limited to rows refreshed by a recent sync (aged-out rows never reach the prompt)', async () => {
    mockWhereCalls.length = 0;
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    const fresh = mockWhereCalls.find((c) => c.table === 'ad_search_terms' && c.args[0] === 'updated_at');
    expect(fresh.args[1]).toBe('>=');
    const ageMs = Date.now() - fresh.args[2].getTime();
    expect(ageMs).toBeGreaterThanOrEqual(47 * 3600 * 1000);
    expect(ageMs).toBeLessThanOrEqual(49 * 3600 * 1000);
  });

  test('recent budget changes are identified by campaign_id, not just the (non-unique) name', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    expect(mockDispatch.mock.calls[0][1].text).toContain('"campaign_id":"synthetic-campaign-1"');
  });

  test('the chain reserves part of the 10-minute budget for the OpenAI fallback', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    expect(mockDispatch.mock.calls[0][2].reserveFallbackBudget).toBe(true);
  });

  test('fallback advice recommends nothing at all (owner quality bar), and reports the numbers', () => {
    const summary = {
      id: 'c-1', name: 'Synthetic Search', platform: 'google_ads', status: 'active', linked: false,
      budgetMode: 'base', dailyBudgetBase: 20, dailyBudgetCurrent: 20,
      last7d: { roas: 1, lostISBudget: 40, spend: 12.5, conversions: 1 },
    };
    const fb = advisor.generateFallbackAdvice([summary]);
    expect(fb.recommendations).toEqual([]);
    expect(fb.grade).toBe('N/A');
    expect(fb.overall_assessment).toMatch(/AI advisor unavailable — no recommendations generated/);
    expect(fb.overall_assessment).toContain('$12.50 spend, 1 conversion');
  });

});

describe('search-term truncation (Codex r6 on #5486)', () => {
  afterEach(() => { mockSearchTerms = SEARCH_TERMS; mockFirstRows = {}; });
  const term = (i) => ({ search_term: `synthetic term ${i}`, clicks: 1, cost: String(200 - i), conversions: '0', conversion_value: '0', roas: '0' });

  test('101 spend rows: the prompt lists 100 and says the list is TRUNCATED', async () => {
    mockSearchTerms = Array.from({ length: 101 }, (_, i) => term(i));
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    const { text } = mockDispatch.mock.calls[0][1];
    expect(text).toContain('"term": "synthetic term 99"');
    expect(text).not.toContain('"term": "synthetic term 100"');
    expect(text).toMatch(/TRUNCATED: only the 100 highest-spend terms/);
  });

  test('no fresh sync at all: the prompt says search terms are UNAVAILABLE, not zero (Codex r7)', async () => {
    mockSearchTerms = [];
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    const { text } = mockDispatch.mock.calls[0][1];
    expect(text).toMatch(/UNAVAILABLE: no search-term sync in the last 48 hours/);
  });

  test('a recent successful sync with zero terms is a valid empty snapshot, not UNAVAILABLE (Codex r9)', async () => {
    mockSearchTerms = [];
    mockFirstRows = { system_settings: { key: 'ads.search_terms.last_synced_at', value: new Date(Date.now() - 3600 * 1000).toISOString() } };
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    expect(mockDispatch.mock.calls[0][1].text).not.toMatch(/UNAVAILABLE: no search-term/);
    expect(mockWhereCalls.some((c) => c.table === 'system_settings' && c.args[0].key === 'ads.search_terms.last_synced_at')).toBe(true);
  });

  test('a sync record older than 48 hours still reads as UNAVAILABLE', async () => {
    mockSearchTerms = [];
    mockFirstRows = { system_settings: { key: 'ads.search_terms.last_synced_at', value: new Date(Date.now() - 72 * 3600 * 1000).toISOString() } };
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    expect(mockDispatch.mock.calls[0][1].text).toMatch(/UNAVAILABLE: no search-term/);
  });

  test('fresh rows present: no UNAVAILABLE note', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    expect(mockDispatch.mock.calls[0][1].text).not.toMatch(/UNAVAILABLE: no search-term/);
  });

  test('100 or fewer: no truncation note', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: { ...EMPTY_REPORT }, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    expect(mockDispatch.mock.calls[0][1].text).not.toMatch(/TRUNCATED: only/);
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

  test('empty recommendations with other flagged items are texted as flagged, never as "no changes" (Codex r2 on #5486)', async () => {
    const report = {
      ...EMPTY_REPORT,
      waste_alerts: [{ search_term: 'synthetic wasted term', spend: 12, conversions: 0, action: 'add_negative' }, { search_term: 'second term', spend: 9 }],
      capacity_warnings: [{ area: 'Synthetic Area', utilization: 95, recommendation: 'slow spend' }],
    };
    mockDispatch.mockResolvedValue({ ok: true, json: report, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    expect(mockSendSMS).toHaveBeenCalledTimes(1);
    const body = mockSendSMS.mock.calls[0][1];
    expect(body).not.toContain('No changes recommended today.');
    expect(body).toContain('No campaign changes recommended, but flagged:');
    expect(body).toContain('• Waste alerts: 2 (e.g. synthetic wasted term)');
    expect(body).toContain('• Capacity warnings: 1 (e.g. Synthetic Area)');
    expect(body).not.toContain('Scaling opportunities');
    expect(body).not.toContain('Top actions');
  });

  test('recommendations still lead the text when present', async () => {
    const report = {
      ...EMPTY_REPORT,
      recommendations: [{ priority: 'high', action: 'Raise budget', reasoning: '7.0x ROAS on $40 spend' }],
      waste_alerts: [{ search_term: 'synthetic wasted term', spend: 12 }],
    };
    mockDispatch.mockResolvedValue({ ok: true, json: report, provider: 'anthropic', model: 'm' });
    await advisor.generateDailyAdvice();
    const body = mockSendSMS.mock.calls[0][1];
    expect(body).toContain('Top actions:\n• Raise budget');
    expect(body).not.toContain('flagged');
  });

  test('isUsableAdsReport / normalize accept an empty list; an omitted list is rejected', () => {
    expect(advisor.isUsableAdsReport({ ...EMPTY_REPORT })).toBe(true);
    const { recommendations: _omitted, ...noList } = EMPTY_REPORT;
    expect(advisor.isUsableAdsReport(noList)).toBe(false);
    expect(advisor.normalizeAdsReport({ ...EMPTY_REPORT }).recommendations).toEqual([]);
  });

  test('the fallback stores as an ungraded, empty report (never mistaken for an AI answer)', () => {
    const fb = advisor.generateFallbackAdvice([]);
    expect(fb.recommendations).toEqual([]);
    expect(fb.grade).toBe('N/A');
    // Not an AI-shaped answer: it never passes the leg validator.
    expect(advisor.isUsableAdsReport(fb)).toBe(false);
  });
});

describe('no Apply on campaigns changed in the last 7 days (Codex r9 on #5486)', () => {
  test('a budget rec for a recently changed campaign is stored advisory-only', async () => {
    mockBudgetLog = [{ ...mockBudgetRow(1), campaign_id: CAMPAIGN.id, campaign_name: CAMPAIGN.campaign_name }];
    mockDispatch.mockResolvedValue({ ok: true, provider: 'anthropic', model: 'm', json: {
      ...EMPTY_REPORT,
      recommendations: [{
        priority: 'high', action: 'Raise the daily budget', campaign: 'Synthetic Search', campaign_id: CAMPAIGN.id,
        reasoning: 'Lost 40% impression share to budget at $5/day.', estimated_impact: '+2 clicks/day',
        apply_action: 'increase_budget', apply_value: 8,
      }],
    } });
    const advice = await advisor.generateDailyAdvice();
    const rec = advice.recommendations[0];
    expect(rec.apply_action).toBeUndefined();
    expect(rec.manual_action).toBe('increase_budget');
    expect(rec.action).toBe('Raise the daily budget');
  });

  test('the same rec on an unchanged campaign keeps its Apply action', () => {
    const out = advisor.normalizeRecommendations({ recommendations: [{
      campaign: 'Synthetic Search', apply_action: 'increase_budget', apply_value: 8,
    }] }, [CAMPAIGN], new Set(['some-other-campaign']));
    expect(out.recommendations[0].apply_action).toBe('increase_budget');
  });
});
