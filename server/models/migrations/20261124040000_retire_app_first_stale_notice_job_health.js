/**
 * The app-first stale-notice check (GATE_APP_FIRST_ANY_DEVICE, removed with its cron) no longer runs.
 * Its job_health row would read as unhealthy eight days after its last success in every reader that
 * lists all rows (Intelligence Bar job health, agent watchdog). Delete that one row.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('job_health'))) return;
  await knex('job_health').where({ job_name: 'app-first-stale-notice-check' }).del();
};

// The row is rewritten by the cron lock if the job ever runs again; nothing to restore.
exports.down = async function down() {};
