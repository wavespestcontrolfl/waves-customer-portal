exports.up = async function (knex) {
  await knex.schema.createTable('seo_actions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Source links
    t.uuid('url_intelligence_id').references('id').inTable('seo_url_intelligence').onDelete('SET NULL');
    t.uuid('diagnosis_id').references('id').inTable('seo_diagnoses').onDelete('SET NULL');

    // Target
    t.text('url').notNullable();
    t.string('domain', 200);
    t.string('city', 40);
    t.string('service', 40);

    // Classification
    t.string('issue_type', 40).notNullable();
    t.string('action_type', 60).notNullable();

    // Description
    t.text('summary');
    t.jsonb('detail').defaultTo('{}');

    // Scoring
    t.integer('priority_score').notNullable().defaultTo(0);
    t.decimal('impact_score', 6, 2);
    t.decimal('effort_score', 6, 2);

    // Approval
    t.string('approval_tier', 20).notNullable().defaultTo('review');
    t.string('approval_status', 20).notNullable().defaultTo('pending');
    t.uuid('approved_by_admin_id').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('approved_at');
    t.text('approval_notes');

    // Execution
    t.string('execution_status', 20).notNullable().defaultTo('queued');
    t.string('executor', 40);
    t.timestamp('started_at');
    t.timestamp('completed_at');
    t.text('execution_notes');

    // AI draft
    t.jsonb('ai_draft');
    t.string('ai_model', 60);

    // Experiment link
    t.uuid('experiment_id').references('id').inTable('seo_url_experiments').onDelete('SET NULL');

    // Batch grouping
    t.uuid('batch_id');
    t.string('batch_label', 100);

    // Dedupe
    t.string('dedupe_key', 200);

    // State
    t.string('status', 20).notNullable().defaultTo('open');

    t.timestamps(true, true);

    t.index('url');
    t.index('domain');
    t.index('issue_type');
    t.index('action_type');
    t.index('approval_tier');
    t.index('approval_status');
    t.index('execution_status');
    t.index('priority_score');
    t.index('batch_id');
    t.index('status');
    t.index('dedupe_key');
    t.index(['status', 'approval_tier', 'priority_score']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_actions');
};
