/**
 * Tighten the hot-alert obligation index to OUTSTANDING rows only.
 *
 * 20260814000000 indexed every row that ever carried
 * `relay_hot_alert_needed` — but successful delivery only ADDS
 * `relay_hot_alert_sent_at`; it never removes the needed marker, so that
 * index grows with every hot call ever handled. The sweep's predicate is
 * needed-present AND sent-absent; the index now says exactly that, so it
 * holds only rows still owing a page (normally zero).
 *
 * A separate follow-up migration (not an edit of 20260814000000): the prior
 * file may already have run in PR/staging environments, and migrations are
 * never edited in place once applied anywhere.
 */
exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_relay_hot_alert_needed_idx');
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS call_log_relay_hot_alert_needed_idx '
    + 'ON call_log (created_at) '
    + "WHERE (metadata->>'relay_hot_alert_needed') IS NOT NULL "
    + "AND (metadata->>'relay_hot_alert_sent_at') IS NULL",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_relay_hot_alert_needed_idx');
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS call_log_relay_hot_alert_needed_idx '
    + 'ON call_log (created_at) '
    + "WHERE (metadata->>'relay_hot_alert_needed') IS NOT NULL",
  );
};
