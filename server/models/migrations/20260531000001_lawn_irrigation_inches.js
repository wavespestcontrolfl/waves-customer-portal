exports.up = async function (knex) {
  if (await knex.schema.hasTable('property_preferences')) {
    const hasPropertyInches = await knex.schema.hasColumn('property_preferences', 'irrigation_inches_per_week');
    if (!hasPropertyInches) {
      await knex.schema.alterTable('property_preferences', (t) => {
        t.decimal('irrigation_inches_per_week', 4, 2).nullable();
      });
    }
  }

  if (await knex.schema.hasTable('customer_turf_profiles')) {
    const hasProfileInches = await knex.schema.hasColumn('customer_turf_profiles', 'irrigation_inches_per_week');
    if (!hasProfileInches) {
      await knex.schema.alterTable('customer_turf_profiles', (t) => {
        t.decimal('irrigation_inches_per_week', 4, 2).nullable();
      });
    }
  }

  if (await knex.schema.hasTable('lawn_assessments')) {
    const hasAssessmentInches = await knex.schema.hasColumn('lawn_assessments', 'irrigation_inches_per_week');
    if (!hasAssessmentInches) {
      await knex.schema.alterTable('lawn_assessments', (t) => {
        t.decimal('irrigation_inches_per_week', 4, 2).nullable();
      });
    }
  }
};

exports.down = async function (knex) {
  const drops = [
    ['lawn_assessments', 'irrigation_inches_per_week'],
    ['customer_turf_profiles', 'irrigation_inches_per_week'],
    ['property_preferences', 'irrigation_inches_per_week'],
  ];

  for (const [table, column] of drops) {
    if (await knex.schema.hasTable(table) && await knex.schema.hasColumn(table, column)) {
      await knex.schema.alterTable(table, (t) => {
        t.dropColumn(column);
      });
    }
  }
};
