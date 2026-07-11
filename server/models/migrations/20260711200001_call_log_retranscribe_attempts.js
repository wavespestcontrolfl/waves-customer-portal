/**
 * Retry budget for the re-transcription backfill (Codex P2 on #2613).
 *
 * Infrastructure failures (provider 5xx, credentials, timeouts) retry up to
 * MAX_ATTEMPTS across runs before the permanent retranscribed_at stamp;
 * per-recording verdicts (no speech / implausible / undiarized) still stamp
 * on the first try. Separate migration — 20260711200000 already ran in the
 * PR environment, so it must not be edited in place.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (await knex.schema.hasColumn('call_log', 'retranscribe_attempts')) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.integer('retranscribe_attempts').notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'retranscribe_attempts'))) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('retranscribe_attempts');
  });
};
