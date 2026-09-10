/**
 * prepaidCoversVisit — the payer-aware, method-specific prepaid-coverage
 * rule the completion applies before deciding a visit needs no invoice
 * (complete-scheduled-service.js `prepaidCovered`), mirrored for the office
 * invoice paths (GitHub P2 #4131 r3).
 */
jest.mock('../services/annual-prepay-renewals', () => ({
  ANNUAL_PREPAY_PREPAID_METHOD: 'annual_prepay_invoice',
  annualPrepayCoversVisit: jest.fn(async () => false),
}));

const { prepaidCoversVisit } = require('../services/visit-prepaid-coverage');
const { annualPrepayCoversVisit } = require('../services/annual-prepay-renewals');

describe('prepaidCoversVisit', () => {
  beforeEach(() => jest.clearAllMocks());

  test('null visit is never covered', async () => {
    expect(await prepaidCoversVisit(null)).toBe(false);
  });

  test('a payer-billed visit is never covered by the homeowner prepayment, however large', async () => {
    const visit = { prepaid_amount: 999999, prepaid_method: null };
    expect(await prepaidCoversVisit(visit, { payerBilled: true, invoiceAmount: 1 })).toBe(false);
    expect(annualPrepayCoversVisit).not.toHaveBeenCalled();
  });

  test('a payer-billed visit is never covered even when stamped for annual prepay', async () => {
    const visit = { prepaid_amount: null, prepaid_method: 'annual_prepay_invoice' };
    expect(await prepaidCoversVisit(visit, { payerBilled: true })).toBe(false);
    expect(annualPrepayCoversVisit).not.toHaveBeenCalled();
  });

  test('an annual-prepay-stamped visit defers entirely to annualPrepayCoversVisit, ignoring the amount', async () => {
    annualPrepayCoversVisit.mockResolvedValueOnce(true);
    const visit = { prepaid_amount: 1, prepaid_method: 'annual_prepay_invoice' };
    expect(await prepaidCoversVisit(visit, { invoiceAmount: 999 })).toBe(true);
    expect(annualPrepayCoversVisit).toHaveBeenCalledWith(visit, expect.anything());
  });

  test('a stale annual-prepay stamp (voided/refunded term) covers nothing, whatever the amount says', async () => {
    annualPrepayCoversVisit.mockResolvedValueOnce(false);
    const visit = { prepaid_amount: 999999, prepaid_method: 'annual_prepay_invoice' };
    expect(await prepaidCoversVisit(visit, { invoiceAmount: 1 })).toBe(false);
  });

  test('no recorded prepayment does not cover', async () => {
    expect(await prepaidCoversVisit({ prepaid_amount: null })).toBe(false);
    expect(await prepaidCoversVisit({ prepaid_amount: 0 })).toBe(false);
    expect(await prepaidCoversVisit({ prepaid_amount: -5 })).toBe(false);
  });

  test('an out-of-band method (cash/Zelle/phone card) covers only when the amount reaches the invoice', async () => {
    const visit = { prepaid_amount: 100, prepaid_method: 'cash' };
    expect(await prepaidCoversVisit(visit, { invoiceAmount: 100 })).toBe(true); // exact match covers
    expect(await prepaidCoversVisit(visit, { invoiceAmount: 100.01 })).toBe(false); // a cent short does not
    expect(await prepaidCoversVisit(visit, { invoiceAmount: 50 })).toBe(true); // more than enough covers
  });

  test('a partial prepayment does not cover — the visit still gets an invoice, as at completion', async () => {
    const visit = { prepaid_amount: 50, prepaid_method: 'cash' };
    expect(await prepaidCoversVisit(visit, { invoiceAmount: 117 })).toBe(false);
  });

  test('invoiceAmount null (unknown would-be amount, e.g. the picker with no estimated price) — any positive out-of-band prepayment covers, fail closed', async () => {
    const visit = { prepaid_amount: 0.01, prepaid_method: 'cash' };
    expect(await prepaidCoversVisit(visit, { invoiceAmount: null })).toBe(true);
  });
});
