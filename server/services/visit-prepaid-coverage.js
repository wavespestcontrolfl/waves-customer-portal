// The payer-aware, method-specific prepaid-coverage rule the completion
// applies before deciding a visit needs no invoice (complete-scheduled-
// service.js `prepaidCovered`), mirrored for the office invoice paths
// (GitHub P2 #4131 r3) so the Invoices page picker and the linked create
// refuse exactly the visits the completion would not bill — and offer the
// ones it would:
//   - a PAYER-billed visit is never covered by the homeowner's prepayment:
//     the third party's AP invoice must still be cut;
//   - an annual-prepay stamp is governed ONLY by annualPrepayCoversVisit
//     (explicit stamp AND a still-live, non-refunded term) — a stale stamp
//     left by a best-effort void/refund clear covers nothing, whatever its
//     amount says;
//   - any other method (cash, Zelle, phone card) covers only when the
//     recorded amount reaches the would-be invoice; a partial prepayment
//     still gets an invoice, as at completion.
// invoiceAmount null = the would-be amount is unknown (the picker for a
// visit with no estimated price): any positive out-of-band prepayment then
// counts as covered — fail closed toward "no new collectible invoice".
const db = require('../models/db');

async function prepaidCoversVisit(visit, { payerBilled = false, invoiceAmount = null, conn = db } = {}) {
  if (!visit || payerBilled) return false;
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  if (visit.prepaid_method === AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD) {
    return AnnualPrepayRenewals.annualPrepayCoversVisit(visit, conn);
  }
  const amount = Number(visit.prepaid_amount);
  if (!(amount > 0)) return false;
  return invoiceAmount == null || amount >= Number(invoiceAmount);
}

module.exports = { prepaidCoversVisit };
