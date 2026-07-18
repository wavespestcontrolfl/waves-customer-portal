/**
 * job_health — one row per named cron job, upserted by the cron-lock
 * recorder (utils/cron-lock.js) on every run. Deliberately an aggregate
 * (latest state + consecutive-failure counter), NOT a run ledger: wrapped
 * jobs include every-minute sweeps, so an append-only table would grow by
 * thousands of rows a day and need pruning; one row per job answers the
 * Intelligence Bar's "did it run / is it failing / is it stale?" without
 * either.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('job_health')) return;
  await knex.schema.createTable('job_health', (t) => {
    t.string('job_name', 120).primary();
    t.timestamp('last_started_at');
    t.timestamp('last_finished_at');
    // Staleness signal — a job whose last_success_at is far older than its
    // cadence has been failing (or never completing) for that long.
    t.timestamp('last_success_at');
    t.string('last_status', 20); // running | success | failed
    t.text('last_error');
    t.integer('last_duration_ms');
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.timestamps(true, true);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('job_health'))) return;
  await knex.schema.dropTable('job_health');
};
