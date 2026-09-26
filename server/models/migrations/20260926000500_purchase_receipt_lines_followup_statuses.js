/**
 * purchase_receipt_lines.status — the held states of the undelivered-Amazon
 * alert and the SiteOne invoice lane (services/purchase-receipts/).
 * 20260926000200..000400 are pushed and frozen, so the CHECK is extended
 * here. Each status holds a line WITHOUT a stock movement and rings one bell:
 *   - no_delivery_email  an Amazon shipment whose Delivered email never came
 *                        (undelivered-shipments.js; recorded from its
 *                        "Shipped:" email). The shipment is handed to a
 *                        person for good: a late Delivered email for it is
 *                        never auto-logged.
 *   - returned           a stocked product on a SiteOne invoice with a
 *                        negative quantity (a return) — taken out by hand.
 *   - unverified         a SiteOne invoice whose extracted lines don't
 *                        reconcile (qty x unit price vs line total, lines vs
 *                        subtotal, subtotal + tax vs total) or whose invoice
 *                        number doesn't match the email's.
 *   - unreadable         a SiteOne invoice email whose PDF was never read
 *                        into line items (one placeholder row per invoice).
 */
const WITH_STATUSES = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'no_order_number', "
  + "'no_delivery_email', 'returned', 'unverified', 'unreadable', 'skipped')";
const WITHOUT_STATUSES = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'no_order_number', 'skipped')";

async function replaceStatusCheck(knex, allowed) {
  await knex.raw('ALTER TABLE purchase_receipt_lines DROP CONSTRAINT IF EXISTS purchase_receipt_lines_status_check');
  await knex.raw(`ALTER TABLE purchase_receipt_lines ADD CONSTRAINT purchase_receipt_lines_status_check CHECK (status IN ${allowed})`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITH_STATUSES);
};

// Blocked while any row still carries one of these statuses — resolve those first.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITHOUT_STATUSES);
};
