exports.up = async function (knex) {
  await knex.schema.createTable('review_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').references('id').inTable('customers');
    t.string('token', 64).unique().notNullable();
    t.string('location_id', 30);
    t.string('tech_name', 100);
    t.string('service_type', 100);
    t.date('service_date');
    t.integer('score'); // 1-10 NPS
    t.text('feedback');
    t.jsonb('highlights'); // selected highlight chips
    t.string('category', 20); // promoter / passive / detractor
    t.boolean('google_review_clicked').defaultTo(false);
    t.string('status', 20).defaultTo('pending'); // pending, submitted, reviewed
    t.timestamp('submitted_at');
    t.timestamp('sent_at'); // when SMS was sent
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('expires_at');

    t.index('token');
    t.index('customer_id');
    t.index('location_id');
    t.index('status');
    t.index('category');
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('review_requests');
};
