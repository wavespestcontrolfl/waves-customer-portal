/**
 * Learning loop for AI-drafted estimates (estimator engine + IB quoting
 * agent). Two passive ledgers:
 *
 * - estimate_draft_baselines: the AI's original composition, captured on the
 *   FIRST pre-send admin revise — reviseAdminEstimate replaces estimate_data
 *   wholesale (only lead_id/scheduled_service_id survive), so without this
 *   snapshot the composed draft is destroyed by the first edit and the
 *   draft→sent edit distance is unmeasurable. A draft with no baseline row
 *   at send time was, by construction, never edited since the AI last
 *   composed it (Agent Estimate re-compositions reset the baseline).
 *
 * - estimate_learning_events: one row per estimate at FIRST send with the
 *   structured edit summary (keys/booleans/numbers only — no free text).
 *
 * Nothing here changes customer-facing behavior.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_draft_baselines'))) {
    await knex.schema.createTable('estimate_draft_baselines', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('estimate_id').notNullable().unique()
        .references('id').inTable('estimates').onDelete('CASCADE');
      table.string('source', 40).notNullable();
      // Full estimate_data as the AI composed it (pre-first-edit).
      table.jsonb('baseline_estimate_data').notNullable();
      // Column-level snapshot (totals/contact/address/tier/interest) so the
      // diff never depends on parsing historical estimate_data shapes.
      table.jsonb('baseline_fields').notNullable();
      table.string('capture_point', 20).notNullable().defaultTo('first_revise');
      table.integer('revise_count').notNullable().defaultTo(0);
      table.timestamp('first_revised_at');
      table.timestamp('last_revised_at');
      table.timestamps(true, true);
    });
  }
  if (!(await knex.schema.hasTable('estimate_learning_events'))) {
    await knex.schema.createTable('estimate_learning_events', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('estimate_id').notNullable()
        .references('id').inTable('estimates').onDelete('CASCADE');
      table.string('event_type', 20).notNullable().defaultTo('sent');
      table.string('source', 40).notNullable();
      table.string('lane', 10);
      table.jsonb('edit_summary').notNullable();
      table.boolean('sent_unedited');
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      // First send only — resends and re-sends after edit-of-sent must not
      // stamp a second calibration event.
      table.unique(['estimate_id', 'event_type']);
      table.index(['source', 'created_at']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_learning_events');
  await knex.schema.dropTableIfExists('estimate_draft_baselines');
};
