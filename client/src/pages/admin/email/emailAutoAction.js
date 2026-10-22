// What the mailbox row says the automation did. A vendor_invoice reads
// "Expense logged" only when the email links to an expense (expense_id).
// Otherwise it was not booked: not paid, no amount, failed, skipped, still
// processing, or an unauthenticated sender (GATE_EMAIL_AUTH_STRICT), which
// needs a person.
const AUTO_ACTION_LABELS = {
  lead_inquiry: "Lead created", spam: "Blocked & trashed", marketing_newsletter: "Unsubscribed",
  vendor_invoice: "Expense logged", complaint: "Flagged urgent",
};

// Returns { text, needsReview } or null.
export function autoActionNote(email) {
  const label = AUTO_ACTION_LABELS[email?.classification];
  if (!label) return null;
  if (email.classification === "vendor_invoice" && !email.expense_id) {
    // "Expense logged" needs positive evidence: a linked expense row.
    return email.auto_action === "invoice_detected:unauthenticated"
      ? { text: "Invoice — check sender, not logged", needsReview: true }
      : { text: "Invoice — not logged", needsReview: false };
  }
  return { text: label, needsReview: false };
}
