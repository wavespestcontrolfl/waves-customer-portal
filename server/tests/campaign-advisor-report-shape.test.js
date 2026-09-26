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
    expect(isUsableAdsReport({ ...GOOD, recommendations: [{ priority: 'high', action: 'ok' }, { priority: 'high', ...rec }] })).toBe(false);
  });

  test('a rec with an action and text fields is usable', () => {
    expect(isUsableAdsReport({ ...GOOD, recommendations: [{ priority: 'High', action: 'raise budget', campaign: 'Pest', reasoning: 'headroom', estimated_impact: '+$40/wk' }] })).toBe(true);
  });
});

// An off-contract member fails the leg (the next provider gets a turn)
// instead of being rewritten or trimmed after the leg was accepted.
describe('rendered items must be usable as given', () => {
  const rec = { priority: 'high', action: 'raise budget' };
  test.each([
    ['a rec without a priority', { recommendations: [{ action: 'a' }] }],
    ['a rec with an off-enum priority (would never be shown)', { recommendations: [{ priority: 'urgent', action: 'a' }] }],
    ['a waste alert without its search term (a copied template)', { recommendations: [rec], waste_alerts: [{ search_term: '', spend: 0 }] }],
    ['a waste alert with an object spend', { recommendations: [rec], waste_alerts: [{ search_term: 'bugs', spend: { usd: 3 } }] }],
    ['a scaling opportunity without its campaign', { scaling_opportunities: [{ current_budget: 20 }] }],
    ['a capacity warning without its area', { capacity_warnings: [{ utilization: 90 }] }],
    ['a non-text insight', { insights: ['CPA is down', { text: 'x' }] }],
    ['a blank insight', { insights: [''] }],
  ])('%s fails the report', (_label, extra) => {
    expect(isUsableAdsReport({ ...GOOD, ...extra })).toBe(false);
  });

  test('a full report with every list well formed is usable; an extra non-rendered field is fine', () => {
    expect(isUsableAdsReport({
      ...GOOD,
      recommendations: [{ priority: 'High', action: 'raise budget', campaign: 'Pest' }],
      waste_alerts: [{ search_term: 'free pest control', spend: 12.5, conversions: 0, action: 'add_negative', extra: [1] }],
      scaling_opportunities: [{ campaign: 'Pest', current_budget: 20, suggested_budget: 30, headroom_reason: 'IS lost to budget' }],
      capacity_warnings: [{ area: 'Venice', utilization: 95, recommendation: 'slow spend' }],
      insights: ['CPA is down'],
    })).toBe(true);
  });

  test('normalizeAdsReport only lower-cases an accepted priority so the page groups it', () => {
    const out = normalizeAdsReport({ ...GOOD, recommendations: [{ priority: ' High ', action: 'a' }, { priority: 'low', action: 'b' }] });
    expect(out.recommendations.map((r) => r.priority)).toEqual(['high', 'low']);
  });
});

// Codex r20 on #4884: the manual-action hint calls .replace() on
// apply_action / manual_action, so a non-string one crashed the Ads page.
describe('recommendation apply fields', () => {
  const rec = { priority: 'high', action: 'raise budget' };
  test.each([
    ['a numeric apply_action', { apply_action: 5 }],
    ['an object apply_action', { apply_action: { kind: 'increase_budget' } }],
    ['an object apply_value', { apply_action: 'increase_budget', apply_value: { usd: 30 } }],
  ])('%s fails the report', (_label, extra) => {
    expect(isUsableAdsReport({ ...GOOD, recommendations: [{ ...rec, ...extra }] })).toBe(false);
  });
  test('string apply fields are usable', () => {
    expect(isUsableAdsReport({ ...GOOD, recommendations: [{ ...rec, apply_action: 'increase_budget', apply_value: 30, campaign_id: '123' }] })).toBe(true);
  });
});

// Codex r21 on #4884: the documented A/B/C/D/F (a +/- kept); the pages colour
// a grade by its first letter.
test.each([['Excellent'], ['G'], ['AA'], [7]])('grade %p fails the report', (grade) => {
  expect(isUsableAdsReport({ ...GOOD, grade })).toBe(false);
});
test.each([[' a '], ['B+'], ['C-'], ['F']])('grade %p is usable', (grade) => {
  expect(isUsableAdsReport({ ...GOOD, grade })).toBe(true);
});
