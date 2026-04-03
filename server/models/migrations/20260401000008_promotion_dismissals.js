/**
 * Promotion Dismissals — tracks which promos a customer has hidden
 */
exports.up = async function (knex) {
  await knex.schema.createTable('promotion_dismissals', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('promotion_id', 50).notNullable();
    t.timestamp('dismissed_at').defaultTo(knex.fn.now());
    t.timestamps(true, true);

    t.unique(['customer_id', 'promotion_id']);
    t.index('customer_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('promotion_dismissals');
};
