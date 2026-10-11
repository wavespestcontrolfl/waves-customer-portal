import { describe, expect, test } from 'vitest';
import { completionBillingFacts } from './completion-billing-facts';
import { completionInvoicePrediction } from './completion-invoice-prediction';

describe('completionBillingFacts', () => {
  // A row whose invoice already went out must not read as "will invoice" on a sheet (no pay-link row in the Wrap-up).
  test('carries the already-sent invoice marker to the invoice prediction', () => {
    const row = { estimatedPrice: 120, createInvoiceOnComplete: true, completionInvoiceAlreadySent: true };
    const service = completionBillingFacts(row);
    expect(service.completionInvoiceAlreadySent).toBe(true);
    const sent = completionInvoicePrediction({ service, visitPrice: service.estimatedPrice }).willInvoice;
    const notSent = completionInvoicePrediction({ service: completionBillingFacts({ ...row, completionInvoiceAlreadySent: false }), visitPrice: 120 }).willInvoice;
    expect([sent, notSent]).toEqual([false, true]);
  });
});
