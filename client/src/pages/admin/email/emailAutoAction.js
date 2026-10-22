// What the mailbox row says the automation did. A vendor_invoice reads
// "Expense logged" unless the invoice processor stopped short of booking
// (auto_action invoice_detected:*): not paid, no amount, failed, or
// unauthenticated sender (GATE_EMAIL_AUTH_STRICT) which needs a person.
const AUTO_ACTION_LABELS = {
  lead_inquiry: "Lead created", spam: "Blocked & trashed", marketing_newsletter: "Unsubscribed",
  vendor_invoice: "Expense logged", complaint: "Flagged urgent",
};

// Returns { text, needsReview } or null.
export function autoActionNote(email) {
  const label = AUTO_ACTION_LABELS[email?.classification];
  if (!label) return null;
  if (email.classification === "vendor_invoice" && /^invoice_detected:/.test(email.auto_action || "")) {
    return email.auto_action === "invoice_detected:unauthenticated"
      ? { text: "Invoice — check sender, not logged", needsReview: true }
      : { text: "Invoice — not logged", needsReview: false };
  }
  return { text: label, needsReview: false };
}
