// A vendor_invoice email counts as processed (daily digest) and reads
// "Expense logged" (mailbox row) only with positive evidence: it links to an
// expense (expense_id). No link means not booked: not paid, no amount, failed,
// skipped (operational_sender_skipped), still processing, or an unauthenticated
// sender (GATE_EMAIL_AUTH_STRICT: invoice_detected:unauthenticated, for review).
function countProcessedInvoices(emails) {
  return (emails || []).filter((e) => e.classification === 'vendor_invoice' && e.expense_id).length;
}

module.exports = { countProcessedInvoices };
