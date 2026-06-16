exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;

  const hasCoverageCadence = await knex.schema.hasColumn('annual_prepay_terms', 'coverage_cadence');
  if (!hasCoverageCadence) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.string('coverage_cadence', 32);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;

  const hasCoverageCadence = await knex.schema.hasColumn('annual_prepay_terms', 'coverage_cadence');
  if (hasCoverageCadence) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.dropColumn('coverage_cadence');
    });
  }
};
