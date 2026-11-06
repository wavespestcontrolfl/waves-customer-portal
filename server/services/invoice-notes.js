// ============================================================
// invoice-notes — the one home for the "accepted estimate" machine marker.
//
// When a customer accepts an estimate, the invoice minted for it carries
//   "Auto-generated from accepted estimate #<estimate uuid>. Customer selected …"
// in invoices.notes. That text is a record for our own code, not a message to
// the customer: admin-schedule, estimate-public, payroll-commission,
// completion-charge-verdict and others match it to link an invoice to its
// estimate, so the WRITE side must not change. The READ side that a customer
// sees (pay page, receipt page, invoice PDF, invoice email) leaves it out with
// customerVisibleInvoiceNotes. Walk 2026-11-05: the pay page showed the raw
// estimate uuid under NOTES.
// ============================================================

// Anywhere in the notes (how the completion-charge verdict has always read it).
const ACCEPT_MINT_NOTE_RE = /Auto-generated from accepted estimate #/;
// A note the mint wrote: the marker is where the note starts.
const ACCEPT_MINT_NOTE_START_RE = /^\s*Auto-generated from accepted estimate #/;

function isAcceptMintNote(notes) {
  return ACCEPT_MINT_NOTE_START_RE.test(String(notes || ''));
}

// The notes a customer may see: the machine marker note becomes null; every
// other note (staff-written, AI service summary) comes back unchanged.
function customerVisibleInvoiceNotes(notes) {
  return isAcceptMintNote(notes) ? null : notes;
}

module.exports = { ACCEPT_MINT_NOTE_RE, isAcceptMintNote, customerVisibleInvoiceNotes };
