exports.up = async function up(knex) {
  if (await knex.schema.hasTable('agent_ops_task_states')) return;

  await knex.schema.createTable('agent_ops_task_states', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('task_id', 180).notNullable();
    t.string('fingerprint', 80).notNullable();
    t.string('status', 20).notNullable(); // done | dismissed
    t.string('agent_id', 80).notNullable();
    t.string('source', 80).notNullable();
    t.string('source_id', 120);
    t.text('title');
    t.text('note');
    t.string('handled_by', 120);
    t.uuid('handled_by_technician_id').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('handled_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.jsonb('snapshot').notNullable().defaultTo('{}');
    t.timestamps(true, true);

    t.unique(['task_id', 'fingerprint']);
    t.index(['status', 'handled_at']);
    t.index(['agent_id', 'handled_at']);
    t.index(['source', 'source_id']);
  });

  await knex.raw(`
    ALTER TABLE agent_ops_task_states
      ADD CONSTRAINT agent_ops_task_states_status_check
      CHECK (status IN ('done', 'dismissed'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('agent_ops_task_states');
};
