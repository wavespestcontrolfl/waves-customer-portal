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

  // A seasonal roll (rolledSeasonalFirstDate) can land a companion unit on
  // a DIFFERENT date than the anchor at the exact moment of creation — it
  // was never part of this trip's combined charge, so it must be excluded
  // even though it shares combined pricing.
  test('a combined-pricing unit that lands on a DIFFERENT date (e.g. a seasonal roll) → excluded', () => {
    expect(isAutoScheduledCombinedInvoiceSibling({
      sharesCombinedInvoicePricing: true,
      unitFirstDate: '2027-02-01',
      anchorScheduledDate: '2026-10-01',
    })).toBe(false);
  });

  // No anchor date yet means this IS the first unit inserted — the caller
  // never reaches this branch for the anchor itself (it takes the
  // firstScheduledServiceId branch instead), but the pure function still
  // fails closed rather than throwing or matching a null against a null.
  test('no anchor date known yet → excluded (fails closed, never matches null-against-null)', () => {
    expect(isAutoScheduledCombinedInvoiceSibling({
      sharesCombinedInvoicePricing: true,
      unitFirstDate: null,
      anchorScheduledDate: null,
    })).toBe(false);
  });

  test('a third same-day combined-pricing unit also qualifies (3+ program accept)', () => {
    expect(isAutoScheduledCombinedInvoiceSibling({
      sharesCombinedInvoicePricing: true,
      unitFirstDate: '2026-11-15',
      anchorScheduledDate: '2026-11-15',
    })).toBe(true);
  });
});
