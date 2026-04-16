exports.up = function(knex) {
  return knex.schema.createTable('newsletter_subscribers', (t) => {
    t.increments('id').primary();
    t.string('email').notNullable().unique();
    t.string('source').defaultTo('website');
    t.string('status').defaultTo('active');
    t.timestamp('subscribed_at').defaultTo(knex.fn.now());
    t.timestamp('resubscribed_at');
    t.timestamp('unsubscribed_at');
    t.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('newsletter_subscribers');
};
