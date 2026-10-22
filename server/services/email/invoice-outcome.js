// A vendor_invoice email only "counts" (daily digest) and reads "Expense
// logged" (mailbox row) when the invoice processor did not stop short of
// booking. `invoice_detected:*` is its stop-short marker: not_paid, no_amount,
// expense_failed, and unauthenticated (GATE_EMAIL_AUTH_STRICT: the sender did
// not authenticate as its From domain, so a person must review it).
function invoiceNotLogged(autoAction, expenseId) {
  return !expenseId && /^invoice_detected:/.test(String(autoAction || ''));
}

function countProcessedInvoices(emails) {
  return (emails || []).filter((e) => e.classification === 'vendor_invoice' && !invoiceNotLogged(e.auto_action, e.expense_id)).length;
}

module.exports = { invoiceNotLogged, countProcessedInvoices };
