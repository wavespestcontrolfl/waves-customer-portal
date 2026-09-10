// The prepaid rule the OFFICE invoice paths apply (the Invoices page picker
// and the linked create) before offering an open visit for a new invoice —
// payer-aware and method-specific like the completion's own `prepaidCovered`
// (complete-scheduled-service.js), but stricter where the office path has
// no crediting step of its own (GitHub P2 #4131 r3, pre-push P0 r3):
//   - a PAYER-billed visit is never refused on the homeowner's prepayment:
//     the third party's AP invoice must still be cut;
//   - an annual-prepay stamp is governed ONLY by annualPrepayCoversVisit
//     (explicit stamp AND a still-live, non-refunded term) — a stale stamp
//     left by a best-effort void/refund clear refuses nothing, whatever its
//     amount says — and an UNVERIFIABLE stamp throws (strict mode), which
//     every office caller turns into a refusal (pre-push P0 r3);
//   - ANY positive out-of-band prepayment (cash, Zelle, phone card) refuses,
//     partial or not. The completion and Charge Now apply a recorded
//     prepayment as an idempotent credit when they mint; the office create
//     has no such step, so a $117 visit with $50 on file would otherwise
//     become a collectible $117 invoice the operator can send at once. The
//     completion still bills the remainder — the office path simply does
//     not offer the visit (use Charge now from the schedule).
const db = require('../models/db');

async function prepaidRefusesOfficeInvoice(visit, { payerBilled = false, conn = db } = {}) {
  if (!visit || payerBilled) return false;
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  if (visit.prepaid_method === AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD) {
    // STRICT (pre-push P0 r3): this is the charging side of the boundary —
    // an unverifiable stamp (no amount, no term id, terms table missing, a
    // failed coverage read) must REFUSE the office invoice, not read as
    // "stale stamp, bill away". The error propagates; callers refuse on it.
    return AnnualPrepayRenewals.annualPrepayCoversVisit(visit, conn, { throwOnError: true });
  }
  return Number(visit.prepaid_amount) > 0;
}

module.exports = { prepaidRefusesOfficeInvoice };
