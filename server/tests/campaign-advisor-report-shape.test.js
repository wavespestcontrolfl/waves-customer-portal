// Codex r10-class gap on #4884: storeReport writes `grade: advice.grade`
// with NO fallback — an undefined value there is an undefined DB binding
// (Knex throws; storeReport's own try/catch swallows it and the daily
// report is silently never persisted), while the old validate only checked
// "object, not array" (a reply like `{}` passed it). isUsableAdsReport
// checks every field storeReport / sendSummary / normalizeRecommendations
// actually read. Same shape as seo-advisor.js's isUsableSeoReport test.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({}));

const { isUsableAdsReport, normalizeAdsReport } = require('../services/ads/campaign-advisor');

const GOOD = { grade: 'B', overall_assessment: 'ROAS steady, one campaign underspending.' };

describe('isUsableAdsReport', () => {
  test('accepts a minimal usable report', () => {
    expect(isUsableAdsReport(GOOD)).toBe(true);
  });

  test('rejects the wrong top-level shapes', () => {
    for (const bad of [null, undefined, [], 'text', 42, {}]) {
      expect(isUsableAdsReport(bad)).toBe(false);
    }
  });

  test('the exact regression: {} (no grade, no summary) is rejected', () => {
    expect(isUsableAdsReport({})).toBe(false);
  });

  test('rejects a missing or blank grade (the undefined DB binding storeReport would throw on); a stored-as-is grade like B+ is fine', () => {
    expect(isUsableAdsReport({ ...GOOD, grade: undefined })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, grade: '  ' })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, grade: 7 })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, grade: 'B+' })).toBe(true);
  });

  test('rejects a missing, empty, or non-string overall_assessment', () => {
    expect(isUsableAdsReport({ ...GOOD, overall_assessment: undefined })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, overall_assessment: '   ' })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, overall_assessment: 7 })).toBe(false);
  });

  test('rejects collection fields normalizeRecommendations/storeReport/sendSummary cannot iterate', () => {
    expect(isUsableAdsReport({ ...GOOD, recommendations: {} })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, waste_alerts: 'none' })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, scaling_opportunities: [null] })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, insights: 'insight1' })).toBe(false);
  });

  test('accepts well-shaped list fields, including string-array insights', () => {
    expect(isUsableAdsReport({
      ...GOOD,
      insights: ['CPA trending down'],
      recommendations: [{ priority: 'high', action: 'raise budget' }],
      waste_alerts: [],
    })).toBe(true);
  });
});

// Codex r14 on #4884: a {} recommendation was stored, counted as one, and
// texted as "• undefined"; the Ads page renders rec fields as React children.
describe('recommendations must be usable', () => {
  test.each([
    ['an empty object', {}],
    ['a blank action', { action: '   ' }],
    ['a non-string action', { action: 42 }],
    ['an object reasoning (would throw as a React child)', { action: 'raise budget', reasoning: { why: 'x' } }],
    ['an array campaign', { action: 'raise budget', campaign: ['Pest'] }],
  ])('%s fails the report', (_label, rec) => {
    expect(isUsableAdsReport({ ...GOOD, recommendations: [{ priority: 'high', action: 'ok' }, rec] })).toBe(false);
  });

  test('a rec with an action and text fields is usable', () => {
    expect(isUsableAdsReport({ ...GOOD, recommendations: [{ priority: 'High', action: 'raise budget', campaign: 'Pest', reasoning: 'headroom', estimated_impact: '+$40/wk' }] })).toBe(true);
  });
});

describe('normalizeAdsReport', () => {
  test('canonicalizes rec priority so every rec lands in a rendered group', () => {
    const out = normalizeAdsReport({ ...GOOD, recommendations: [{ priority: ' High ', action: 'a' }, { action: 'b' }, { priority: 'urgent', action: 'c' }] });
    expect(out.recommendations.map((r) => r.priority)).toEqual(['high', 'medium', 'medium']);
  });

  test('drops secondary-list items without their label or with a non-text rendered field', () => {
    const out = normalizeAdsReport({
      ...GOOD,
      waste_alerts: [{ search_term: '', spend: 0 }, { search_term: 'free pest control', spend: 12.5, conversions: 0, action: 'add_negative', extra: [1] }, { search_term: 'bugs', spend: { usd: 3 } }],
      scaling_opportunities: [{ campaign: 'Pest', current_budget: 20, suggested_budget: 30, headroom_reason: 'IS lost to budget' }, {}],
      capacity_warnings: [{ area: 'Venice', utilization: 95, recommendation: 'slow spend' }, { utilization: 90 }],
      insights: ['CPA is down', '', { text: 'x' }],
    });
    expect(out.waste_alerts.map((w) => w.search_term)).toEqual(['free pest control']);
    expect(out.scaling_opportunities).toHaveLength(1);
    expect(out.capacity_warnings).toHaveLength(1);
    expect(out.insights).toEqual(['CPA is down']);
  });
});
