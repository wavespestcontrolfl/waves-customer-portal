/**
 * Tool health event log — powers the Tool Health dashboard.
 * One row per tool invocation across admin intelligence bar, voice agent,
 * and lead response agent. Kept lean — errors get the detail, successes
 * just need to count.
 */
exports.up = async function(knex) {
  await knex.schema.createTable('tool_health_events', t => {
    t.bigIncrements('id').primary();
    t.string('source', 32).notNullable();          // 'intelligence-bar' | 'voice-agent' | 'lead-response-agent'
    t.string('context', 48).nullable();             // intelligence bar context: 'dashboard', 'schedule', etc.
    t.string('tool_name', 64).notNullable();
    t.boolean('success').notNullable().defaultTo(true);
    t.integer('duration_ms').nullable();
    t.boolean('circuit_open').notNullable().defaultTo(false);
    t.text('error_message').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['created_at']);
    t.index(['source', 'created_at']);
    t.index(['tool_name', 'success']);
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('tool_health_events');
};
