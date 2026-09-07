/** Separate attributed citations from source pools; preserve historical evidence. */
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('seo_llm_mentions')) return;
  const columns = {
    measurement_version: t => t.integer('measurement_version'),
    answer_available: t => t.boolean('answer_available'),
    citations_complete: t => t.boolean('citations_complete'),
    source_urls: t => t.jsonb('source_urls'),
  };
  for (const [name, add] of Object.entries(columns)) {
    if (!await knex.schema.hasColumn('seo_llm_mentions', name)) {
      await knex.schema.alterTable('seo_llm_mentions', add);
    }
  }
  if (await knex.schema.hasTable('content_optimization_impact')
    && !await knex.schema.hasColumn('content_optimization_impact', 'aeo_measurement_version')) {
    await knex.schema.alterTable('content_optimization_impact', t => t.integer('aeo_measurement_version'));
  }
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('seo_llm_mentions')) return;
  for (const name of ['measurement_version', 'answer_available', 'citations_complete', 'source_urls']) {
    if (await knex.schema.hasColumn('seo_llm_mentions', name)) {
      await knex.schema.alterTable('seo_llm_mentions', t => t.dropColumn(name));
    }
  }
  if (await knex.schema.hasTable('content_optimization_impact')
    && await knex.schema.hasColumn('content_optimization_impact', 'aeo_measurement_version')) {
    await knex.schema.alterTable('content_optimization_impact', t => t.dropColumn('aeo_measurement_version'));
  }
};
