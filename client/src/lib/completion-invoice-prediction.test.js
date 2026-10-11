// completionInvoicePrediction decides whether the Complete Service form (and the Fast Complete
// Wrap-up) says a visit will invoice and whether an unpaid invoice holds the review ask. This pins
// its outputs: named cases, one per billing branch, and a golden set of 150 seeded random inputs
// recorded from the function before it was split into stages (completion-invoice-prediction.golden.json).
import { describe, expect, test } from 'vitest';
import { completionInvoicePrediction, isCallbackVisit } from './completion-invoice-prediction';
import golden from './completion-invoice-prediction.golden.json';

const predict = (service, extra = {}) => completionInvoicePrediction({ service, visitPrice: service.estimatedPrice, ...extra });
const NAMED = [
  ['a priced visit that bills', { estimatedPrice: 90, createInvoiceOnComplete: true }, {}, { willInvoice: true, reviewAwaitsPayment: true }],
  ['a priced visit with no billing signal', { estimatedPrice: 90 }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a WaveGuard tier alone bills a priced visit', { estimatedPrice: 90, waveguardTier: 'Gold' }, {}, { willInvoice: true, reviewAwaitsPayment: true }],
  ['a zero price with no prediction is nothing to invoice', { estimatedPrice: 0, createInvoiceOnComplete: true }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['an unpriced visit follows the billing lane amount', { createInvoiceOnComplete: true, billingLane: { prediction: { kind: 'invoice', amount: 50 } } }, {}, { willInvoice: true, reviewAwaitsPayment: true }],
  ['an unpriced prepaid lane is covered', { createInvoiceOnComplete: true, billingLane: { prediction: { kind: 'prepaid', amount: 55 } } }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['covered by membership dues is report-only', { estimatedPrice: 90, createInvoiceOnComplete: true, billingLane: { prediction: { kind: 'covered_membership', amount: 0 } } }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a priced visit fully covered by a prepayment is report-only', { estimatedPrice: 90, createInvoiceOnComplete: true, prepaidAmount: 100 }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a partial prepayment still invoices', { estimatedPrice: 90, createInvoiceOnComplete: true, prepaidAmount: 30 }, {}, { willInvoice: true, reviewAwaitsPayment: true }],
  ['an invoice already paid is report-only', { estimatedPrice: 90, createInvoiceOnComplete: true, invoiceStatus: 'paid' }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a checkout invoice marked prepaid is report-only', { estimatedPrice: 90, createInvoiceOnComplete: true, checkoutInvoiceStatus: 'prepaid' }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['an invoice already sent holds the review ask and is not re-minted', { estimatedPrice: 90, createInvoiceOnComplete: true, completionInvoiceAlreadySent: true }, {}, { willInvoice: false, reviewAwaitsPayment: true }],
  ['an invoice already sent and paid holds nothing', { estimatedPrice: 90, completionInvoiceAlreadySent: true, invoiceStatus: 'paid' }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a sibling invoice to collect bills its amount due', { billingLane: { siblingCoverage: { state: 'collect_on_combined_invoice', amountDue: 40 } } }, {}, { willInvoice: true, reviewAwaitsPayment: true }],
  ['a sibling invoice with nothing due does not bill', { billingLane: { siblingCoverage: { state: 'collect_on_combined_invoice', amountDue: 0 } } }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a sibling invoice literally settled holds nothing', { billingLane: { siblingCoverage: { state: 'settled', reason: 'invoice_settled' } } }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a sibling invoice settled any other way holds the review ask', { billingLane: { siblingCoverage: { state: 'settled', reason: 'invoice_processing' } } }, {}, { willInvoice: false, reviewAwaitsPayment: true }],
  ['a typed one-time profile bills a priced visit with no other signal', { estimatedPrice: 90, completionProfile: { billingType: 'One_Time' } }, {}, { willInvoice: true, reviewAwaitsPayment: true }],
  ['a typed one-time profile with an included follow-up does not', { estimatedPrice: 90, completionProfile: { billingType: 'one_time' }, followupIncluded: true }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a typed one-time inspection-only outcome does not', { estimatedPrice: 90, completionProfile: { billingType: 'one_time' } }, { visitOutcome: 'inspection_only' }, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a typed one-time declined outcome does not', { estimatedPrice: 90, completionProfile: { billingType: 'one_time' } }, { visitOutcome: 'customer_declined' }, { willInvoice: false, reviewAwaitsPayment: false }],
  ['a priced re-service still invoices when the row bills', { serviceType: 'Pest Re-service', estimatedPrice: 90, createInvoiceOnComplete: true }, {}, { willInvoice: true, reviewAwaitsPayment: true }],
  ['an unpriced re-service is free', { serviceType: 'Pest Re-service', createInvoiceOnComplete: true, billingLane: { prediction: { kind: 'invoice', amount: 50 } } }, {}, { willInvoice: false, reviewAwaitsPayment: false }],
  ['applying discounts counts as priced and uses the reviewed amount', { createInvoiceOnComplete: true }, { visitPrice: 70, applyingDiscounts: true }, { willInvoice: true, reviewAwaitsPayment: true }],
  ['a one-time recap invoices nothing', { estimatedPrice: 90, createInvoiceOnComplete: true }, { oneTimeRecapOnly: true }, { willInvoice: false, reviewAwaitsPayment: false }],
];

describe('completionInvoicePrediction, branch by branch', () => {
  test.each(NAMED)('%s', (_name, service, extra, expected) => {
    expect(predict(service, extra)).toEqual(expected);
  });

  test('an explicit isCallback overrides the service type', () => {
    const service = { serviceType: 'Lawn Care', createInvoiceOnComplete: true, billingLane: { prediction: { kind: 'invoice', amount: 50 } } };
    expect(predict(service).willInvoice).toBe(true);
    expect(predict(service, { isCallback: true }).willInvoice).toBe(false);
  });

  test('a callback is a re-service or callback type, or flagged', () => {
    expect(isCallbackVisit({ serviceType: 'Pest Re-service' })).toBe(true);
    expect(isCallbackVisit({ serviceType: 'Pest Callback' })).toBe(true);
    expect(isCallbackVisit({ serviceType: 'Pest', isCallback: true })).toBe(true);
    expect(isCallbackVisit({ serviceType: 'Pest' })).toBeFalsy();
  });
});

describe('completionInvoicePrediction, the golden set', () => {
  test('covers both verdicts', () => {
    const verdicts = new Set(golden.map(([, out]) => `${out.willInvoice}/${out.reviewAwaitsPayment}`));
    expect(verdicts).toEqual(new Set(['true/true', 'false/true', 'false/false']));
  });

  test.each(golden.map((entry, index) => [index, ...entry]))('case %i keeps its recorded verdict', (_index, input, expected) => {
    expect(completionInvoicePrediction(input)).toEqual(expected);
  });
});
