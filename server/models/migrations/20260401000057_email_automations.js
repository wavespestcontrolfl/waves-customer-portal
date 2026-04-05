/**
 * Migration 057 — Email Automation Log
 *
 * Tracks every automation execution (Beehiiv + SMS) to prevent
 * duplicate sends and provide an audit trail.
 */
exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await knex.schema.createTable('email_automation_log', t => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
    t.string('automation_key', 50).notNullable();  // e.g. 'new_recurring', 'lawn_service'
    t.string('automation_name', 100);
    t.string('trigger_type', 30);    // 'stage_change', 'service_type', 'review_received'
    t.string('trigger_value', 50);   // 'won', 'lawn', etc.
    t.jsonb('beehiiv_result');       // { subscriberId, tags, error? }
    t.jsonb('sms_result');           // { sent, to, error? }
    t.string('status', 20).defaultTo('success'); // 'success', 'partial', 'failed'
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('customer_id');
    t.index('automation_key');
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('email_automation_log');
};
