/**
 * route_check_runs: one row per ET hour (pre-push audit round 27). The hourly check runs under runExclusive
 * (utils/cron-lock.js), which stops two instances running at the same time only. A second instance (a deploy overlap)
 * whose tick waited for a lock slot can run after the first released the lock, and record the same hour twice.
 *
 * `run_hour` is the ET hour of the run (7-19). The unique key on (service_date, run_hour) keeps the first row of an
 * hour, and the check's insert skips a second one (ON CONFLICT DO NOTHING; services/day-replan/route-check.js). The
 * column is nullable only for rows written before it (the table is new: at most a PR preview's), and a null hour
 * never conflicts. The check always sets it.
 *
 * Additive; down drops the key and the column.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('route_check_runs'))) return;
  if (await knex.schema.hasColumn('route_check_runs', 'run_hour')) return;
  await knex.schema.alterTable('route_check_runs', (t) => {
    t.smallint('run_hour');
    t.unique(['service_date', 'run_hour'], { indexName: 'route_check_runs_hour_key' });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('route_check_runs'))) return;
  if (!(await knex.schema.hasColumn('route_check_runs', 'run_hour'))) return;
  await knex.schema.alterTable('route_check_runs', (t) => {
    t.dropUnique(['service_date', 'run_hour'], 'route_check_runs_hour_key');
    t.dropColumn('run_hour');
  });
};
