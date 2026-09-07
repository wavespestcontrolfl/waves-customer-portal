/** Add property identity without guessing which lawn a historical row describes. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  for (const table of ['lawn_assessments', 'lawn_baseline_resets']) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'property_id'))) {
      await knex.schema.alterTable(table, (t) => {
        t.uuid('property_id').nullable().references('id').inTable('customer_properties')
          .onDelete('SET NULL').onUpdate('CASCADE');
      });
    }
  }
  if (await knex.schema.hasTable('lawn_assessments')) {
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_lawn_assessments_property_id ON lawn_assessments (property_id) WHERE property_id IS NOT NULL');
  }
  if (await knex.schema.hasTable('lawn_baseline_resets')) {
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_lawn_baseline_resets_customer_created ON lawn_baseline_resets (customer_id, created_at DESC)');
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_lawn_assessments_property_id');
  await knex.raw('DROP INDEX IF EXISTS idx_lawn_baseline_resets_customer_created');
  for (const table of ['lawn_assessments', 'lawn_baseline_resets']) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex.schema.hasColumn(table, 'property_id')) {
      await knex.schema.alterTable(table, (t) => {
        t.dropForeign('property_id');
        t.dropColumn('property_id');
      });
    }
  }
};
