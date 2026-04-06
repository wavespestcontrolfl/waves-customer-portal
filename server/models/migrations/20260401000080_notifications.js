exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('notifications');
  if (!exists) {
    await knex.schema.createTable('notifications', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.varchar('recipient_type', 20).notNullable(); // 'admin' or 'customer'
      t.uuid('recipient_id').nullable(); // customer_id for customer notifications, null for admin
      t.varchar('category', 30).notNullable(); // 'inbound_sms', 'approval', 'new_lead', etc.
      t.varchar('title', 200).notNullable();
      t.text('body').nullable();
      t.varchar('icon', 10).nullable(); // emoji icon
      t.varchar('link', 300).nullable(); // URL path to navigate to when tapped
      t.jsonb('metadata').nullable(); // extra data (customerId, estimateId, etc.)
      t.timestamp('read_at', { useTz: true }).nullable(); // null means unread
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    });

    await knex.schema.table('notifications', (t) => {
      t.index(['recipient_type', 'recipient_id', 'read_at']);
      t.index(['created_at']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('notifications');
};
