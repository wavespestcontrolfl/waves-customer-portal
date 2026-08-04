// Durable ledger for HELD first-touch email sends (2026-07-30 lane, Codex
// #3084 r6 restructure). The call pipeline holds the new_lead drip and the
// newsletter DOI while an email read-back card is live; this row records —
// at hold time — exactly WHAT was held and for WHICH address. Every release
// path (triage resolve/accept, email correction, end-of-run reconciliation)
// reads and settles THIS row instead of inferring state from review-card
// payload markers, which proved race-prone (the address could be corrected
// after extraction persisted, cards could fail to insert, historical cards
// shadowed fresh runs).
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('first_touch_holds')) return;
  await knex.schema.createTable('first_touch_holds', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // One hold per call — a force-reprocess reuses (and may re-pend) the row.
    t.uuid('call_log_id').notNullable().unique()
      .references('id').inTable('call_log').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
    // The address Step 6 actually held — post dictation-decoder/arbiter/
    // domain-correction, which can differ from the persisted extraction.
    t.string('held_email', 320).notNullable();
    t.boolean('held_drip').notNullable().defaultTo(false);
    t.boolean('held_newsletter').notNullable().defaultTo(false);
    t.boolean('released_drip').notNullable().defaultTo(false);
    t.boolean('released_newsletter').notNullable().defaultTo(false);
    // pending | released | blocked (consent veto — terminal)
    t.string('status', 20).notNullable().defaultTo('pending');
    t.string('last_error', 300);
    t.timestamp('released_at');
    t.timestamps(true, true);
    t.index(['customer_id', 'status']);
    t.index(['status']);
  });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('first_touch_holds')) {
    await knex.schema.dropTable('first_touch_holds');
  }
};
