/**
 * Migration 053 — Backlink Agent tables
 * Automated profile signup system for backlink building
 */
exports.up = async function (knex) {
  // X/Twitter accounts to monitor
  await knex.schema.createTable('backlink_agent_targets', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('x_username').notNullable().unique();
    t.string('x_user_id');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('last_polled_at');
    t.string('last_tweet_id');
    t.timestamps(true, true);
  });

  // URL processing queue
  await knex.schema.createTable('backlink_agent_queue', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('url').notNullable();
    t.text('original_url');
    t.string('source').notNullable().defaultTo('manual');
    t.string('source_detail');
    t.string('status').notNullable().defaultTo('pending');
    t.text('error_message');
    t.string('domain').notNullable();
    t.text('screenshot_url');
    t.timestamps(true, true);
    t.unique('domain');
    t.index('status');
  });

  // Completed signup profiles
  await knex.schema.createTable('backlink_agent_profiles', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('queue_id').references('id').inTable('backlink_agent_queue');
    t.text('site_url').notNullable();
    t.text('profile_url');
    t.string('username_used');
    t.string('email_used');
    t.text('password_used');
    t.string('backlink_url').defaultTo('https://wavespestcontrol.com');
    t.string('backlink_status').defaultTo('unknown');
    t.boolean('is_dofollow');
    t.integer('domain_authority');
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('backlink_agent_profiles');
  await knex.schema.dropTableIfExists('backlink_agent_queue');
  await knex.schema.dropTableIfExists('backlink_agent_targets');
};
