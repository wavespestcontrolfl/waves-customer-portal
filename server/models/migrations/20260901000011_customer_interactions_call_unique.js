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
 * every other interaction type are untouched. The key is introduced by the
 * same change set, so no duplicates should exist when this runs; the
 * dedupe below is insurance against a deploy that raced a processing pass —
 * it keeps the EARLIEST entry per call (the canonical first row, the one a
 * note would have been attached to) and removes later copies, so the index
 * can never block a deploy. Reversible: down drops the index (deleted
 * duplicates were derived rows and are not restored).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_interactions'))) return;
  await knex.raw(`
    DELETE FROM customer_interactions dup
    USING customer_interactions keep
    WHERE dup.interaction_type = 'call'
      AND dup.metadata ->> 'call_log_id' IS NOT NULL
      AND keep.interaction_type = 'call'
      AND keep.metadata ->> 'call_log_id' = dup.metadata ->> 'call_log_id'
      AND (keep.created_at < dup.created_at
           OR (keep.created_at = dup.created_at AND keep.id < dup.id))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_interactions_call_log_unique
      ON customer_interactions ((metadata ->> 'call_log_id'))
      WHERE interaction_type = 'call' AND metadata ->> 'call_log_id' IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_interactions_call_log_unique');
};
