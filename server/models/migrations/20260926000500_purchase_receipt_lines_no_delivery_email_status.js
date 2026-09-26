/**
 * purchase_receipt_lines.status — add 'no_delivery_email'.
 *
 * Amazon skips the "Delivered:" email for about 1 in 6 shipments (5 of 29
 * since April, the Sep 13 Gentrol among them), so the Delivered-email lane
 * never sees those deliveries. undelivered-shipments.js records the stocked
 * items of such a shipment under this status, from its "Shipped:" email,
 * and rings one bell asking for a hand log. The rows also mark the
 * shipment as handed to a person: a late Delivered email for it is never
 * auto-logged (receipt-processor.js), so the box can't be counted twice.
 */
const WITH_STATUS = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'no_order_number', 'no_delivery_email', 'skipped')";
const WITHOUT_STATUS = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'no_order_number', 'skipped')";

async function replaceStatusCheck(knex, allowed) {
  await knex.raw('ALTER TABLE purchase_receipt_lines DROP CONSTRAINT IF EXISTS purchase_receipt_lines_status_check');
  await knex.raw(`ALTER TABLE purchase_receipt_lines ADD CONSTRAINT purchase_receipt_lines_status_check CHECK (status IN ${allowed})`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITH_STATUS);
};

// Blocked while any row is still no_delivery_email — resolve those first.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITHOUT_STATUS);
};
