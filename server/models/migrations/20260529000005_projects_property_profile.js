/**
 * projects.property_profile — cached property specs for a WDO inspection
 * (construction material, foundation, roof, year built, sq ft, stories, source,
 * confidence) resolved by the WDO Intelligence lookup. Cached so the specs
 * panel renders on reload without re-running the web-search lookup. Nullable.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'property_profile');
  if (has) return;
  await knex.schema.alterTable('projects', (t) => {
    t.jsonb('property_profile');
  });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'property_profile');
  if (!has) return;
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('property_profile');
  });
};
