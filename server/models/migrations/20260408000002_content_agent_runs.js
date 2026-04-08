/**
 * Content Agent run tracking table.
 * Logs each autonomous content generation session.
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('content_agent_runs');
  if (exists) return;

  await knex.schema.createTable('content_agent_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.string('session_id', 100);
    t.uuid('blog_post_id').references('id').inTable('blog_posts');
    t.string('topic', 500);
    t.string('city', 100);
    t.string('status', 30); // drafted, published, failed
    t.jsonb('tools_executed');
    t.integer('qa_score');
    t.integer('word_count');
    t.integer('duration_seconds');
    t.text('report');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('session_id');
    t.index('blog_post_id');
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('content_agent_runs');
};
