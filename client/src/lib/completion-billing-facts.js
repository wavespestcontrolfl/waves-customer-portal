// client/src/lib/completion-billing-facts.js
//
// The billing keys of a schedule row that the Fast Complete Wrap-up reads to know whether the
// completion will mint an invoice (lib/completion-invoice-prediction.js) and whether a third-party
// payer takes it. The sheets get a trimmed `service`; the page that opens one spreads these in.
// `billedToPayer` stays undefined when the row does not carry it.
export function completionBillingFacts(row) {
  return {
    estimatedPrice: row.estimatedPrice,
    billingLane: row.billingLane,
    prepaidAmount: row.prepaidAmount,
    checkoutInvoiceStatus: row.checkoutInvoiceStatus,
    invoiceStatus: row.invoiceStatus,
    createInvoiceOnComplete: row.createInvoiceOnComplete,
    waveguardTier: row.waveguardTier,
    followupIncluded: row.followupIncluded,
    isCallback: row.isCallback,
    completionProfile: row.completionProfile ? { billingType: row.completionProfile.billingType } : undefined,
    billedToPayer: row.billedToPayer,
    // The visit's invoice was already sent (Dispatch marks the row): the completion reuses it, so no pay-link row.
    completionInvoiceAlreadySent: !!row.completionInvoiceAlreadySent,
  };
}
