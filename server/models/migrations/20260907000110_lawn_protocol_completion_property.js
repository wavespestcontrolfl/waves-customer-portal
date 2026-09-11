/** Freeze the service property on each lawn actuals row (scope 2026-09-06: record property with the actuals). */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return;
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (!(await knex.schema.hasColumn('lawn_protocol_service_completions', 'property_id'))) {
    await knex.schema.alterTable('lawn_protocol_service_completions', (t) => {
      t.uuid('property_id').nullable().references('id').inTable('customer_properties')
        .onDelete('SET NULL').onUpdate('CASCADE');
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_lawn_protocol_service_completions_property_id ON lawn_protocol_service_completions (property_id) WHERE property_id IS NOT NULL');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_lawn_protocol_service_completions_property_id');
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return;
  if (await knex.schema.hasColumn('lawn_protocol_service_completions', 'property_id')) {
    await knex.schema.alterTable('lawn_protocol_service_completions', (t) => {
      t.dropForeign('property_id');
      t.dropColumn('property_id');
    });
  }
};
