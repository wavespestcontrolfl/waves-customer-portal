import { describe, expect, it } from 'vitest';
import { siblingCoverageCopy } from './siblingInvoiceCoverage';

// Owner decision (narrow + fail closed): the server computes the ONE
// canonical per-visit collection verdict — `billingLane.siblingCoverage`
// (billing-lane.js siblingCoverageForSchedule) — and this module is pure
// copy formatting of it. It never classifies collect vs. settled vs.
// review itself any more (that used to live here, keyed off the sibling
// invoice's raw status — Codex round-7 P1's original fix — and drifted
// from the server's own payer/withdrawn/credit checks, round-8 P1).
describe('siblingCoverageCopy', () => {
  it('returns null for a missing verdict, or state "none"', () => {
    expect(siblingCoverageCopy(null)).toBeNull();
    expect(siblingCoverageCopy(undefined)).toBeNull();
    expect(siblingCoverageCopy({ state: 'none' })).toBeNull();
  });

  it('a settled verdict reads as covered, nothing to collect, no amount surfaced', () => {
    const copy = siblingCoverageCopy(
      { state: 'settled', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 0, reason: 'invoice_settled' },
      { siblingServiceType: 'Quarterly Pest Control' },
    );
    expect(copy.collectible).toBe(false);
    expect(copy.settled).toBe(true);
    expect(copy.needsReview).toBe(false);
    expect(copy.amountDue).toBeNull();
    expect(copy.detail).toBe(
      'Covered by invoice WPC-TEST-0001 on the Quarterly Pest Control visit (same trip) — nothing to collect.',
    );
    expect(copy.short).toBe('Covered — nothing to collect');
    expect(copy.invoiceHref).toBe('/admin/invoices/inv-1');
  });

  // Round-8 P1: a payer-owned or withdrawn-from-customer sibling invoice is
  // 'settled' from the server (nothing for a technician to collect from the
  // homeowner) even though the invoice itself is still draft/sent — this
  // module never re-derives that from the raw invoice status any more.
  it('a payer-billed or withdrawn sibling invoice (state settled, reason payer_billed/withdrawn) reads as covered, not collectible', () => {
    for (const reason of ['payer_billed', 'withdrawn_from_customer']) {
      const copy = siblingCoverageCopy({ state: 'settled', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 0, reason });
      expect(copy.collectible).toBe(false);
      expect(copy.settled).toBe(true);
    }
  });

  it('a collect_on_combined_invoice verdict says to collect on that invoice, with the amount due and a link', () => {
    const copy = siblingCoverageCopy(
      { state: 'collect_on_combined_invoice', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 153.6, reason: null },
      { siblingServiceType: 'Quarterly Pest Control' },
    );
    expect(copy.collectible).toBe(true);
    expect(copy.settled).toBe(false);
    expect(copy.needsReview).toBe(false);
    expect(copy.amountDue).toBe(153.6);
    expect(copy.detail).toBe(
      'Covered by the combined trip invoice — invoice WPC-TEST-0001 ($153.60 due) on the Quarterly Pest Control visit is still due. Collect on that invoice, not this visit.',
    );
    expect(copy.short).toBe('Collect on invoice WPC-TEST-0001 ($153.60 due)');
    expect(copy.invoiceHref).toBe('/admin/invoices/inv-1');
  });

  it('a review verdict reads as "needs a human look", never a $ amount or "no charge"', () => {
    const copy = siblingCoverageCopy({ state: 'review', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: null, reason: 'terminal_invoice' });
    expect(copy.collectible).toBe(false);
    expect(copy.settled).toBe(false);
    expect(copy.needsReview).toBe(true);
    expect(copy.amountDue).toBeNull();
    expect(copy.detail).toBe('This visit’s combined-trip invoice needs a human look — reconcile it from Customer 360.');
    expect(copy.short).toBe('Needs review — see Customer 360');
  });

  it('a review verdict with no invoice at all (lookup failure / canceled setup fee) still reads as review', () => {
    const copy = siblingCoverageCopy({ state: 'review', invoiceId: null, invoiceNumber: null, amountDue: null, reason: 'lookup_failed' });
    expect(copy.needsReview).toBe(true);
    expect(copy.invoiceHref).toBeNull();
  });

  it('omits the amount-due parenthetical when amountDue is missing/zero, even when collectible', () => {
    const copy = siblingCoverageCopy({ state: 'collect_on_combined_invoice', amountDue: 0 });
    expect(copy.collectible).toBe(true);
    expect(copy.amountDue).toBeNull();
    expect(copy.short).toBe('Collect on the combined trip invoice');
  });

  it('falls back to a generic invoice reference and drops the sibling suffix when either is absent', () => {
    const copy = siblingCoverageCopy({ state: 'settled', amountDue: 0 });
    expect(copy.detail).toBe('Covered by the combined trip invoice (same trip) — nothing to collect.');
  });

  it('omits invoiceHref when the verdict carries no invoiceId', () => {
    const copy = siblingCoverageCopy({ state: 'collect_on_combined_invoice', invoiceNumber: 'WPC-TEST-0001', amountDue: 40 });
    expect(copy.invoiceHref).toBeNull();
  });
});
