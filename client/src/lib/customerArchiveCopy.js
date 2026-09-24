// Delete (archive) confirmation copy, shared by every admin surface that
// soft-deletes a customer. Archive disarms billing on the server (customer
// Auto Pay, the next charge date, saved-card Auto Pay, armed payment
// retries) and restore deliberately does NOT re-arm any of it
// (PATCH /admin/customers/:id/restore) — the confirmation says so before
// the office commits (#4684 deferred r5 P2).
export const ARCHIVE_BILLING_NOTE =
  "Deleting turns off Auto Pay and any pending automatic charges or payment retries. Restoring the customer later does not turn them back on; re-enable Auto Pay from their profile if needed.";

export function archiveConfirmMessage(name) {
  return `Delete ${name}?\n\nThis removes them from the active customer list. Their history (services, invoices, payments) is preserved and can be restored.\n\n${ARCHIVE_BILLING_NOTE}`;
}
