exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('seo_target_keywords');
  if (!hasTable) return; // Table created in migration 040

  const cols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'seo_target_keywords'");
  const existing = cols.rows.map(r => r.column_name);

  await knex.schema.alterTable('seo_target_keywords', t => {
    if (!existing.includes('current_position')) t.integer('current_position');
    if (!existing.includes('best_position')) t.integer('best_position');
    if (!existing.includes('has_content')) t.boolean('has_content').defaultTo(false);
    if (!existing.includes('content_url')) t.string('content_url', 500);
    if (!existing.includes('search_volume')) t.integer('search_volume');
    if (!existing.includes('difficulty')) t.integer('difficulty').defaultTo(0);
    if (!existing.includes('status')) t.string('status', 20).defaultTo('new');
    if (!existing.includes('notes')) t.text('notes');
  });
};
exports.down = async function (knex) {
  try {
    await knex.schema.alterTable('seo_target_keywords', t => {
      t.dropColumn('current_position'); t.dropColumn('best_position');
      t.dropColumn('has_content'); t.dropColumn('content_url');
      t.dropColumn('search_volume'); t.dropColumn('difficulty');
      t.dropColumn('status'); t.dropColumn('notes');
    });
  } catch {}
};
