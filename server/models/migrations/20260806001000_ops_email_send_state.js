/**
 * Durable send markers for weekly/exception ops emails.
 *
 * One row per email key, stamped only when a send actually left. Exists so
 * deploy-overlap cron ticks can't double-send after the advisory lock is
 * released (the lock only serializes CONCURRENT ticks), WITHOUT abusing
 * job_health — the Intelligence Bar classifies every job_health row as a
 * scheduled job and would flag a quiet-week marker as permanently stale
 * (codex #3230 r2). First consumer: turf-variance-digest.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ops_email_send_state')) return;
  await knex.schema.createTable('ops_email_send_state', (t) => {
    t.string('email_key', 60).primary();
    t.timestamp('last_sent_at', { useTz: true });
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('ops_email_send_state'))) return;
  await knex.schema.dropTable('ops_email_send_state');
};
