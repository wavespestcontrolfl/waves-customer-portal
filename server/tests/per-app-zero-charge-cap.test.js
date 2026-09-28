// Owner ruling 2026-09-28: a per-application visit stamped $0 is free. A
// reused invoice on it (e.g. one minted before a re-price to $0) must never
// be auto-charged up to the per_application_fee — its cap is $0 plus any
// independently authorized setup-fee allowance.
const { resolveCompletionChargeCap } = require('../services/completion-charge-verdict');
const { attachedInvoiceAutoChargeLikely } = require('../services/billing-lane');

const conn = () => {
  const chain = {
    where() { return chain; }, whereIn() { return chain; }, whereNotIn() { return chain; },
    select() { return chain; }, orWhere() { return chain; }, first: async () => null,
  };
  return chain;
};

describe('per-application stamped $0 charge cap', () => {
  test('the completion cap is $0, not the fee — a $55.30 reused invoice goes to review', async () => {
    const cap = await resolveCompletionChargeCap({
      svc: { id: 's1', estimated_price: 0, cust_per_application_fee: 55.3, recurring_parent_id: null },
      invoice: { subtotal: 55.3, total: 55.3, discount_amount: 0, notes: '' },
      perApplicationBilling: true, apptCardOneTimeCharge: false, apptCardAcceptedAmount: null,
      extendedLaneAnchor: null, secureSetupFee: 0, conn,
    });
    expect(cap.acceptedPerVisit).toBe(0);
    expect(cap.verdict).toBe('above_cap');
  });

  test('a NULL-priced per-application visit still caps at the fee', async () => {
    const cap = await resolveCompletionChargeCap({
      svc: { id: 's1', estimated_price: null, cust_per_application_fee: 55.3, recurring_parent_id: null },
      invoice: { subtotal: 55.3, total: 55.3, discount_amount: 0, notes: '' },
      perApplicationBilling: true, apptCardOneTimeCharge: false, apptCardAcceptedAmount: null,
      extendedLaneAnchor: null, secureSetupFee: 0, conn,
    });
    expect(cap.acceptedPerVisit).toBe(55.3);
    expect(cap.verdict).toBe('ok');
  });

  test('the sheet does not predict an auto-charge for that reused invoice', () => {
    const base = {
      invoice: { subtotal: 55.3, total: 55.3, discount_amount: 0, line_items: [] },
      autopayActive: true, isRecurring: false, isCallback: false, serviceType: 'Rodent Trapping Service',
      waveguardTier: null, monthlyRate: null, billingMode: 'per_application', perApplicationFee: 55.3,
    };
    expect(attachedInvoiceAutoChargeLikely({ ...base, estimatedPrice: 0 })).toBe(false);
    expect(attachedInvoiceAutoChargeLikely({ ...base, estimatedPrice: null })).toBe(true);
  });
});
