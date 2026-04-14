exports.up = async function (knex) {
  await knex.schema.createTable('blocked_email_senders', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('email_address');
    t.text('domain');
    t.text('gmail_filter_id');
    t.text('reason').defaultTo('spam_auto');
    t.integer('blocked_count').defaultTo(1);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('domain');
    t.index('email_address');
  });

  await knex.schema.createTable('email_unsubscribe_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('email_id').references('id').inTable('emails').onDelete('SET NULL');
    t.text('from_domain');
    t.text('unsubscribe_method');
    t.text('unsubscribe_url');
    t.text('status').defaultTo('attempted');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('from_domain');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('email_unsubscribe_log');
  await knex.schema.dropTableIfExists('blocked_email_senders');
};
