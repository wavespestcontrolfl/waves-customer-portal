/**
 * Mowing schedule on property preferences. Lawn applications should not go
 * down right before or right after a cut, so the portal collects which days
 * and rough hours the customer's mower typically comes through. Same shapes
 * as the irrigation fields: mowing_days mirrors watering_days (jsonb array
 * of day abbreviations), mowing_time_of_day is a short preference key,
 * mowing_notes is free text.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;

  if (!(await knex.schema.hasColumn('property_preferences', 'mowing_days'))) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.jsonb('mowing_days');
    });
  }
  if (!(await knex.schema.hasColumn('property_preferences', 'mowing_time_of_day'))) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.string('mowing_time_of_day', 30);
    });
  }
  if (!(await knex.schema.hasColumn('property_preferences', 'mowing_notes'))) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.text('mowing_notes');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;

  for (const col of ['mowing_notes', 'mowing_time_of_day', 'mowing_days']) {
    if (await knex.schema.hasColumn('property_preferences', col)) {
      await knex.schema.alterTable('property_preferences', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
