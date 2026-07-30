/**
 * Codex round 20 on #3021: email_sync_state.spam_scan_before_epoch — when
 * the spam rescue hits its batch backstop, the oldest-scanned epoch persists
 * here and the next run continues INTO the older remainder (`before:` query
 * partition) instead of re-scanning the same newest page forever. Cleared
 * when the partition drains; the scan watermark only advances after a full
 * unpartitioned clean pass.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_sync_state')) {
    if (!(await knex.schema.hasColumn('email_sync_state', 'spam_scan_before_epoch'))) {
      await knex.schema.alterTable('email_sync_state', (t) => t.bigInteger('spam_scan_before_epoch'));
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('email_sync_state')) {
    if (await knex.schema.hasColumn('email_sync_state', 'spam_scan_before_epoch')) {
      await knex.schema.alterTable('email_sync_state', (t) => t.dropColumn('spam_scan_before_epoch'));
    }
  }
};
