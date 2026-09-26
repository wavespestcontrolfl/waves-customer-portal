/**
 * purchase_receipt_lines — idempotency + audit trail for the Amazon
 * "Delivered" auto-restock lane (GATE_PURCHASE_RECEIPT_RESTOCK).
 *
 * One row per line item on a parsed delivery-confirmation email. The
 * UNIQUE (vendor, order_number, shipment_key, line_no) constraint is the
 * claim every writer inserts against BEFORE acting on the line, so a re-run
 * of the sweep (cron tick, or the post-sync hook re-offering the same
 * email) can never double-log the same delivered item — see
 * server/services/purchase-receipts/receipt-processor.js.
 *
 * shipment_key: ONE Amazon order can ship (and email "Delivered:") in
 * multiple separate packages, each a DIFFERENT email with the SAME Order #
 * but different contents/quantities — keying the unique constraint on
 * (vendor, order_number, line_no) alone would make the second shipment's
 * email collide with and be dropped by the first. shipment_key is the
 * `shipmentId` query param off the email's "Track package" URL when present,
 * falling back to the email's gmail_id (or id) so a delivery email with no
 * discoverable shipment id still gets its own claim rather than silently
 * losing every shipment after the first for that order.
 *
 * status:
 *   - logged        matched an active product, container size resolved, no
 *                    title/catalog size conflict — stock/restock-request
 *                    written (movement_id / restock_request_id set)
 *   - unmatched      no active product (or 2+ candidates) — never a bell,
 *                    just visible through the Intelligence Bar's
 *                    list_unlogged_purchases read tool
 *   - size_mismatch  the title's own pack size disagrees with the
 *                     product's container_size — not logged, needs a look
 *   - needs_size     matched a product with no parseable container_size
 *   - no_items       a "Delivered:" email (and, when found, its sibling
 *                     Ordered:/Shipped: emails for the same order) had no
 *                     parseable `* title` item blocks at all — one
 *                     placeholder row per email, raw_title = the subject
 *   - skipped        reserved for a future terminal outcome that isn't a
 *                     write and isn't one of the above (kept out of the
 *                     CHECK's working statuses so a manual override has
 *                     somewhere to land without loosening the schema)
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('purchase_receipt_lines')) return;
  await knex.schema.createTable('purchase_receipt_lines', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('email_id').nullable().references('id').inTable('emails').onDelete('SET NULL');
    t.string('vendor', 40).notNullable();
    t.string('order_number', 60).notNullable();
    t.string('shipment_key', 100).notNullable();
    t.integer('line_no').notNullable();
    t.text('raw_title').notNullable();
    t.decimal('quantity', 12, 4).notNullable();
    t.uuid('product_id').nullable().references('id').inTable('products_catalog').onDelete('SET NULL');
    t.decimal('received_qty', 14, 4).nullable();
    t.string('received_unit', 30).nullable();
    t.string('status', 20).notNullable();
    t.uuid('movement_id').nullable();
    t.uuid('restock_request_id').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['vendor', 'order_number', 'shipment_key', 'line_no'], { indexName: 'purchase_receipt_lines_vendor_order_shipment_line_uniq' });
    t.index('product_id');
    t.index('email_id');
  });
  await knex.raw(`
    ALTER TABLE purchase_receipt_lines
    ADD CONSTRAINT purchase_receipt_lines_status_check
    CHECK (status IN ('logged', 'unmatched', 'size_mismatch', 'needs_size', 'no_items', 'skipped'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('purchase_receipt_lines');
};
