/**
 * setup_fee_claims — immutable server-side record that a setup-fee claim
 * rode a specific invoice, written ONLY by the completion mint (no admin
 * route writes here). The Auto Pay rail reads it on crash-resume: if the
 * process dies after the durable pending_setup_fee claim is retired but
 * before the saved-card rail runs, this row is the surviving authorization
 * evidence — matched on invoice_id AND exact cents, so an edited invoice
 * line can never widen a charge (Codex #3500: editable line JSON must not
 * authorize; the secure_claim line marker stays provenance-only).
 */
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('setup_fee_claims');
  if (exists) return;
  await knex.schema.createTable('setup_fee_claims', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    // One claim record per invoice — the fee rides exactly one mint.
    t.uuid('invoice_id').notNullable().unique()
      .references('id').inTable('invoices').onDelete('CASCADE');
    // The series parent the pending_setup_fee claim lived on.
    t.uuid('scheduled_service_id')
      .references('id').inTable('scheduled_services').onDelete('SET NULL');
    t.decimal('amount', 10, 2).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('setup_fee_claims');
};
