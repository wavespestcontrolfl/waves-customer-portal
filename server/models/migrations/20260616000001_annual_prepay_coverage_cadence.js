exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;

  const hasCoverageServiceType = await knex.schema.hasColumn('annual_prepay_terms', 'coverage_service_type');
  const hasCoverageVisitCount = await knex.schema.hasColumn('annual_prepay_terms', 'coverage_visit_count');
  const hasCoverageCadence = await knex.schema.hasColumn('annual_prepay_terms', 'coverage_cadence');

  if (!hasCoverageServiceType || !hasCoverageVisitCount || !hasCoverageCadence) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      if (!hasCoverageServiceType) t.string('coverage_service_type', 120);
      if (!hasCoverageVisitCount) t.integer('coverage_visit_count');
      if (!hasCoverageCadence) t.string('coverage_cadence', 32);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;

  const hasCoverageServiceType = await knex.schema.hasColumn('annual_prepay_terms', 'coverage_service_type');
  const hasCoverageVisitCount = await knex.schema.hasColumn('annual_prepay_terms', 'coverage_visit_count');
  const hasCoverageCadence = await knex.schema.hasColumn('annual_prepay_terms', 'coverage_cadence');

  if (hasCoverageServiceType || hasCoverageVisitCount || hasCoverageCadence) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      if (hasCoverageServiceType) t.dropColumn('coverage_service_type');
      if (hasCoverageVisitCount) t.dropColumn('coverage_visit_count');
      if (hasCoverageCadence) t.dropColumn('coverage_cadence');
    });
  }
};
