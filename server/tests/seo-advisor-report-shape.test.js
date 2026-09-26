// Codex r10-class gap on #4884: storeReport writes `grade: report.grade`
// with NO fallback — an undefined value there is an undefined DB binding
// (Knex throws; storeReport's own try/catch swallows it and the weekly
// report is silently never persisted), while the old validate only checked
// "object, not array" (a reply like `{}` passed it). isUsableSeoReport
// checks every field storeReport / sendSummary actually read. Same shape as
// tax-advisor.js's isUsableTaxReport test.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({}));

const { isUsableSeoReport } = require('../services/seo/seo-advisor');

const GOOD = { grade: 'B', overall_assessment: 'Steady non-brand growth this week.' };

describe('isUsableSeoReport', () => {
  test('accepts a minimal usable report', () => {
    expect(isUsableSeoReport(GOOD)).toBe(true);
  });

  test('rejects the wrong top-level shapes', () => {
    for (const bad of [null, undefined, [], 'text', 42, {}]) {
      expect(isUsableSeoReport(bad)).toBe(false);
    }
  });

  test('the exact regression: {} (no grade, no summary) is rejected', () => {
    expect(isUsableSeoReport({})).toBe(false);
  });

  test('rejects a missing or blank grade (the undefined DB binding storeReport would throw on); a stored-as-is grade like B+ is fine', () => {
    expect(isUsableSeoReport({ ...GOOD, grade: undefined })).toBe(false);
    expect(isUsableSeoReport({ ...GOOD, grade: '  ' })).toBe(false);
    expect(isUsableSeoReport({ ...GOOD, grade: 7 })).toBe(false);
    expect(isUsableSeoReport({ ...GOOD, grade: 'B+' })).toBe(true);
  });

  test('rejects a missing, empty, or non-string overall_assessment', () => {
    expect(isUsableSeoReport({ ...GOOD, overall_assessment: undefined })).toBe(false);
    expect(isUsableSeoReport({ ...GOOD, overall_assessment: '   ' })).toBe(false);
    expect(isUsableSeoReport({ ...GOOD, overall_assessment: 7 })).toBe(false);
  });

  test('rejects collection fields storeReport/sendSummary cannot iterate', () => {
    expect(isUsableSeoReport({ ...GOOD, recommendations: {} })).toBe(false);
    expect(isUsableSeoReport({ ...GOOD, page2_opportunities: 'none' })).toBe(false);
    expect(isUsableSeoReport({ ...GOOD, declining_alerts: [null] })).toBe(false);
    expect(isUsableSeoReport({ ...GOOD, wins: 'win1' })).toBe(false);
  });

  test('accepts well-shaped list fields, including string-array wins', () => {
    expect(isUsableSeoReport({
      ...GOOD,
      wins: ['ranked #1 for pest control bradenton'],
      recommendations: [{ priority: 'high', action: 'add FAQ content' }],
      page2_opportunities: [],
    })).toBe(true);
  });
});

// Codex r14 on #4884 (parallel to campaign-advisor): a {} recommendation was
// stored, counted, and texted as "• undefined"; the advisor tab renders
// action/reasoning as React children.
describe('recommendations must be usable', () => {
  test.each([
    ['an empty object', {}],
    ['a blank action', { action: '' }],
    ['an object reasoning', { action: 'add FAQ content', reasoning: { why: 'x' } }],
  ])('%s fails the report', (_label, rec) => {
    expect(isUsableSeoReport({ ...GOOD, recommendations: [rec] })).toBe(false);
  });

  test('a rec with an action and text fields is usable', () => {
    expect(isUsableSeoReport({ ...GOOD, recommendations: [{ priority: 'high', category: 'content', action: 'add FAQ content', page_or_query: '/termite', reasoning: 'page 2', estimated_impact: '+40 clicks' }] })).toBe(true);
  });
});
