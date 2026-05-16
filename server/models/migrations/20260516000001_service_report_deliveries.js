/**
 * Durable delivery queue for service report v1.
 *
 * Completion should finish quickly and survive provider/PDF failures. This
 * queue lets the scheduler retry report email delivery without asking the tech
 * to re-complete the visit.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('service_report_deliveries')) return;

  await knex.schema.createTable('service_report_deliveries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
    t.string('channel', 20).notNullable(); // email | sms; v1 starts with email
    t.string('report_template_version', 60).notNullable().defaultTo('service_report_v1');
    t.string('status', 20).notNullable().defaultTo('queued'); // queued | sending | sent | skipped | failed | cancelled
    t.text('report_token');
    t.text('report_url');
    t.text('pdf_url');
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(5);
    t.timestamp('next_attempt_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_attempt_at');
    t.timestamp('locked_at');
    t.timestamp('sent_at');
    t.timestamp('skipped_at');
    t.timestamp('failed_at');
    t.text('provider_message_id');
    t.text('last_error');
    t.timestamps(true, true);

    t.unique(['service_record_id', 'channel', 'report_template_version'], 'service_report_deliveries_once_per_channel');
    t.index(['service_record_id']);
    t.index(['customer_id', 'created_at']);
  });

  await knex.raw(`
    CREATE INDEX service_report_deliveries_due_idx
    ON service_report_deliveries (next_attempt_at, created_at)
    WHERE status = 'queued'
  `);

  await knex.raw(`
    CREATE INDEX service_report_deliveries_sending_idx
    ON service_report_deliveries (locked_at)
    WHERE status = 'sending'
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS service_report_deliveries_sending_idx');
  await knex.raw('DROP INDEX IF EXISTS service_report_deliveries_due_idx');
  await knex.schema.dropTableIfExists('service_report_deliveries');
};
