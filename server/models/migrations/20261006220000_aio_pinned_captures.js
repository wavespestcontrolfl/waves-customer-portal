/**
 * AI Overview pilot, PR 1: pinned-query captures.
 *
 * seo_llm_mention_queries gains three pin columns. A pinned query gets a full
 * AI Overview SERP capture twice a day (desktop + mobile) in addition to the
 * once-a-day probe in seo_llm_mentions. seo_aio_captures keeps every attempt:
 * the overview text, the cited elements and references, the organic top 10,
 * People Also Ask and the local pack, so a changing overview can be read over
 * time. seo_llm_mentions (unique per query, platform, day) is not touched.
 */
exports.up = async function up(knex) {
  for (const [col, add] of [
    ['pin_daily', (t) => t.boolean('pin_daily').notNullable().defaultTo(false)],
    ['pin_until', (t) => t.date('pin_until')],
    ['pin_location', (t) => t.text('pin_location')],
  ]) {
    if (!(await knex.schema.hasColumn('seo_llm_mention_queries', col))) {
      await knex.schema.alterTable('seo_llm_mention_queries', add);
    }
  }

  if (!(await knex.schema.hasTable('seo_aio_captures'))) {
    await knex.schema.createTable('seo_aio_captures', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('query_id').notNullable().references('id').inTable('seo_llm_mention_queries').onDelete('CASCADE');
      t.text('query').notNullable();
      t.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('pass'); // 'am' | 'pm'
      t.text('device'); // 'desktop' | 'mobile'
      t.text('location');
      t.text('status').notNullable(); // shown | none | task_error | request_error
      t.text('answer_markdown');
      t.jsonb('elements'); // [{title, text, urls: []}] one per ai_overview_element
      t.jsonb('aio_references'); // [{url, title, domain, text}] top-level aio.references (not 'references': reserved word)
      t.jsonb('organic_top'); // top 10 organic: rank_absolute, rank_group, url, domain, title
      t.jsonb('paa'); // People Also Ask questions
      t.jsonb('local_pack'); // [{title, domain, rating, rank_group}]
      t.jsonb('raw_item'); // full ai_overview item (task error detail on task_error)
      t.text('check_url');
      t.text('se_datetime');
      t.decimal('cost_usd', 10, 5);
      t.boolean('waves_cited');
      t.index(['query_id', 'captured_at'], 'idx_aio_captures_query_time');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('seo_aio_captures');
  for (const col of ['pin_location', 'pin_until', 'pin_daily']) {
    if (await knex.schema.hasColumn('seo_llm_mention_queries', col)) {
      await knex.schema.alterTable('seo_llm_mention_queries', (t) => t.dropColumn(col));
    }
  }
};
