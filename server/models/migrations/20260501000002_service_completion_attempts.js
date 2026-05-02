/**
 * service_completion_attempts
 *
 * Request-level idempotency for the complete-service flow. Completing a
 * service can create multiple downstream side effects (service record,
 * invoice, SMS, review request), so a duplicate tap or network retry needs a
 * durable attempt row before those effects begin.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('service_completion_attempts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('service_id').notNullable()
      .references('id').inTable('scheduled_services').onDelete('CASCADE');
    t.string('idempotency_key', 120).notNullable();
    t.string('status', 20).notNullable().defaultTo('pending');
    t.string('request_hash', 64);
    t.uuid('service_record_id')
      .references('id').inTable('service_records').onDelete('SET NULL');
    t.uuid('invoice_id')
      .references('id').inTable('invoices').onDelete('SET NULL');
    t.jsonb('response');
    t.text('error');
    t.timestamps(true, true);

    t.unique(['service_id', 'idempotency_key']);
    t.index(['service_id', 'status']);
  });

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS service_completion_attempts_one_pending_per_service
    ON service_completion_attempts (service_id)
    WHERE status = 'pending'
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS service_completion_attempts_one_pending_per_service');
  await knex.schema.dropTableIfExists('service_completion_attempts');
};
