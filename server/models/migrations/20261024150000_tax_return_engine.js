/**
 * Tax return engine (GATE_TAX_RETURN_ENGINE, 2026-10-24).
 *
 * Schema only.
 *
 * tax_years: one row per tax year. The owner's inputs for the federal return
 * (filing status, income outside the business, estimates paid) and the
 * carryovers that come IN from the prior year. A year marked filed freezes the
 * computed return (lines and carryovers OUT) in filed_snapshot; a draft year
 * has neither a filing date nor a snapshot (CHECK below).
 *
 * tax_home_office (from 20261024120000_tax_shared_bills.js) learns the ACTUAL
 * method (Form 8829). Simplified keeps its 300 sq ft ceiling, now a CHECK that
 * applies to the simplified method only. Actual stores the home's square feet
 * and the year's expense totals; the deduction is computed on read.
 *
 * down(): drops tax_years and puts the two home-office CHECKs back as they
 * were. Any actual-method row is deleted first, because the old schema cannot
 * hold one.
 */
const CHECKS = [
  'tax_home_office_method_check',
  'tax_home_office_sq_ft_check',
  'tax_home_office_simplified_sq_ft_check',
  'tax_home_office_actual_check',
  'tax_home_office_amounts_check',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tax_years'))) {
    await knex.schema.createTable('tax_years', (t) => {
      t.integer('tax_year').primary();
      t.text('filing_status').notNullable().defaultTo('single');
      t.text('status').notNullable().defaultTo('draft');
      t.date('filed_on');
      t.decimal('other_income', 12, 2).notNullable().defaultTo(0);
      t.decimal('estimates_paid', 12, 2).notNullable().defaultTo(0);
      t.decimal('nol_in', 12, 2).notNullable().defaultTo(0);
      t.decimal('qbi_loss_in', 12, 2).notNullable().defaultTo(0);
      t.decimal('sec179_carry_in', 12, 2).notNullable().defaultTo(0);
      t.decimal('home_office_carry_in', 12, 2).notNullable().defaultTo(0);
      t.jsonb('filed_snapshot');
      t.text('notes');
      t.timestamps(true, true);
    });
    await knex.raw("ALTER TABLE tax_years ADD CONSTRAINT tax_years_filing_status_check CHECK (filing_status IN ('single', 'mfj', 'hoh'))");
    await knex.raw("ALTER TABLE tax_years ADD CONSTRAINT tax_years_status_check CHECK (status IN ('draft', 'filed'))");
    await knex.raw(`ALTER TABLE tax_years ADD CONSTRAINT tax_years_filed_check CHECK (
      (status = 'filed' AND filed_on IS NOT NULL AND filed_snapshot IS NOT NULL)
      OR (status = 'draft' AND filed_on IS NULL AND filed_snapshot IS NULL))`);
    await knex.raw(`ALTER TABLE tax_years ADD CONSTRAINT tax_years_amounts_check CHECK (
      other_income >= 0 AND estimates_paid >= 0 AND nol_in >= 0 AND qbi_loss_in >= 0
      AND sec179_carry_in >= 0 AND home_office_carry_in >= 0)`);
  }

  if (await knex.schema.hasTable('tax_home_office')) {
    if (!(await knex.schema.hasColumn('tax_home_office', 'home_sq_ft'))) {
      await knex.schema.alterTable('tax_home_office', (t) => {
        t.integer('home_sq_ft');
        t.decimal('rent', 12, 2);
        t.decimal('utilities', 12, 2);
        t.decimal('insurance', 12, 2);
        t.decimal('other', 12, 2);
      });
    }
    for (const name of CHECKS) await knex.raw(`ALTER TABLE tax_home_office DROP CONSTRAINT IF EXISTS ${name}`);
    await knex.raw("ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_method_check CHECK (method IN ('simplified', 'actual'))");
    await knex.raw('ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_sq_ft_check CHECK (sq_ft >= 1)');
    await knex.raw("ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_simplified_sq_ft_check CHECK (method <> 'simplified' OR sq_ft BETWEEN 1 AND 300)");
    await knex.raw("ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_actual_check CHECK (method <> 'actual' OR (home_sq_ft IS NOT NULL AND home_sq_ft > 0 AND home_sq_ft >= sq_ft))");
    await knex.raw(`ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_amounts_check CHECK (
      COALESCE(rent, 0) >= 0 AND COALESCE(utilities, 0) >= 0 AND COALESCE(insurance, 0) >= 0 AND COALESCE(other, 0) >= 0)`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tax_years');
  if (await knex.schema.hasTable('tax_home_office')) {
    await knex.raw("DELETE FROM tax_home_office WHERE method <> 'simplified'");
    for (const name of CHECKS) await knex.raw(`ALTER TABLE tax_home_office DROP CONSTRAINT IF EXISTS ${name}`);
    await knex.raw("ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_method_check CHECK (method = 'simplified')");
    await knex.raw('ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_sq_ft_check CHECK (sq_ft BETWEEN 1 AND 300)');
    if (await knex.schema.hasColumn('tax_home_office', 'home_sq_ft')) {
      await knex.schema.alterTable('tax_home_office', (t) => {
        t.dropColumn('home_sq_ft');
        t.dropColumn('rent');
        t.dropColumn('utilities');
        t.dropColumn('insurance');
        t.dropColumn('other');
      });
    }
  }
};
