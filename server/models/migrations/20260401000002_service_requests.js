exports.up = async function (knex) {
  await knex.schema.createTable('service_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers');
    t.string('category').notNullable();
    t.string('subject').notNullable();
    t.text('description');
    t.string('status').defaultTo('open');
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('service_requests');
};
