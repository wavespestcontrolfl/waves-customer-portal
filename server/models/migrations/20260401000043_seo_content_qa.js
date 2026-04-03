exports.up = async function (knex) {
  await knex.schema.createTable('seo_content_qa_scores', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('blog_post_id').references('id').inTable('blog_posts').onDelete('SET NULL');
    t.text('url');
    t.integer('total_score'); // 0-50
    t.string('grade'); // A, B, C, D, F
    t.integer('technical_score'); // /12
    t.integer('onpage_score'); // /10
    t.integer('eeat_score'); // /8
    t.integer('local_score'); // /10
    t.integer('brand_score'); // /10
    t.jsonb('checklist_results');
    t.string('recommendation'); // PUBLISH, REVIEW, REVISE, REJECT
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_content_qa_scores');
};
