/**
 * CPA package README (GATE_PNL_PAY_RUN_WAGES with GATE_TAX_PACKAGE_W2_LABOR): the
 * sentence about the P&L not reading pay runs is replaced when the P&L reads them.
 */
const { generateReadme } = require('../services/csv-generators');

const NOT_READING = 'The P&L does not read pay runs yet';
const READING = 'The P&L and pnl.csv count these wages and';

describe('generateReadme with pay-run wages', () => {
  test('W-2 labor on, pay-run wages off: the old compare-them sentence', () => {
    const text = generateReadme(2026, null, { w2Labor: true });
    expect(text).toContain(NOT_READING);
    expect(text).not.toContain(READING);
    expect(generateReadme(2026, null, { w2Labor: true, payRunWages: false })).toBe(text);
  });

  test('W-2 labor on, pay-run wages on: the same-pay-runs sentence', () => {
    const text = generateReadme(2026, null, { w2Labor: true, payRunWages: true });
    expect(text).not.toContain(NOT_READING);
    expect(text).toContain(READING);
    expect(text).toContain('"Payroll');
    expect(text).toContain('(counted from pay runs)" category, which the P&L');
    expect(text).toContain('leaves out, so nothing counts twice.');
    expect(text).toContain('expenses.csv still lists them.');
    expect(text).toContain('  8. pnl.csv              — Profit & Loss statement');
  });

  test('W-2 labor off: pay-run wages change nothing (today\'s README)', () => {
    const base = generateReadme(2026, null);
    expect(generateReadme(2026, null, { payRunWages: true })).toBe(base);
    expect(base).not.toContain('w2-payroll');
  });
});
