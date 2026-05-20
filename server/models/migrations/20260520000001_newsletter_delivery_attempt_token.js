/**
 * Track the active SendGrid attempt for newsletter delivery resume claims.
 *
 * The token rides in SendGrid custom_args so delivery_id fallback webhooks can
 * distinguish the current retry attempt from stale events emitted by an older
 * lost-response attempt.
 */

exports.up = async function up(knex) {
  const hasAttemptToken = await knex.schema.hasColumn('newsletter_send_deliveries', 'send_attempt_token');
  if (!hasAttemptToken) {
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      t.string('send_attempt_token', 64);
    });
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_newsletter_send_deliveries_attempt_token
      ON newsletter_send_deliveries (send_attempt_token)
      WHERE send_attempt_token IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_newsletter_send_deliveries_attempt_token');
  const hasAttemptToken = await knex.schema.hasColumn('newsletter_send_deliveries', 'send_attempt_token');
  if (hasAttemptToken) {
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      t.dropColumn('send_attempt_token');
    });
  }
};
