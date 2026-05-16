exports.up = async function up(knex) {
  if (await knex.schema.hasTable('service_report_events')) return;

  await knex.schema.createTable('service_report_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('service_record_id')
      .notNullable()
      .references('id')
      .inTable('service_records')
      .onDelete('CASCADE');
    t.uuid('customer_id')
      .references('id')
      .inTable('customers')
      .onDelete('SET NULL');
    t.string('event_name', 80).notNullable();
    t.string('channel', 40).notNullable();
    t.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.text('user_agent');
    t.string('ip_hash', 64);
    t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);
  });

  await knex.raw(`
    CREATE INDEX idx_service_report_events_record_time
    ON service_report_events (service_record_id, occurred_at DESC)
  `);

  await knex.raw(`
    CREATE INDEX idx_service_report_events_name_time
    ON service_report_events (event_name, occurred_at DESC)
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_service_report_events_name_time');
  await knex.raw('DROP INDEX IF EXISTS idx_service_report_events_record_time');
  await knex.schema.dropTableIfExists('service_report_events');
};
