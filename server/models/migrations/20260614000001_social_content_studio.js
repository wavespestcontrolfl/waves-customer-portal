exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('review_graphics'))) {
    await knex.schema.createTable('review_graphics', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('google_review_id').notNullable().references('id').inTable('google_reviews').onDelete('CASCADE');
      t.string('status', 24).notNullable().defaultTo('draft');
      t.string('privacy_mode', 40).notNullable().defaultTo('first_name_city');
      t.string('reviewer_display_name', 120).notNullable();
      t.string('location_id', 40);
      t.string('city', 80);
      t.text('excerpt').notNullable();
      t.text('caption');
      t.string('template_key', 60).notNullable().defaultTo('waves_clean_square');
      t.string('image_url', 1000);
      t.jsonb('channels').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('render_settings').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('approved_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('approved_at');
      t.uuid('social_media_post_id').references('id').inTable('social_media_posts').onDelete('SET NULL');
      t.timestamps(true, true);

      t.index('google_review_id');
      t.index('status');
      t.index('location_id');
      t.unique(['google_review_id', 'template_key']);
    });
  }
  if (
    await knex.schema.hasTable('review_graphics') &&
    !(await knex.schema.hasColumn('review_graphics', 'image_url'))
  ) {
    await knex.schema.alterTable('review_graphics', (t) => {
      t.string('image_url', 1000);
    });
  }

  if (!(await knex.schema.hasTable('competitor_social_profiles'))) {
    await knex.schema.createTable('competitor_social_profiles', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('company_name', 180).notNullable().unique();
      t.integer('pct_rank');
      t.integer('revenue_rank');
      t.integer('growth_pct');
      t.string('city', 100);
      t.string('state', 40);
      t.string('source_label', 120).notNullable().defaultTo('PCT 2026 Top 100');
      t.jsonb('profile_urls').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('strategic_notes').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);

      t.index('pct_rank');
      t.index('growth_pct');
      t.index('active');
    });
  }

  if (!(await knex.schema.hasTable('competitor_social_posts'))) {
    await knex.schema.createTable('competitor_social_posts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('profile_id').references('id').inTable('competitor_social_profiles').onDelete('SET NULL');
      t.string('company_name', 180).notNullable();
      t.string('platform', 30).notNullable();
      t.string('profile_url', 1000);
      t.string('post_url', 1000);
      t.date('post_date');
      t.string('topic', 180);
      t.string('hook_type', 80);
      t.string('creative_format', 80);
      t.integer('likes_count').notNullable().defaultTo(0);
      t.integer('comments_count').notNullable().defaultTo(0);
      t.integer('shares_count').notNullable().defaultTo(0);
      t.integer('views_count').notNullable().defaultTo(0);
      t.integer('engagement_score').notNullable().defaultTo(0);
      t.text('visible_text');
      t.text('why_it_worked');
      t.text('copyable_pattern');
      t.string('source', 40).notNullable().defaultTo('manual');
      t.timestamps(true, true);

      t.index('company_name');
      t.index('platform');
      t.index('engagement_score');
      t.index('created_at');
    });
  }

  if (!(await knex.schema.hasTable('social_content_studio_runs'))) {
    await knex.schema.createTable('social_content_studio_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('run_type', 40).notNullable().defaultTo('autonomous');
      t.string('status', 30).notNullable().defaultTo('started');
      t.string('mode', 40);
      t.string('topic', 180);
      t.string('city', 100);
      t.string('service', 100);
      t.string('angle', 100);
      t.jsonb('channels').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('input').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('preview').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('publish_result').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.text('skip_reason');
      t.uuid('social_media_post_id').references('id').inTable('social_media_posts').onDelete('SET NULL');
      t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('finished_at');
      t.timestamps(true, true);

      t.index('run_type');
      t.index('status');
      t.index('mode');
      t.index('started_at');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('social_content_studio_runs');
  await knex.schema.dropTableIfExists('competitor_social_posts');
  await knex.schema.dropTableIfExists('competitor_social_profiles');
  await knex.schema.dropTableIfExists('review_graphics');
};
