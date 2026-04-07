exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('badge_reward_queue');
  if (!exists) {
    await knex.schema.createTable('badge_reward_queue', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.varchar('badge_type', 50).notNullable();
      t.varchar('reward_type', 50);
      t.text('reward_description');
      t.decimal('reward_amount', 10, 2);
      t.varchar('status', 20).defaultTo('pending');
      t.timestamp('fulfilled_at', { useTz: true });
      t.varchar('fulfilled_by', 100);
      t.text('notes');
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.unique(['customer_id', 'badge_type']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('badge_reward_queue');
};
