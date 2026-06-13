exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('seo_backlinks');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('seo_backlinks', 'discovery_source');
  if (hasColumn) return;

  await knex.schema.alterTable('seo_backlinks', (t) => {
    t.string('discovery_source', 50);
    t.index('discovery_source');
  });

  await knex('seo_backlinks')
    .whereNull('discovery_source')
    .where('notes', 'like', '%GSC Links exports do not include%')
    .update({ discovery_source: 'gsc_links_export' });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('seo_backlinks');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('seo_backlinks', 'discovery_source');
  if (!hasColumn) return;

  await knex.schema.alterTable('seo_backlinks', (t) => {
    t.dropColumn('discovery_source');
  });
};
