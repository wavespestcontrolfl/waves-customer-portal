/**
 * collections_flags — per-customer hard blocks for the collections contact
 * policy. An UNRELEASED row (released_at IS NULL) denies contact on the
 * channels its flag covers; releasing a flag stamps released_at rather than
 * deleting the row, so the history of who blocked what (and why) survives.
 *
 * Flags (contact-policy.js is the enforcement authority):
 *   do_not_call, do_not_text, do_not_email       — channel-specific
 *   automated_voice_consent_revoked              — voice only
 *   wrong_number, collection_hold, do_not_collect,
 *   attorney_represented, bankruptcy             — block ALL channels
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('collections_flags')) return;
  await knex.schema.createTable('collections_flags', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('flag', 40).notNullable();
    t.text('reason');
    // Free-form actor tag ('admin:<uuid>', 'system:<rail>') — kept as a string
    // so system writers don't need a technicians row.
    t.string('created_by', 80);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('released_at', { useTz: true });

    t.index('customer_id');
  });

  // At most one ACTIVE row per (customer, flag); released history rows are
  // unconstrained.
  await knex.raw(`
    CREATE UNIQUE INDEX collections_flags_active_uniq
      ON collections_flags (customer_id, flag)
      WHERE released_at IS NULL
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('collections_flags');
};
