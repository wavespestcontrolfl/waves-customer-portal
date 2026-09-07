const { summarizeLedgerRows, ledgerRowCoverage } = require('../services/nutrient-ledger');

test('annual totals weight a ledger row by the share of the lawn it treated', () => {
  const rows = [
    { n_applied_per_1000: 1, lawn_sqft: 1000 },
    { n_applied_per_1000: 1, lawn_sqft: 1000 },
  ];
  // Two 1 lb N/1k applications on separate 1,000 sq ft zones of a 2,000 sq ft lawn = 1 lb N/1k for the year.
  expect(summarizeLedgerRows(rows, 2026, { lawnSqft: 2000 }).nApplied).toBe(1);
  // The same two rows on a lawn no bigger than each zone are two whole-lawn applications.
  expect(summarizeLedgerRows(rows, 2026, { lawnSqft: 1000 }).nApplied).toBe(2);
  // No lawn area to compare against, or no recorded row area: legacy whole-lawn weight.
  expect(summarizeLedgerRows(rows, 2026).nApplied).toBe(2);
  expect(summarizeLedgerRows([{ n_applied_per_1000: 1 }, { n_applied_per_1000: 1, lawn_sqft: null }], 2026, { lawnSqft: 2000 }).nApplied).toBe(2);
  expect(ledgerRowCoverage({ lawn_sqft: 3000 }, 2000)).toBe(1);
  expect(ledgerRowCoverage({ lawn_sqft: 500 }, 2000)).toBe(0.25);
});
