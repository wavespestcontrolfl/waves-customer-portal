exports.up = async function (knex) {
  await knex.schema.createTable('activity_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('admin_user_id').references('id').inTable('technicians');
    t.uuid('customer_id').references('id').inTable('customers');
    t.uuid('estimate_id').references('id').inTable('estimates');
    t.string('action', 50).notNullable();
    t.text('description');
    t.jsonb('metadata');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('action');
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('activity_log');
};
