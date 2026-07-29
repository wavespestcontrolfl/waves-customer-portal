/**
 * Codex round 18 on #3021:
 * - emails.reply_to — validated single-mailbox Reply-To captured at parse
 *   time; reply drafts for relayed mail (contact forms, ticketing) address
 *   the actionable recipient instead of the provider's no-reply From.
 * - email_sync_state.last_spam_scan_at — successful-scan watermark for the
 *   spam rescue sweep, so an OAuth/provider outage widens the next scan
 *   window (up to Gmail's ~30d spam retention) instead of aging buried
 *   customer mail past a fixed 2-day query.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('emails')) {
    if (!(await knex.schema.hasColumn('emails', 'reply_to'))) {
      await knex.schema.alterTable('emails', (t) => t.text('reply_to'));
    }
  }
  if (await knex.schema.hasTable('email_sync_state')) {
    if (!(await knex.schema.hasColumn('email_sync_state', 'last_spam_scan_at'))) {
      await knex.schema.alterTable('email_sync_state', (t) => t.timestamp('last_spam_scan_at'));
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('emails')) {
    if (await knex.schema.hasColumn('emails', 'reply_to')) {
      await knex.schema.alterTable('emails', (t) => t.dropColumn('reply_to'));
    }
  }
  if (await knex.schema.hasTable('email_sync_state')) {
    if (await knex.schema.hasColumn('email_sync_state', 'last_spam_scan_at')) {
      await knex.schema.alterTable('email_sync_state', (t) => t.dropColumn('last_spam_scan_at'));
    }
  }
};
