// Race-hardening for completion_idempotency_keys.
//
// The first cut stored only the final response under each key. A retry
// after success replays the response — good. But two requests arriving
// with the same key at the same time, or two different keys both racing
// to complete the same scheduled_service, weren't covered.
//
// This migration adds:
//   - status column ('pending' | 'succeeded' | 'failed')
//   - response is now nullable (it's NULL while status='pending')
//   - a partial unique index on service_id WHERE status='pending' so a
//     second request for the same service can't open a parallel pending
//     attempt — the second insert fails on the index, which the route
//     catches and turns into a 409.
exports.up = async (knex) => {
  await knex.schema.alterTable('completion_idempotency_keys', (t) => {
    t.string('status', 16).notNullable().defaultTo('succeeded');
    t.jsonb('response').alter().nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
  });
  // Existing rows pre-date status; mark them succeeded explicitly.
  await knex.raw("UPDATE completion_idempotency_keys SET status = 'succeeded' WHERE status IS NULL");
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_idemp_one_pending_per_service
    ON completion_idempotency_keys (service_id)
    WHERE status = 'pending'
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS idx_completion_idemp_one_pending_per_service');
  await knex.schema.alterTable('completion_idempotency_keys', (t) => {
    t.dropColumn('status');
    t.dropColumn('completed_at');
  });
};
