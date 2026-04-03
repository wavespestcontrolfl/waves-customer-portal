exports.up = async function (knex) {
  await knex.schema.createTable('push_subscriptions', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').references('id').inTable('customers');
    t.uuid('admin_user_id').references('id').inTable('technicians');
    t.string('role', 20); // customer, admin, technician
    t.text('subscription_data').notNullable();
    t.string('device_info', 100);
    t.boolean('active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('customer_id');
    t.index('admin_user_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('push_subscriptions');
};
