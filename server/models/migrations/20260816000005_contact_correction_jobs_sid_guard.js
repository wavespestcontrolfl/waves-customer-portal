/**
 * Partial unique index on contact_correction_jobs.message_sid (codex
 * #3413 r18): a Twilio redelivery reserves BEFORE the MessageSid
 * idempotency claim can short-circuit it, so a crash (or a failed
 * fire-and-forget cancel) could leave a duplicate reservation that the
 * stale sweep would later replay — with a later queue id and a run-start
 * snapshot, able to overwrite a newer correction with the redelivered
 * older value.
 *
 * Scoped to non-cancelled rows: once a delivery's reservation is
 * cancelled (route decided no run was needed), a later redelivery may
 * legitimately reserve again. The reserve path is already fail-soft — a
 * unique violation logs and returns null, which is exactly the desired
 * "the original delivery's job owns this message" outcome. The sweep
 * keeps its own duplicate-sid check for rows created before this index.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS contact_correction_jobs_live_sid_unique
    ON contact_correction_jobs (message_sid)
    WHERE message_sid IS NOT NULL AND status <> 'cancelled'
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS contact_correction_jobs_live_sid_unique');
};
