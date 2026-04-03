exports.up = async function (knex) {
  await knex.schema.createTable('seo_serp_analyses', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('keyword_id').references('id').inTable('seo_target_keywords').onDelete('CASCADE');
    t.date('analysis_date').notNullable();
    t.jsonb('top_10_results');
    t.jsonb('map_pack_results');
    t.string('dominant_page_type');
    t.jsonb('content_length_consensus');
    t.jsonb('required_schema');
    t.jsonb('serp_features_present');
    t.integer('difficulty_score');
    t.text('recommendation');
    t.jsonb('content_consensus_brief');
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_serp_analyses');
};
