const { createSchema } = require('./customer-geocode-review-visits-postgres');
const migration = require('../../models/migrations/20260926000030_customer_geocode_reviews');

module.exports = async function createActionSchema(trx) {
  await createSchema(trx);
  await trx.schema.alterTable('service_visits', table => table.timestamp('summary_token_issued_at', { useTz: true }));
  await trx.schema.createTable('visit_effects', table => {
    table.uuid('id').primary(); table.uuid('visit_id'); table.string('status'); table.string('effect_type');
    table.timestamp('claimed_at', { useTz: true });
  });
  await trx.schema.createTable('visit_completion_packets', table => {
    table.uuid('id').primary(); table.uuid('visit_id'); table.string('status');
  });
  for (const name of ['service_records', 'invoices']) await trx.schema.createTable(name, table => {
    table.uuid('id').primary(); table.uuid('scheduled_service_id');
  });
  await trx.schema.createTable('service_completion_attempts', table => {
    table.uuid('id').primary(); table.uuid('service_id'); table.string('status');
  });
  await trx.schema.createTable('property_preferences', table => {
    table.uuid('customer_id').primary(); table.timestamp('irrigation_home_changed_at', { useTz: true });
    table.jsonb('irrigation_confirmed_fields');
  });
  await trx.schema.createTable('leads', table => {
    table.uuid('id').primary(); table.uuid('customer_id'); table.string('status');
    table.string('address'); table.string('city'); table.string('zip');
    table.timestamp('updated_at', { useTz: true });
  });
  await trx.schema.createTable('estimates', table => {
    table.uuid('id').primary(); table.uuid('customer_id'); table.string('status'); table.string('address');
    table.jsonb('estimate_data'); table.timestamp('archived_at', { useTz: true });
    table.timestamp('updated_at', { useTz: true });
  });
  await migration.up(trx);
};
