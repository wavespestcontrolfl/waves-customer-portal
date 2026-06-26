/**
 * meta_conversion_uploads — idempotency + audit log for Meta Conversions API
 * uploads (the Meta analog of google_ads_conversion_uploads). One row per
 * (conversion_type, event_id); a real send marks status='sent' so future runs
 * skip it, while a Test-Events dry run marks 'validated' (never blocks a real send).
 */
exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  if (await knex.schema.hasTable('meta_conversion_uploads')) return;

  await knex.schema.createTable('meta_conversion_uploads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('conversion_type', 60).notNullable();
    t.string('event_id', 220).notNullable();
    t.string('event_name', 80).notNullable();
    t.timestamp('event_time', { useTz: true });
    t.decimal('value', 12, 2);
    t.string('currency', 3).notNullable().defaultTo('USD');

    t.string('source_table', 80);
    t.uuid('source_id');
    t.uuid('lead_id');
    t.uuid('customer_id');
    t.uuid('invoice_id');
    t.uuid('service_record_id');

    t.string('status', 30).notNullable().defaultTo('pending'); // sent | validated | failed
    t.boolean('test_mode').notNullable().defaultTo(false);
    t.integer('events_received');
    t.text('error_message');
    t.jsonb('match_keys').notNullable().defaultTo('{}');
    t.timestamp('sent_at', { useTz: true });
    t.timestamps(true, true);

    t.unique(['conversion_type', 'event_id'], 'uq_meta_conv_upload_event');
    t.index(['conversion_type', 'status'], 'idx_meta_conv_upload_type_status');
    t.index(['lead_id'], 'idx_meta_conv_upload_lead');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('meta_conversion_uploads');
};
