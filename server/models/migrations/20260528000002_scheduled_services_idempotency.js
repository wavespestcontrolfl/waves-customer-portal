/**
 * PR-B — Idempotency and provenance columns on scheduled_services.
 *
 * - idempotency_key: hash of (call_id + scheduling + service + address),
 *   prevents duplicate appointment creation on pipeline retries.
 * - source_call_log_id: FK back to the call that triggered creation.
 * - source_action: 'ai_call_pipeline' | 'manual' | etc.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.string('idempotency_key', 64).unique().nullable();
    t.uuid('source_call_log_id').nullable().references('id').inTable('call_log').onDelete('SET NULL');
    t.string('source_action', 30).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('idempotency_key');
    t.dropColumn('source_call_log_id');
    t.dropColumn('source_action');
  });
};
