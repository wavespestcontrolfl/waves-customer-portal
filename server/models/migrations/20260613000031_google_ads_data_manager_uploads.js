exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  const exists = await knex.schema.hasTable('google_ads_conversion_uploads');
  if (exists) return;

  await knex.schema.createTable('google_ads_conversion_uploads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('conversion_type', 60).notNullable();
    t.string('transaction_id', 220).notNullable();
    t.string('event_name', 200).notNullable();
    t.timestamp('event_timestamp', { useTz: true }).notNullable();
    t.decimal('conversion_value', 12, 2);
    t.string('currency', 3).notNullable().defaultTo('USD');

    t.string('source_table', 80);
    t.uuid('source_id');
    t.uuid('lead_id');
    t.uuid('estimate_id');
    t.uuid('customer_id');
    t.uuid('invoice_id');
    t.uuid('service_record_id');
    t.uuid('scheduled_service_id');

    t.string('status', 30).notNullable().defaultTo('pending');
    t.boolean('validate_only').notNullable().defaultTo(true);
    t.string('request_id', 160);
    t.text('error_message');
    t.jsonb('match_keys').notNullable().defaultTo('{}');
    t.jsonb('payload_summary').notNullable().defaultTo('{}');
    t.timestamp('sent_at', { useTz: true });
    t.timestamps(true, true);

    t.unique(['conversion_type', 'transaction_id'], 'uq_google_ads_dm_upload_transaction');
    t.index(['conversion_type', 'status'], 'idx_google_ads_dm_upload_type_status');
    t.index(['lead_id'], 'idx_google_ads_dm_upload_lead');
    t.index(['service_record_id'], 'idx_google_ads_dm_upload_service_record');
    t.index(['request_id'], 'idx_google_ads_dm_upload_request');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('google_ads_conversion_uploads');
};
