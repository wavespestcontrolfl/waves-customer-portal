/**
 * Intelligence Bar — query log table
 */
exports.up = async function(knex) {
  await knex.schema.createTable('intelligence_bar_queries', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('prompt').notNullable();
    t.text('response');
    t.jsonb('tool_calls').defaultTo('[]');
    t.string('operator_id').nullable(); // future: who ran the query
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('intelligence_bar_queries');
};
