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

const { isUsableAdsReport } = require('../services/ads/campaign-advisor');

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

  test('rejects a missing or non-enum grade — this is the undefined DB binding storeReport would throw on', () => {
    expect(isUsableAdsReport({ ...GOOD, grade: undefined })).toBe(false);
    expect(isUsableAdsReport({ ...GOOD, grade: 'B+' })).toBe(false);
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
