'use strict';

// One durable row per recurring-card SetupIntent considered alongside an
// estimate acceptance. This is deliberately a facts ledger, not a winner
// policy: a row may carry both a discard request and a legacy recovery claim
// until the application decides which fact wins under the estimate lock.
const TABLE = 'estimate_recurring_capture_dispositions';

exports.TABLE = TABLE;

exports.up = async function up(knex) {
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('estimate_id').notNullable()
      .references('id').inTable('estimates').onDelete('CASCADE');
    t.string('setup_intent_id', 100).notNullable();
    t.timestamp('discard_requested_at', { useTz: true }).nullable();
    t.timestamp('retired_at', { useTz: true }).nullable();
    t.timestamp('legacy_recovery_claimed_at', { useTz: true }).nullable();
    t.primary(['estimate_id', 'setup_intent_id']);
  });

  await knex.raw(`
    ALTER TABLE ${TABLE}
    ADD CONSTRAINT ${TABLE}_retired_requires_discard_check
    CHECK (retired_at IS NULL OR discard_requested_at IS NOT NULL),
    ADD CONSTRAINT ${TABLE}_has_disposition_fact_check
    CHECK (discard_requested_at IS NOT NULL OR legacy_recovery_claimed_at IS NOT NULL)
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
