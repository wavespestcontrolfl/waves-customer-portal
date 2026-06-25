/**
 * Daily snapshots of the dashboard Core KPIs, for trend sparklines.
 *
 * The /admin/dashboard/core-kpis endpoint computes the live month-to-date value
 * of every operational KPI (completion rate, callback rate, tech utilization,
 * stops/hr, revenue/job, RPMH, gross margin, AR days, lead conversion, response
 * speed, CSAT, retention, collection rate, autopay coverage, net customers, net
 * MRR). Nothing recorded those values over time, so there was no history to draw
 * a trend from.
 *
 * This table is the TALL store: one row per (ET snapshot_date, metric) holding
 * that day's live MTD value, written by a daily upsert cron. `value` is NULLABLE
 * because any single metric can be unavailable on a given day (a query throws,
 * an empty window, etc.) — we record that explicitly as NULL rather than
 * dropping the row or inventing a zero. The unique (snapshot_date, metric) lets
 * the daily cron upsert in place, so a same-day re-run refreshes the value
 * instead of duplicating rows.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('kpi_snapshots')) return;
  await knex.schema.createTable('kpi_snapshots', (t) => {
    t.increments('id').primary();
    t.date('snapshot_date').notNullable();        // ET calendar date of the capture
    t.string('metric', 64).notNullable();         // stable metric key (e.g. completion_rate)
    t.decimal('value', 14, 4);                    // NULLABLE — metric may be unavailable that day
    t.timestamp('captured_at').defaultTo(knex.fn.now()); // last upsert time
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['snapshot_date', 'metric']);        // one row per (date, metric); enables daily upsert
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('kpi_snapshots');
};
