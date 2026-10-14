/**
 * AI Overview pilot, PR 2: the gap sweep.
 *
 * One sweep run checks every candidate search a customer makes (Search Console
 * queries, competitor-gap queries, managed questions) once on a mobile SERP and
 * stores what Google's AI Overview said and whom it cited, so the searches
 * where an overview shows and Waves is not cited can be ranked.
 *
 * seo_aio_sweep_runs: one row per sweep, with its cost cap and running cost.
 * seo_aio_sweep_results: one row per candidate search in a run, written as
 * 'pending' when the run starts and filled in by the 10-minute chunk job.
 * A partial unique index allows only one 'open' run at a time.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('seo_aio_sweep_runs'))) {
    await knex.schema.createTable('seo_aio_sweep_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('started_at', { useTz: true });
      t.timestamp('finished_at', { useTz: true });
      t.text('status').notNullable().defaultTo('open'); // open | done | stopped_budget | cancelled
      t.text('trigger').notNullable().defaultTo('manual'); // manual | monthly
      t.integer('planned').notNullable().defaultTo(0);
      t.integer('attempted').notNullable().defaultTo(0);
      t.decimal('cost_usd', 10, 4).notNullable().defaultTo(0);
      t.decimal('max_cost_usd', 10, 2);
      t.jsonb('source_counts'); // {gsc, competitor_gap, managed, total}
      t.text('notes');
    });
  }
  await knex.raw("CREATE UNIQUE INDEX IF NOT EXISTS seo_aio_sweep_runs_one_open ON seo_aio_sweep_runs ((1)) WHERE status = 'open'");

  if (!(await knex.schema.hasTable('seo_aio_sweep_results'))) {
    await knex.schema.createTable('seo_aio_sweep_results', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('run_id').notNullable().references('id').inTable('seo_aio_sweep_runs').onDelete('CASCADE');
      t.text('query').notNullable();
      t.jsonb('sources'); // ['gsc' | 'competitor_gap' | 'managed']
      t.text('city');
      t.text('location'); // "lat,lng" coordinate handed to DataForSEO
      t.integer('impressions_90d');
      t.integer('clicks_90d');
      t.decimal('gsc_position', 8, 2);
      t.text('status').notNullable().defaultTo('pending'); // pending | shown | none | task_error | request_error
      t.boolean('aio_shown');
      t.text('citation_kind'); // web | map_cards | mixed
      t.boolean('waves_cited'); // a Waves URL is attached to an answer element
      t.boolean('waves_in_references'); // a Waves URL is in the top-level references (possible source)
      t.boolean('waves_named'); // the overview text names Waves
      t.integer('waves_organic_rank'); // first Waves URL in the organic top 10
      t.text('answer_markdown');
      t.jsonb('elements');
      t.jsonb('aio_references');
      t.jsonb('organic_top');
      t.jsonb('paa');
      t.jsonb('local_pack');
      t.text('check_url');
      t.decimal('cost_usd', 10, 4);
      t.text('error'); // why a row failed (request_error / task_error)
      t.timestamp('captured_at', { useTz: true });
      t.unique(['run_id', 'query']);
      t.index(['run_id', 'status']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('seo_aio_sweep_results');
  await knex.raw('DROP INDEX IF EXISTS seo_aio_sweep_runs_one_open');
  await knex.schema.dropTableIfExists('seo_aio_sweep_runs');
};
