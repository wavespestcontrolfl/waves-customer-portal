/**
 * Content Registry Foundation.
 *
 * The registry is a reconciled read model, not a CMS source of truth.
 * Astro/frontmatter, DB workflow rows, and future live-site checks feed it;
 * operators use it to see where those sources agree or disagree.
 */

exports.up = async function (knex) {
  const hasRuns = await knex.schema.hasTable('content_registry_sync_runs');
  if (!hasRuns) {
    await knex.schema.createTable('content_registry_sync_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('mode', 20).notNullable().defaultTo('dry_run');
      t.string('status', 20).notNullable().defaultTo('running');
      t.text('astro_root');
      t.string('astro_repo_sha', 80);
      t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('completed_at');
      t.integer('astro_files_scanned').notNullable().defaultTo(0);
      t.integer('db_rows_scanned').notNullable().defaultTo(0);
      t.integer('matched_count').notNullable().defaultTo(0);
      t.integer('astro_only_count').notNullable().defaultTo(0);
      t.integer('db_only_count').notNullable().defaultTo(0);
      t.integer('db_published_missing_astro_count').notNullable().defaultTo(0);
      t.integer('conflict_count').notNullable().defaultTo(0);
      t.integer('changed_count').notNullable().defaultTo(0);
      t.integer('error_count').notNullable().defaultTo(0);
      t.jsonb('summary').notNullable().defaultTo('{}');
      t.text('failure_message');
      t.timestamps(true, true);

      t.index('status');
      t.index('started_at');
      t.index('astro_repo_sha');
    });
  }

  const hasRegistry = await knex.schema.hasTable('content_registry');
  if (!hasRegistry) {
    await knex.schema.createTable('content_registry', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('canonical_url');
      t.text('canonical_url_normalized');
      t.text('live_url');
      t.string('slug', 300);
      t.text('astro_source_path');
      t.uuid('db_blog_id').references('id').inTable('blog_posts').onDelete('SET NULL');
      t.string('content_type', 60).notNullable().defaultTo('unknown');
      t.string('source', 60).notNullable().defaultTo('unknown');
      t.string('workflow_status', 60).notNullable().defaultTo('unknown');
      t.string('astro_status', 30).notNullable().defaultTo('unknown');
      t.string('db_status', 30).notNullable().defaultTo('unknown');
      t.string('sitemap_status', 30).notNullable().defaultTo('unknown');
      t.string('http_status', 30).notNullable().defaultTo('unknown');
      t.string('live_status', 30).notNullable().defaultTo('unknown');
      t.string('reconciliation_status', 80).notNullable().defaultTo('unknown');
      t.text('title');
      t.text('h1');
      t.text('meta_description');
      t.text('target_keyword');
      t.string('target_city', 80);
      t.string('target_service', 80);
      t.string('category', 120);
      t.string('author', 120);
      t.string('reviewer', 120);
      t.timestamp('published_at');
      t.timestamp('last_updated_at');
      t.timestamp('last_synced_at');
      t.uuid('sync_run_id').references('id').inTable('content_registry_sync_runs').onDelete('SET NULL');
      t.string('astro_repo_sha', 80);
      t.string('astro_frontmatter_hash', 64);
      t.string('astro_body_hash', 64);
      t.string('astro_file_hash', 64);
      t.string('db_row_hash', 64);
      t.string('registry_hash', 64);
      t.text('redirect_target_url');
      t.text('canonical_target_url');
      t.boolean('noindex_detected').notNullable().defaultTo(false);
      t.boolean('sitemap_present');
      t.string('match_confidence', 30);
      t.jsonb('mismatch_reasons').notNullable().defaultTo('[]');
      t.jsonb('metadata').notNullable().defaultTo('{}');
      t.timestamps(true, true);

      t.index('canonical_url_normalized');
      t.index('reconciliation_status');
      t.index('live_status');
      t.index('content_type');
      t.index('last_synced_at');
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS content_registry_astro_source_path_unique
      ON content_registry (astro_source_path)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS content_registry_db_blog_id_unique
      ON content_registry (db_blog_id)
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS content_registry_db_blog_id_unique');
  await knex.raw('DROP INDEX IF EXISTS content_registry_astro_source_path_unique');
  await knex.schema.dropTableIfExists('content_registry');
  await knex.schema.dropTableIfExists('content_registry_sync_runs');
};
