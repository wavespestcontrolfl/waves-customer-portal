// The invoice fields a /complete body carries for a visit (POST
// /admin/dispatch/:id/complete). One rule for the full Complete Service form
// (SchedulePage) and the Fast Complete sheets, so the server takes the same
// branch whichever one closes the visit.
//
// A visit whose invoice was already sent from the payment flow
// (`completionInvoiceAlreadySent`) posts `invoiceAlreadySent: true`: the server
// then sends no second pay-link text, opens no second in-person payment
// prompt, holds the review ask while the invoice is unpaid, and records the
// completion as invoice-handled. Nothing else about the invoice rides the
// body: a visit that carries only `checkoutInvoiceId` / `checkoutInvoiceToken`
// (a charge taken at the door) posts no invoice field on the full form either;
// the server finds that invoice itself, by the visit it belongs to, and
// reuses it (a paid one stays paid).
export function completionInvoiceFields(service) {
  return service?.completionInvoiceAlreadySent ? { invoiceAlreadySent: true } : {};
}
