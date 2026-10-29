/**
 * Owner 2026-10-28 (2026 bank review: "Travel and Uber ... business"): a Travel expense
 * category on Schedule C line 24a.
 *
 * The return engine already names and orders line 24a ('Travel', LINE_ORDER in
 * tax-return-engine.js), but no expense category carried irs_line '24a', so business
 * flights, lodging and rides from Bank Import had no category to land on.
 *
 * One category row named exactly "Travel", irs_line '24a', deductible. A row that already
 * has that name (any case) is left as it is. sort_order = current max + 1. Idempotent.
 */

const CATEGORY_NAME = 'Travel';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('expense_categories'))) return;

  const existing = await knex('expense_categories')
    .whereRaw('lower(trim(name)) = ?', [CATEGORY_NAME.toLowerCase()])
    .first('id');
  if (existing) return;

  const maxRow = await knex('expense_categories').max('sort_order as max').first();
  await knex('expense_categories').insert({
    name: CATEGORY_NAME,
    irs_line: '24a',
    irs_description: 'Travel',
    is_deductible: true,
    notes: 'Business travel and business rides: airfare, lodging, rental cars, Uber and Lyft, '
      + 'parking and tolls on a trip. Meals stay in Meals & Entertainment (line 24b, 50%).',
    sort_order: (Number(maxRow && maxRow.max) || 0) + 1,
  });
};

// Every table whose category_id references expense_categories ON DELETE SET NULL.
const REFERENCING_TABLES = ['expenses', 'tax_ledger_rules', 'tax_shared_bills'];

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('expense_categories'))) return;

  const row = await knex('expense_categories').where({ name: CATEGORY_NAME, irs_line: '24a' }).first('id');
  if (!row) return;

  // Drop the row only when nothing points at it: deleting a referenced row would silently
  // clear the category on real expenses, ledger rules or shared bills (all ON DELETE SET NULL).
  for (const table of REFERENCING_TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'category_id'))) continue;
    if (await knex(table).where({ category_id: row.id }).first('id')) return;
  }
  await knex('expense_categories').where({ id: row.id }).del();
};
