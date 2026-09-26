/**
 * purchase_receipt_lines.status — add 'possible_duplicate'.
 *
 * 20260926000200 is pushed and frozen, so its CHECK is extended here. The
 * status holds a matched, sized Amazon delivery line WITHOUT a stock
 * movement when the product's ledger suggests staff already put the box on
 * the shelf by hand: a restock from any other source since 48h before the
 * Delivered email, or a count/correction at or after it (see
 * services/purchase-receipts/receipt-processor.js). received_qty /
 * received_unit keep what would have been added; the office gets one bell.
 *
 * restock_request_id (from 20260926000200) stays NULL on every row: the lane
 * no longer writes restock requests at all.
 */
const WITH_HOLD = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'possible_duplicate', 'skipped')";
const WITHOUT_HOLD = "('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'skipped')";

async function replaceStatusCheck(knex, allowed) {
  await knex.raw('ALTER TABLE purchase_receipt_lines DROP CONSTRAINT IF EXISTS purchase_receipt_lines_status_check');
  await knex.raw(`ALTER TABLE purchase_receipt_lines ADD CONSTRAINT purchase_receipt_lines_status_check CHECK (status IN ${allowed})`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITH_HOLD);
};

// Blocked while any row is still possible_duplicate — resolve those first.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  await replaceStatusCheck(knex, WITHOUT_HOLD);
};
