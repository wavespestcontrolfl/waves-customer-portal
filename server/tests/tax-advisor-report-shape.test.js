// The weekly tax report's shape rule: valid JSON without an executive summary
// takes the parse-failure path (fallback report + a failed ledger row) instead
// of being stored as a blank report (Codex r5 on #4884).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({}));

const { isUsableTaxReport, normalizeTaxAlerts, taxDate } = require('../services/tax-advisor');

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

// Codex r15 on #4884: {"savings_opportunities":[{}]} passed the object-only
// check, and storeReport's single multi-row alerts insert then failed on the
// NOT NULL title for EVERY alert (swallowed by its catch). Items are now
// cleaned field by field; one without its label is dropped; anything
// off-contract marks the answer degraded (the caller fails the row).
describe('normalizeTaxAlerts', () => {
  test('a clean report is left as-is and not degraded', () => {
    const report = {
      executive_summary: 'ok',
      savings_opportunities: [{ title: 'Section 179 on the new truck', estimated_annual_savings: 4200, priority: 'high', action: 'Elect 179', deadline: '2026-12-31' }],
      compliance_alerts: [{ alert: 'Q4 1040-ES due', severity: 'high', deadline: 'January 15, 2027', action: 'Pay' }],
      deduction_gaps: [{ deduction: 'Home office', estimated_value: '600', how_to_claim: 'Form 8829' }],
    };
    expect(normalizeTaxAlerts(report)).toBe(false);
    expect(report.savings_opportunities).toHaveLength(1);
    expect(report.deduction_gaps[0].estimated_value).toBe(600);
  });

  test('the r13 case: an item without its label is dropped and the answer is degraded', () => {
    const report = { executive_summary: 'ok', savings_opportunities: [{}, { title: 'Keep me' }] };
    expect(normalizeTaxAlerts(report)).toBe(true);
    expect(report.savings_opportunities.map((s) => s.title)).toEqual(['Keep me']);
  });

  test('off-contract fields are cleaned for the typed columns and degrade the answer', () => {
    const report = {
      executive_summary: 'ok',
      savings_opportunities: [{ title: 'A', priority: 'high/medium/low', estimated_annual_savings: '$5,000', action: { steps: 1 } }],
      compliance_alerts: [{ alert: 'B', severity: 'CRITICAL' }],
    };
    expect(normalizeTaxAlerts(report)).toBe(true);
    expect(report.savings_opportunities[0]).toMatchObject({ priority: 'medium', estimated_annual_savings: null, action: null });
    expect(report.compliance_alerts[0].severity).toBe('medium');
  });

  test('canonical-case priorities are not degraded; absent ones default to medium', () => {
    const report = { executive_summary: 'ok', savings_opportunities: [{ title: 'A', priority: ' High ' }, { title: 'B' }] };
    expect(normalizeTaxAlerts(report)).toBe(false);
    expect(report.savings_opportunities.map((s) => s.priority)).toEqual(['high', 'medium']);
  });
});

describe('taxDate (date column value)', () => {
  test.each([
    ['2026-12-31', '2026-12-31'],
    ['2027-01-15T00:00:00Z', '2027-01-15'],
    ['January 15, 2027', '2027-01-15'],
    ['Jan 15 2027', '2027-01-15'],
    ['before Q4', null],
    ['2026-02-30', null],
    ['if time-sensitive', null],
    ['', null],
  ])('%j → %j', (input, out) => {
    expect(taxDate(input)).toBe(out);
  });
});
