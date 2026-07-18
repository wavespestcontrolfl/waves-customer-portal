/**
 * Bounded retry state for transactional emails rejected after SendGrid
 * accepted them (reputation/content/IP blocks reported by the event webhook).
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('email_messages', (t) => {
    t.integer('provider_retry_count').notNullable().defaultTo(0);
    t.timestamp('provider_retry_next_at');
    t.timestamp('provider_retry_exhausted_at');
  });
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS email_messages_provider_retry_due_idx
    ON email_messages (provider_retry_next_at)
    WHERE status = 'failed' AND provider_retry_next_at IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_provider_retry_due_idx');
  await knex.schema.alterTable('email_messages', (t) => {
    t.dropColumn('provider_retry_exhausted_at');
    t.dropColumn('provider_retry_next_at');
    t.dropColumn('provider_retry_count');
  });
};
