/**
 * P1-B (Codex round 13 on PR #5021): a PLAIN auto-scheduled accept (no slot
 * reservation at all) that sells two-or-more recurring programs onto the
 * same first-visit date used to leave every promoted sibling beyond the
 * anchor invisible to the combined first-application invoice's stamp —
 * convertEstimate's own additive combinedInvoiceMemberIds field was only
 * ever populated by the reserved-slot promotion branch. isAutoScheduled-
 * CombinedInvoiceSibling is the pure decision extracted out of the
 * auto-schedule loop that now also populates it for that plain path.
 *
 * See first-application-sibling-split.postgres.test.js and
 * estimate-public-accept-atomicity.test.js for the DB/route-level coverage
 * of the stamp itself; this file is the pure-function unit coverage for
 * the membership decision alone.
 */
const { isAutoScheduledCombinedInvoiceSibling } = require('../services/estimate-converter');

describe('isAutoScheduledCombinedInvoiceSibling', () => {
  test('a same-day unpriced-because-combined sibling qualifies', () => {
    expect(isAutoScheduledCombinedInvoiceSibling({
      sharesCombinedInvoicePricing: true,
      unitFirstDate: '2026-10-01',
      anchorScheduledDate: '2026-10-01',
    })).toBe(true);
  });

  // A single-program accept (recurringUnitCount === 1) never sets
  // sharesCombinedInvoicePricing — nothing to combine with, so it must
  // never be swept in even if dates happen to line up.
  test('not a combined-pricing unit at all (single-program accept) → excluded', () => {
    expect(isAutoScheduledCombinedInvoiceSibling({
      sharesCombinedInvoicePricing: false,
      unitFirstDate: '2026-10-01',
      anchorScheduledDate: '2026-10-01',
    })).toBe(false);
  });

  // Codex r20 P1: a seasonal roll (rolledSeasonalFirstDate) can land a
  // companion unit on a DIFFERENT date than the anchor — but the combined
  // invoice's amount (sameDayVisitTotalForPricingFrequency) already sums
  // that unit's first application, so it IS covered and must be stamped;
  // otherwise its own-date completion mints the application again.
  test('a combined-pricing unit that lands on a DIFFERENT date (e.g. a seasonal roll) still qualifies — the invoice already bills it', () => {
    expect(isAutoScheduledCombinedInvoiceSibling({
      sharesCombinedInvoicePricing: true,
      unitFirstDate: '2027-02-01',
      anchorScheduledDate: '2026-10-01',
    })).toBe(true);
  });

  // Dates play no part in the decision at all (Codex r20 P1): the anchor
  // itself never reaches this branch (it takes the firstScheduledServiceId
  // branch first), so a missing anchor date is irrelevant to a later unit.
  test('the anchor date is irrelevant — a combined-pricing unit qualifies with no anchor date known', () => {
    expect(isAutoScheduledCombinedInvoiceSibling({
      sharesCombinedInvoicePricing: true,
      unitFirstDate: null,
      anchorScheduledDate: null,
    })).toBe(true);
  });

  test('a third same-day combined-pricing unit also qualifies (3+ program accept)', () => {
    expect(isAutoScheduledCombinedInvoiceSibling({
      sharesCombinedInvoicePricing: true,
      unitFirstDate: '2026-11-15',
      anchorScheduledDate: '2026-11-15',
    })).toBe(true);
  });
});
