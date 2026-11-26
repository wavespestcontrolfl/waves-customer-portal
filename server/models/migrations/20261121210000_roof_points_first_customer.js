'use strict';

/**
 * The roof points a lead already holds stay on the estimate for its FIRST customer (owner 2026-11-21, follow-up "keep"
 * of choice 4A).
 *
 * The page rule (estimate-roof-points.js copyForHolder) showed a frozen copy only to the one it was frozen for: a copy
 * frozen for a lead names no customer, so it left the page the moment the lead became a customer, until staff pressed
 * Save points again and re-sent the estimate. Nothing told the first customer of an estimate from a later one.
 *
 * Two columns tell them apart. No row changes its owner, and nothing is back-filled.
 *
 * 1. estimates.customer_changes counts how often the estimate's customer changed (to a customer, to another one, to
 *    none). The trigger estimates_count_customer_change adds one with each change, before the row is written, and it
 *    is the only writer: a value an UPDATE sends for the column is dropped. `estimates.customer_id` is written at about
 *    ten places (acceptance, booking, lead conversion, an add-service request), so the count is kept in the database.
 *
 * 2. estimate_roof_points.lead_changes: a send that freezes a copy while the estimate has no customer writes that
 *    count on the copy (estimate-roof-points.js freezeRoofPointsForEstimate). A copy frozen for a customer, and every
 *    copy from before this migration, has NULL.
 *
 * The page then shows a lead's copy while the estimate's count is the copy's (the same lead still holds the link), and
 * while the count is ONE more and the estimate has a customer: one change since that send, from no customer, is the
 * customer the lead became. Any later change (another customer, a merge, no customer again) moves the count on and the
 * copy is not shown again. A copy with NULL keeps the rule it had.
 *
 * Down drops the trigger, its function and the two columns.
 */
exports.up = async function up(knex) {
  for (const table of ['estimates', 'estimate_roof_points']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  // Each new column takes a short ACCESS EXCLUSIVE lock on its table, and the trigger a lock that stops writes. While
  // one waits for an open transaction, reads and writes of that table queue behind it. Give up after 10 seconds (the
  // deploy fails and the next one tries again) instead of holding estimates.
  await knex.raw("SET LOCAL lock_timeout = '10s'");
  // A constant default adds the column with no table rewrite.
  if (!(await knex.schema.hasColumn('estimates', 'customer_changes'))) {
    await knex.schema.alterTable('estimates', (table) => {
      table.integer('customer_changes').notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('estimate_roof_points', 'lead_changes'))) {
    await knex.schema.alterTable('estimate_roof_points', (table) => {
      table.integer('lead_changes');
    });
  }
  // The count is this trigger's alone: it starts from the stored value, so a value an UPDATE sends is dropped.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION estimates_count_customer_change() RETURNS trigger AS $$
    BEGIN
      NEW.customer_changes := OLD.customer_changes
        + CASE WHEN NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN 1 ELSE 0 END;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.raw('DROP TRIGGER IF EXISTS estimates_count_customer_change ON estimates');
  await knex.raw(`
    CREATE TRIGGER estimates_count_customer_change
    BEFORE UPDATE OF customer_id, customer_changes ON estimates
    FOR EACH ROW
    EXECUTE FUNCTION estimates_count_customer_change()
  `);
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");
  if (await knex.schema.hasTable('estimates')) {
    await knex.raw('DROP TRIGGER IF EXISTS estimates_count_customer_change ON estimates');
  }
  await knex.raw('DROP FUNCTION IF EXISTS estimates_count_customer_change()');
  for (const [name, column] of [['estimate_roof_points', 'lead_changes'], ['estimates', 'customer_changes']]) {
    if (await knex.schema.hasTable(name) && await knex.schema.hasColumn(name, column)) {
      await knex.schema.alterTable(name, (table) => { table.dropColumn(column); });
    }
  }
};
