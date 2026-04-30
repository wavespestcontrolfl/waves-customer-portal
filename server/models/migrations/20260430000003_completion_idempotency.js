// Idempotency table for the dispatch completion endpoint.
//
// The mobile MobileCompleteServiceSheet generates an X-Idempotency-Key
// (UUID) per submit attempt and reuses it on retry. This table stores the
// first successful response per key so a duplicate request — caused by a
// double-tap, low-signal retry, or a network glitch after the trx
// committed — returns the original payload instead of re-creating
// service_records, invoices, SMS sends, or review requests.
//
// Keys are pruned by created_at; downstream cleanup can run a TTL job
// (24h is more than enough for "the tech retried the submit" cases).
exports.up = async (knex) => {
  await knex.schema.createTable('completion_idempotency_keys', (t) => {
    t.string('key', 64).primary();
    t.uuid('service_id').notNullable();
    t.jsonb('response').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index('created_at', 'idx_completion_idemp_created');
    t.index('service_id', 'idx_completion_idemp_service');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('completion_idempotency_keys');
};
