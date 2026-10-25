/**
 * Auto lunch (GATE_AUTO_LUNCH, owner 2026-10-25): paid hours exclude the
 * unpaid meal.
 *
 *   time_entry_daily_summary.unpaid_meal_minutes  the day's unpaid meal, in
 *     the same numeric(10,2) minutes as total_shift_minutes. 0 until the gate
 *     is on, so existing rows and every gate-off number are unchanged.
 *   time_entry_daily_summary.no_lunch             the tech (or an admin)
 *     marked "No lunch today": the 30-minute auto lunch is skipped for that
 *     day. A recompute never overwrites it.
 *   time_weekly_summary.unpaid_meal_minutes       sum of the week's days.
 *
 * Idempotent (hasColumn). Every column is NOT NULL with a constant default,
 * so existing summary rows read 0 / false and no backfill is needed.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('time_entry_daily_summary', 'unpaid_meal_minutes'))) {
    await knex.schema.alterTable('time_entry_daily_summary', (t) => {
      t.decimal('unpaid_meal_minutes', 10, 2).notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('time_entry_daily_summary', 'no_lunch'))) {
    await knex.schema.alterTable('time_entry_daily_summary', (t) => {
      t.boolean('no_lunch').notNullable().defaultTo(false);
    });
  }
  if (!(await knex.schema.hasColumn('time_weekly_summary', 'unpaid_meal_minutes'))) {
    await knex.schema.alterTable('time_weekly_summary', (t) => {
      t.decimal('unpaid_meal_minutes', 10, 2).notNullable().defaultTo(0);
    });
  }
};

exports.down = async function (knex) {
  for (const [table, column] of [
    ['time_weekly_summary', 'unpaid_meal_minutes'],
    ['time_entry_daily_summary', 'no_lunch'],
    ['time_entry_daily_summary', 'unpaid_meal_minutes'],
  ]) {
    if (await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(column));
    }
  }
};
