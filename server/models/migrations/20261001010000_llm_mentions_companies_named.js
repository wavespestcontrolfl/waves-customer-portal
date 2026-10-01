/**
 * seo_llm_mentions.companies_named / rank_method — rank Waves against every
 * company an answer names, not only the hard-coded competitor list.
 *
 *   companies_named  jsonb  ordered [{ name }] of every company the answer
 *                           named (Waves included, at its position)
 *   rank_method      text   how rank_position was computed:
 *                             'all_named_v2'   place in companies_named
 *                             NULL             a row from before this column;
 *                                              read as 'known_list_v1' (place
 *                                              among Waves + the COMPETITORS
 *                                              list only)
 *
 * No backfill: old answers are not re-ranked, and the dashboard labels which
 * method a rate mixes instead. Idempotent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('seo_llm_mentions'))) return;
  if (!(await knex.schema.hasColumn('seo_llm_mentions', 'companies_named'))) {
    await knex.schema.alterTable('seo_llm_mentions', (t) => { t.jsonb('companies_named'); });
  }
  if (!(await knex.schema.hasColumn('seo_llm_mentions', 'rank_method'))) {
    await knex.schema.alterTable('seo_llm_mentions', (t) => { t.text('rank_method'); });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('seo_llm_mentions'))) return;
  for (const column of ['companies_named', 'rank_method']) {
    if (await knex.schema.hasColumn('seo_llm_mentions', column)) {
      await knex.schema.alterTable('seo_llm_mentions', (t) => { t.dropColumn(column); });
    }
  }
};
