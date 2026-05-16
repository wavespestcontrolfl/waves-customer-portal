exports.up = async function up(knex) {
  if (await knex.schema.hasTable('service_report_ai_summaries')) return;

  await knex.schema.createTable('service_report_ai_summaries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('service_record_id')
      .notNullable()
      .references('id')
      .inTable('service_records')
      .onDelete('CASCADE');
    t.text('input_hash').notNullable();
    t.text('prompt_version').notNullable();
    t.text('model');
    t.string('status', 30).notNullable().defaultTo('generated');
    t.jsonb('summary_json').notNullable();
    t.jsonb('validation_json').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('generated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('reviewed_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('reviewed_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['service_record_id', 'input_hash', 'prompt_version'], 'uniq_service_report_ai_summary_input');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('service_report_ai_summaries');
};
