/**
 * First-visit intent on an annual prepay term.
 *
 * Coverage visits are generated when the prepay invoice is PAID, anchored to
 * term_start — but term_start is the day the invoice was MINTED. Any lag
 * between mint and payment therefore back-dated the first visit, and the
 * generator had no way to carry a date/time the operator had already promised
 * the customer on the phone (it explicitly nulls window_start/window_end).
 *
 * first_visit_date re-anchors the generated series; first_visit_window_start
 * gives that first visit a real arrival window instead of NULL. Both optional —
 * a term without them keeps the term_start-anchored, windowless behavior.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('annual_prepay_terms');
  if (!hasTable) return;
  const hasDate = await knex.schema.hasColumn('annual_prepay_terms', 'first_visit_date');
  const hasWindow = await knex.schema.hasColumn('annual_prepay_terms', 'first_visit_window_start');
  if (hasDate && hasWindow) return;
  await knex.schema.alterTable('annual_prepay_terms', (table) => {
    if (!hasDate) table.date('first_visit_date');
    if (!hasWindow) table.time('first_visit_window_start');
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('annual_prepay_terms');
  if (!hasTable) return;
  const hasDate = await knex.schema.hasColumn('annual_prepay_terms', 'first_visit_date');
  const hasWindow = await knex.schema.hasColumn('annual_prepay_terms', 'first_visit_window_start');
  if (!hasDate && !hasWindow) return;
  await knex.schema.alterTable('annual_prepay_terms', (table) => {
    if (hasDate) table.dropColumn('first_visit_date');
    if (hasWindow) table.dropColumn('first_visit_window_start');
  });
};
