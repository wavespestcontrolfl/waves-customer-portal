/**
 * One customer-timeline entry per call, enforced in Postgres.
 *
 * call-recording-processor writes an "Inbound call" customer_interactions
 * row keyed on metadata.call_log_id. A check-then-insert cannot make that
 * exactly-once: a worker that passed its ownership check, lost the claim,
 * and raced the replacement pass could see no row and insert a duplicate.
 * This partial unique index lets the insert say ON CONFLICT DO NOTHING.
 *
 * Partial on rows that carry the key, so legacy entries (no metadata) and
 * every other interaction type are untouched. Reversible: down drops it.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_interactions'))) return;
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_interactions_call_log_unique
      ON customer_interactions ((metadata ->> 'call_log_id'))
      WHERE interaction_type = 'call' AND metadata ->> 'call_log_id' IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_interactions_call_log_unique');
};
