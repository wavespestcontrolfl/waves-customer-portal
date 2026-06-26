/**
 * Per-user pinned dashboard widgets for the AI chart builder.
 *
 * An admin describes a chart in plain English; the AI proposes a read-only
 * SELECT + chart spec (server/services/ai-chart-builder.js), it runs through the
 * read-only sandbox (server/services/analytics-sql-sandbox.js), and the admin can
 * pin the result. We persist the prompt, the (sandbox-validated) SQL, and the
 * chart spec; on each dashboard load the stored SQL is RE-validated and RE-run
 * read-only — a pinned widget can never mutate data.
 *
 * Scoped per admin via owner_technician_id (technicians.id is uuid; see the CRM
 * migration's assigned_to FK). One row = one tile on that admin's dashboard.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('user_dashboard_widgets')) return;
  await knex.schema.createTable('user_dashboard_widgets', (t) => {
    t.increments('id').primary();
    t.uuid('owner_technician_id').notNullable()
      .references('id').inTable('technicians').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.text('prompt'); // the natural-language request that generated it
    t.text('sql').notNullable(); // re-validated + re-run read-only on every load
    t.jsonb('chart_spec').notNullable(); // { chartType, x, y[], title, explanation }
    t.integer('position').notNullable().defaultTo(0);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('owner_technician_id');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('user_dashboard_widgets');
};
