exports.up = async function up(knex) {
  await knex.schema.createTable('lawn_protocol_readiness_snapshots', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.date('snapshot_date').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
    table.date('scan_start_date');
    table.date('scan_end_date');
    table.integer('days').notNullable().defaultTo(14);
    table.integer('appointment_count').notNullable().defaultTo(0);
    table.integer('ready_count').notNullable().defaultTo(0);
    table.integer('warning_count').notNullable().defaultTo(0);
    table.integer('blocked_count').notNullable().defaultTo(0);
    table.uuid('generated_by').references('id').inTable('technicians').onDelete('SET NULL');
    table.string('generated_by_name', 160);
    table.string('source', 80).notNullable().defaultTo('manual_admin');
    table.jsonb('summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    table.jsonb('appointments').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    table.timestamps(true, true);

    table.index(['snapshot_date']);
    table.index(['created_at']);
    table.index(['scan_start_date', 'scan_end_date']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lawn_protocol_readiness_snapshots');
};
