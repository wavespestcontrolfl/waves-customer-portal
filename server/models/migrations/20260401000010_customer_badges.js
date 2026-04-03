exports.up = async function (knex) {
  await knex.schema.createTable('customer_badges', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('badge_type', 50).notNullable();
    t.timestamp('earned_at').defaultTo(knex.fn.now());
    t.boolean('notified').defaultTo(false);
    t.timestamps(true, true);

    t.unique(['customer_id', 'badge_type']);
    t.index('customer_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customer_badges');
};
