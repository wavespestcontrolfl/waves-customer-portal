// The weekly tax report's shape rule: valid JSON without an executive summary
// takes the parse-failure path (fallback report + a failed ledger row) instead
// of being stored as a blank report (Codex r5 on #4884).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({}));

const { isUsableTaxReport } = require('../services/tax-advisor');

describe('isUsableTaxReport', () => {
  test('accepts a report with a non-empty executive summary', () => {
    expect(isUsableTaxReport({ executive_summary: 'Healthy quarter.', compliance_alerts: [] })).toBe(true);
  });

  test('rejects collection fields that storeReport / the SMS summary cannot iterate', () => {
    const base = { executive_summary: 'Healthy quarter.' };
    expect(isUsableTaxReport({ ...base, compliance_alerts: {} })).toBe(false);
    expect(isUsableTaxReport({ ...base, savings_opportunities: 'none' })).toBe(false);
    expect(isUsableTaxReport({ ...base, deduction_gaps: [null] })).toBe(false);
    expect(isUsableTaxReport({ ...base, action_items: ['call CPA'] })).toBe(false);
    expect(isUsableTaxReport({ ...base, financial_snapshot: [] })).toBe(false);
    expect(isUsableTaxReport({ ...base, compliance_alerts: [{ severity: 'high' }], financial_snapshot: { ytd_tax_collected: 0 } })).toBe(true);
  });

  test('rejects the wrong shapes that used to persist as blank reports', () => {
    for (const bad of [{}, [], null, 'text', 42, { executive_summary: '   ' }, { executive_summary: 7 }, { savings_opportunities: [] }]) {
      expect(isUsableTaxReport(bad)).toBe(false);
    }
  });
});
