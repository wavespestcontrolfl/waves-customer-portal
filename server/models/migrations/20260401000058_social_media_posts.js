exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await knex.schema.createTable('social_media_posts', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('title', 500);
    t.text('description');
    t.string('source_url', 1000);
    t.string('source_guid', 500);
    t.string('source_type', 30).defaultTo('manual'); // 'rss', 'manual', 'scheduled'
    t.jsonb('platforms_posted').defaultTo('[]');
    t.string('image_url', 1000);
    t.string('status', 20).defaultTo('draft'); // 'draft', 'published', 'failed', 'scheduled'
    t.timestamp('scheduled_for');
    t.timestamp('published_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('source_url');
    t.index('source_guid');
    t.index('status');
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('social_media_posts');
};
