// Where the sprinklers' water comes from (owner 2026-10-22 / 10-23, "water you saved" phase 2): 'county' (metered
// potable), 'reclaimed' or 'well'; null = not asked / not answered. Decides whether the Monday plan's gallons sentence
// may carry a dollar range (county water only: a well or reclaimed lawn saves pennies, so a dollar figure there would be
// wrong by 10x to 100x). Customer-entered in the portal's Irrigation section; staff may set it in Customer 360. Not
// part of the irrigation-revision trigger (it shapes no watering instruction).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (await knex.schema.hasColumn('property_preferences', 'irrigation_water_source')) return;
  await knex.schema.alterTable('property_preferences', (table) => {
    table.string('irrigation_water_source', 16).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_water_source'))) return;
  await knex.schema.alterTable('property_preferences', (table) => {
    table.dropColumn('irrigation_water_source');
  });
};
