/**
 * purchase_receipt_lines.status — add 'no_order_number'.
 *
 * 20260926000200 and 000300 are pushed and frozen, so the CHECK is extended
 * again here. The status holds an authenticated Amazon Delivered line whose
 * email names the item but has no readable "Order #" (a template change):
 * it is recorded under order_number 'unknown' (keyed by the shipment, so a
 * re-run never duplicates it) and the office gets one bell, instead of the
 * delivery vanishing from both stock and review
 * (services/purchase-receipts/receipt-processor.js).
 */
const WITH_STATUS = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'no_order_number', 'skipped')";
const WITHOUT_STATUS = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'skipped')";

async function replaceStatusCheck(knex, allowed) {
  await knex.raw('ALTER TABLE purchase_receipt_lines DROP CONSTRAINT IF EXISTS purchase_receipt_lines_status_check');
  await knex.raw(`ALTER TABLE purchase_receipt_lines ADD CONSTRAINT purchase_receipt_lines_status_check CHECK (status IN ${allowed})`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITH_STATUS);
};

// Blocked while any row is still no_order_number — resolve those first.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITHOUT_STATUS);
};
