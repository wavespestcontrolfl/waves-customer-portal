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

const { prepaidRefusesOfficeInvoice } = require('../services/visit-prepaid-coverage');
const { annualPrepayCoversVisit } = require('../services/annual-prepay-renewals');

describe('prepaidRefusesOfficeInvoice', () => {
  beforeEach(() => jest.clearAllMocks());

  test('null visit is never covered', async () => {
    expect(await prepaidRefusesOfficeInvoice(null)).toBe(false);
  });

  test('a payer-billed visit is never covered by the homeowner prepayment, however large', async () => {
    const visit = { prepaid_amount: 999999, prepaid_method: null };
    expect(await prepaidRefusesOfficeInvoice(visit, { payerBilled: true, invoiceAmount: 1 })).toBe(false);
    expect(annualPrepayCoversVisit).not.toHaveBeenCalled();
  });

  test('a payer-billed visit is never covered even when stamped for annual prepay', async () => {
    const visit = { prepaid_amount: null, prepaid_method: 'annual_prepay_invoice' };
    expect(await prepaidRefusesOfficeInvoice(visit, { payerBilled: true })).toBe(false);
    expect(annualPrepayCoversVisit).not.toHaveBeenCalled();
  });

  test('an annual-prepay-stamped visit defers entirely to annualPrepayCoversVisit, ignoring the amount', async () => {
    annualPrepayCoversVisit.mockResolvedValueOnce(true);
    const visit = { prepaid_amount: 1, prepaid_method: 'annual_prepay_invoice' };
    expect(await prepaidRefusesOfficeInvoice(visit)).toBe(true);
    expect(annualPrepayCoversVisit).toHaveBeenCalledWith(visit, expect.anything(), { throwOnError: true });
  });

  test('a stale annual-prepay stamp (voided/refunded term) covers nothing, whatever the amount says', async () => {
    annualPrepayCoversVisit.mockResolvedValueOnce(false);
    const visit = { prepaid_amount: 999999, prepaid_method: 'annual_prepay_invoice' };
    expect(await prepaidRefusesOfficeInvoice(visit)).toBe(false);
  });

  test('an annual-prepay stamp is verified STRICTLY — throwOnError — and an unverifiable stamp propagates as an error, never as "not covered" (pre-push P0 r3)', async () => {
    const visit = { prepaid_amount: 117, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: null };
    annualPrepayCoversVisit.mockRejectedValueOnce(new Error('stamped visit carries no annual_prepay_term_id — coverage unverifiable'));
    await expect(prepaidRefusesOfficeInvoice(visit)).rejects.toThrow(/unverifiable/);
    expect(annualPrepayCoversVisit).toHaveBeenCalledWith(visit, expect.anything(), { throwOnError: true });
  });

  test('no recorded prepayment does not cover', async () => {
    expect(await prepaidRefusesOfficeInvoice({ prepaid_amount: null })).toBe(false);
    expect(await prepaidRefusesOfficeInvoice({ prepaid_amount: 0 })).toBe(false);
    expect(await prepaidRefusesOfficeInvoice({ prepaid_amount: -5 })).toBe(false);
  });

  test('an out-of-band method (cash/Zelle/phone card) refuses on ANY positive amount — the office path cannot credit a partial prepayment (pre-push P0 r3)', async () => {
    expect(await prepaidRefusesOfficeInvoice({ prepaid_amount: 100, prepaid_method: 'cash' })).toBe(true);
    expect(await prepaidRefusesOfficeInvoice({ prepaid_amount: 50, prepaid_method: 'zelle' })).toBe(true); // partial
    expect(await prepaidRefusesOfficeInvoice({ prepaid_amount: 0.01, prepaid_method: 'cash' })).toBe(true);
    expect(await prepaidRefusesOfficeInvoice({ prepaid_amount: '117.00', prepaid_method: null })).toBe(true);
  });
});
