/**
 * Add customers.service_preferences JSONB — stores per-customer opt-outs for
 * specific parts of a pest control visit. Initially supports:
 *
 *   { interior_spray: boolean, exterior_sweep: boolean }
 *
 * Defaults to both true (full service). Customers can toggle either off in
 * the estimator at accept time, or from the customer portal later. Tech
 * work orders read this column to show badges so techs know to skip the
 * opted-out component.
 *
 * JSONB rather than two columns: keeps the shape open-ended for future
 * opt-outs (e.g. no-garage, no-yard-only) without a migration each time.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (await knex.schema.hasColumn('customers', 'service_preferences')) return;

  await knex.schema.alterTable('customers', (t) => {
    t.jsonb('service_preferences')
      .notNullable()
      .defaultTo(knex.raw(`'{"interior_spray": true, "exterior_sweep": true}'::jsonb`));
  });
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('customers', 'service_preferences'))) return;
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('service_preferences');
  });
};
