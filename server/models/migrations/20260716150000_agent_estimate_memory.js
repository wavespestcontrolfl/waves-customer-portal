exports.up = async function up(knex) {
  if (await knex.schema.hasTable('agent_estimate_memory')) return;
  await knex.schema.createTable('agent_estimate_memory', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('rule_text').notNullable();
    table.text('rationale');
    table.string('status', 20).notNullable().defaultTo('pending');
    table.integer('version').notNullable().defaultTo(1);
    table.uuid('source_lead_id').references('id').inTable('leads').onDelete('SET NULL');
    table.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
    table.uuid('reviewed_by').references('id').inTable('technicians').onDelete('SET NULL');
    table.timestamp('reviewed_at');
    table.timestamps(true, true);
    table.index(['status', 'created_at']);
  });
  await knex.raw(`
    ALTER TABLE agent_estimate_memory
    ADD CONSTRAINT agent_estimate_memory_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'retired'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('agent_estimate_memory');
};
