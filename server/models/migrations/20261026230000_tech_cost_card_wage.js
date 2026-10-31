/**
 * A technician cost card keeps the hourly wage it was made with (L11a, pre-push audit 2026-10-26).
 *
 * technicians.pay_rate is not dated, so a W-2 card that read it would re-cost an old visit at
 * today's wage after a raise. A W-2 card now stores its wage (hourly_wage); a card without one
 * reads the technician's pay_rate, as before (no card exists anywhere yet). Adding a column
 * updates no row, so the cards' no-update trigger does not fire.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('technician_cost_cards', 'hourly_wage')) return;
  await knex.raw(`ALTER TABLE technician_cost_cards
    ADD COLUMN hourly_wage numeric(10,2) NULL,
    ADD CONSTRAINT technician_cost_cards_hourly_wage_check
      CHECK (hourly_wage IS NULL OR (hourly_wage > 0 AND hourly_wage <= 1000))`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('technician_cost_cards', 'hourly_wage'))) return;
  // A stored wage is cost evidence: preserve it and roll forward.
  if (await knex('technician_cost_cards').whereNotNull('hourly_wage').first('id')) {
    throw new Error('technician_cost_cards holds card wages. Preserve the column and roll forward.');
  }
  await knex.raw(`ALTER TABLE technician_cost_cards
    DROP CONSTRAINT IF EXISTS technician_cost_cards_hourly_wage_check,
    DROP COLUMN hourly_wage`);
};
