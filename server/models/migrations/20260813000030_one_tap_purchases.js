// One-tap purchase ledger (portal roadmap bet 3, owner rulings 2026-08-13).
// One row per purchase attempt started from the portal-home priced offer
// card: the terms the customer saw (version + exact snapshot), the offer
// identity/fingerprint they clicked, the synthesized draft estimate the
// purchase rides, the live slot hold, and the confirm-time consent stamps.
// No customer names or addresses live here — identity is the customer_id FK.

exports.up = async function up(knex) {
  await knex.schema.createTable('one_tap_purchases', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('customer_id').notNullable()
      .references('id').inTable('customers')
      .index();
    // One purchase per synthesized draft — the estimate is minted for this
    // flow and never shared with another purchase row.
    table.uuid('estimate_id').notNullable().unique()
      .references('id').inTable('estimates');
    table.text('service_key').notNullable();
    table.text('option_id');
    table.text('fingerprint').notNullable();
    table.decimal('per_visit', 10, 2).notNullable();
    table.text('status').notNullable().defaultTo('initiated');
    // Live slot hold (scheduled_services reservation row). Cleared back to
    // null on release; the committed visit keeps the same id after confirm.
    table.uuid('scheduled_service_id');
    table.text('slot_id');
    table.text('terms_version').notNullable();
    table.text('terms_snapshot').notNullable();
    table.text('consent_ip');
    table.text('consent_user_agent');
    table.timestamp('accepted_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE one_tap_purchases
    ADD CONSTRAINT one_tap_purchases_status_check
    CHECK (status IN ('initiated', 'reserved', 'completed', 'voided'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('one_tap_purchases');
};
