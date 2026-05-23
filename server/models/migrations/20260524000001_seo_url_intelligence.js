exports.up = async function (knex) {
  await knex.schema.createTable('seo_url_intelligence', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // URL Identity
    t.text('url').notNullable().unique();
    t.string('domain', 200).notNullable();
    t.string('hub_or_spoke', 10);
    t.string('page_type', 40);
    t.string('city', 40);
    t.string('service', 40);
    t.string('template_type', 40);

    // Classification
    t.string('intended_query_cluster', 200);
    t.string('pest_category', 60);

    // Status & Diagnosis
    t.string('primary_status', 40).notNullable().defaultTo('unknown');
    t.string('primary_diagnosis', 40).notNullable().defaultTo('unknown');

    // Canonical
    t.text('user_declared_canonical');
    t.text('google_selected_canonical');
    t.boolean('canonical_match');

    // Indexation
    t.string('index_status', 60);
    t.string('coverage_state', 60);
    t.string('indexing_state', 60);
    t.boolean('in_sitemap');

    // Technical
    t.integer('status_code');
    t.string('robots_directive', 60);
    t.text('redirect_target');

    // Content
    t.string('content_hash', 32);
    t.integer('word_count');
    t.text('title');
    t.text('meta_description');
    t.text('h1');

    // Links
    t.integer('internal_links_in').defaultTo(0);
    t.integer('internal_links_out').defaultTo(0);
    t.integer('backlinks_count').defaultTo(0);

    // GSC Performance (28d rolling)
    t.integer('gsc_clicks_28d').defaultTo(0);
    t.integer('gsc_impressions_28d').defaultTo(0);
    t.decimal('gsc_ctr_28d', 8, 4);
    t.decimal('gsc_avg_position_28d', 8, 2);

    // Scores
    t.integer('technical_qa_score');
    t.integer('content_qa_score');
    t.integer('local_qa_score');
    t.integer('priority_score').notNullable().defaultTo(0);

    // Actions
    t.text('recommended_action');
    t.text('alternative_action');
    t.string('approval_level', 20);

    // Duplicate detection
    t.uuid('duplicate_cluster_id');
    t.decimal('body_similarity_max', 5, 2);

    // Timestamps
    t.timestamp('last_audit_at');
    t.timestamp('last_gsc_sync_at');
    t.timestamp('last_inspection_at');
    t.timestamp('last_refreshed_at');
    t.timestamps(true, true);

    t.index('domain');
    t.index('primary_status');
    t.index('primary_diagnosis');
    t.index('priority_score');
    t.index(['domain', 'primary_status']);
    t.index(['domain', 'primary_diagnosis']);
    t.index('hub_or_spoke');
    t.index('content_hash');
    t.index('duplicate_cluster_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_url_intelligence');
};
