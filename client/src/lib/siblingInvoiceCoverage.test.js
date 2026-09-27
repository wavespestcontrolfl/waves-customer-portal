import { describe, expect, it } from 'vitest';
import { isSiblingInvoiceCollectible, isSiblingInvoiceSettled, siblingInvoiceCoverageCopy } from './siblingInvoiceCoverage';

// Codex round-7 P1: a covered_sibling_invoice prediction whose sibling
// invoice is still draft/sent/overdue (collectible) used to render the same
// "no charge needed" copy as a genuinely paid/prepaid one, so a technician
// could leave without collecting the combined trip invoice that remained
// due. These pin the settled/collectible split and the copy it drives.
describe('isSiblingInvoiceCollectible / isSiblingInvoiceSettled', () => {
  it('reads draft/scheduled/sent/viewed/overdue/sending as collectible, never settled', () => {
    for (const status of ['draft', 'scheduled', 'sent', 'viewed', 'overdue', 'sending', 'SENT']) {
      expect(isSiblingInvoiceCollectible(status)).toBe(true);
      expect(isSiblingInvoiceSettled(status)).toBe(false);
    }
  });

  it('reads paid/prepaid/processing as settled, never collectible', () => {
    for (const status of ['paid', 'prepaid', 'processing', 'PAID']) {
      expect(isSiblingInvoiceCollectible(status)).toBe(false);
      expect(isSiblingInvoiceSettled(status)).toBe(true);
    }
  });

  it('fails toward "not collectible" for a missing/unrecognized status (never invents an action item)', () => {
    expect(isSiblingInvoiceCollectible(null)).toBe(false);
    expect(isSiblingInvoiceCollectible(undefined)).toBe(false);
    expect(isSiblingInvoiceCollectible('void')).toBe(false);
    expect(isSiblingInvoiceSettled(null)).toBe(false);
  });
});

describe('siblingInvoiceCoverageCopy', () => {
  it('returns null for any other prediction kind, or no prediction', () => {
    expect(siblingInvoiceCoverageCopy(null)).toBeNull();
    expect(siblingInvoiceCoverageCopy({ kind: 'invoice', amount: 100 })).toBeNull();
    expect(siblingInvoiceCoverageCopy({ kind: 'sibling_needs_review' })).toBeNull();
  });

  it('a settled sibling invoice (paid) reads as covered, nothing to collect, no amount surfaced', () => {
    const copy = siblingInvoiceCoverageCopy({
      kind: 'covered_sibling_invoice',
      invoiceId: 'inv-1',
      invoiceNumber: 'WPC-TEST-0001',
      invoiceStatus: 'paid',
      amountDue: 153.6,
      siblingServiceType: 'Quarterly Pest Control',
    });
    expect(copy.collectible).toBe(false);
    expect(copy.amountDue).toBeNull();
    expect(copy.detail).toBe(
      'Covered by invoice WPC-TEST-0001 on the Quarterly Pest Control visit (same trip) — nothing to collect.',
    );
    expect(copy.short).toBe('Covered — nothing to collect');
    expect(copy.invoiceHref).toBe('/admin/invoices/inv-1');
  });

  it('a collectible sibling invoice (sent) says to collect on that invoice, with the amount due and a link', () => {
    const copy = siblingInvoiceCoverageCopy({
      kind: 'covered_sibling_invoice',
      invoiceId: 'inv-1',
      invoiceNumber: 'WPC-TEST-0001',
      invoiceStatus: 'sent',
      amountDue: 153.6,
      siblingServiceType: 'Quarterly Pest Control',
    });
    expect(copy.collectible).toBe(true);
    expect(copy.amountDue).toBe(153.6);
    expect(copy.detail).toBe(
      'Covered by the combined trip invoice — invoice WPC-TEST-0001 ($153.60 due) on the Quarterly Pest Control visit is still due. Collect on that invoice, not this visit.',
    );
    expect(copy.short).toBe('Collect on invoice WPC-TEST-0001 ($153.60 due)');
    expect(copy.invoiceHref).toBe('/admin/invoices/inv-1');
  });

  it('draft/overdue also read as collectible, not just sent', () => {
    for (const invoiceStatus of ['draft', 'overdue', 'viewed', 'scheduled', 'sending']) {
      const copy = siblingInvoiceCoverageCopy({ kind: 'covered_sibling_invoice', invoiceStatus, amountDue: 40 });
      expect(copy.collectible).toBe(true);
    }
  });

  it('a missing invoiceStatus fails toward settled copy, never a false collect prompt', () => {
    const copy = siblingInvoiceCoverageCopy({ kind: 'covered_sibling_invoice', invoiceNumber: 'WPC-TEST-0001' });
    expect(copy.collectible).toBe(false);
    expect(copy.short).toBe('Covered — nothing to collect');
  });

  it('omits the amount-due parenthetical when amountDue is missing/zero, even when collectible', () => {
    const copy = siblingInvoiceCoverageCopy({ kind: 'covered_sibling_invoice', invoiceStatus: 'sent', amountDue: 0 });
    expect(copy.collectible).toBe(true);
    expect(copy.amountDue).toBeNull();
    expect(copy.short).toBe('Collect on the combined trip invoice');
  });

  it('falls back to a generic invoice reference and drops the sibling suffix when either is absent', () => {
    const copy = siblingInvoiceCoverageCopy({ kind: 'covered_sibling_invoice', invoiceStatus: 'paid' });
    expect(copy.detail).toBe('Covered by the combined trip invoice (same trip) — nothing to collect.');
  });

  it('omits invoiceHref when the prediction carries no invoiceId', () => {
    const copy = siblingInvoiceCoverageCopy({ kind: 'covered_sibling_invoice', invoiceStatus: 'sent', invoiceNumber: 'WPC-TEST-0001' });
    expect(copy.invoiceHref).toBeNull();
  });
});
