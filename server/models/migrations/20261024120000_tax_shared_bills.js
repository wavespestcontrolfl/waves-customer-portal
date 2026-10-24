/**
 * Shared bills + home office (GATE_TAX_SHARED_BILLS, 2026-10-24).
 *
 * Schema only; the owner writes the rows from Admin > Tax > Setup.
 *
 * tax_shared_bills: a bill that is part business (a phone plan with some
 * business lines, home internet). `pattern` is stored case-folded and
 * normalized (letters and digits, single spaces) by services/tax-shared-bills.js;
 * a staged bank row whose normalized description contains it on word
 * boundaries books at `business_pct` of its deductible amount. The optional
 * category fills in when the operator and the rules left none.
 *
 * tax_home_office: the simplified-method home office, one row per tax year
 * ($5 a square foot, 300 sq ft at most = $1,500 a year). The deduction is
 * computed on read, never stored, so a rate change is one code edit.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tax_shared_bills'))) {
    await knex.schema.createTable('tax_shared_bills', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('pattern').notNullable();
      t.text('label').notNullable();
      t.decimal('business_pct', 5, 2).notNullable();
      t.uuid('category_id').references('id').inTable('expense_categories').onDelete('SET NULL');
      t.boolean('enabled').notNullable().defaultTo(true);
      t.timestamps(true, true);
      t.unique('pattern');
    });
    await knex.raw('ALTER TABLE tax_shared_bills ADD CONSTRAINT tax_shared_bills_pct_check CHECK (business_pct >= 0 AND business_pct <= 100)');
  }
  if (!(await knex.schema.hasTable('tax_home_office'))) {
    await knex.schema.createTable('tax_home_office', (t) => {
      t.integer('tax_year').primary();
      t.text('method').notNullable().defaultTo('simplified');
      t.integer('sq_ft').notNullable();
      t.integer('months').notNullable().defaultTo(12);
      t.text('notes');
      t.timestamps(true, true);
    });
    await knex.raw("ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_method_check CHECK (method = 'simplified')");
    await knex.raw('ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_sq_ft_check CHECK (sq_ft BETWEEN 1 AND 300)');
    await knex.raw('ALTER TABLE tax_home_office ADD CONSTRAINT tax_home_office_months_check CHECK (months BETWEEN 1 AND 12)');
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tax_home_office');
  await knex.schema.dropTableIfExists('tax_shared_bills');
};
