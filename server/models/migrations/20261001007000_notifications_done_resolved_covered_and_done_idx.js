/**
 * Two follow-ups to the done state (20261001001500…006000, all frozen):
 *
 * 1. A manual-billing / setup-fee alert rewritten "RESOLVED" (metadata
 *    resolvedCovered = true) is closed work, read or not. One of its writers
 *    (completion's settled-coverage branch) never stamped read_at, so the
 *    system-retire backfill (005000, read rows only) missed it and it stayed
 *    in the bell. Such rows not yet done are marked done now (done_at =
 *    read_at, else now; done_by 'backfill'), stamped
 *    metadata.doneBackfillResolvedCovered so down() reverses exactly them.
 *    An unread row is read at the same instant (read is kept when present;
 *    doneBackfillSetRead records which, so down() un-reads only those).
 *
 * 2. The Recently done list (done_at within 7 days, keyset on
 *    done_at DESC, id DESC) gets a matching partial index so it never scans
 *    the whole notification history.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(`
    UPDATE notifications
       SET done_at = COALESCE(read_at, now()),
           read_at = COALESCE(read_at, now()),
           done_by = 'backfill',
           resolution = 'Resolved automatically before the done state existed',
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('doneBackfillResolvedCovered', true, 'doneBackfillSetRead', read_at IS NULL)
     WHERE recipient_type = 'admin'
       AND done_at IS NULL
       AND metadata->>'resolvedCovered' = 'true'
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS notifications_admin_done_keyset_idx
      ON notifications (recipient_type, done_at DESC, id DESC)
      WHERE done_at IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  await knex.raw('DROP INDEX IF EXISTS notifications_admin_done_keyset_idx');
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(`
    UPDATE notifications
       SET done_at = NULL, done_by = NULL, resolution = NULL,
           read_at = CASE WHEN metadata->>'doneBackfillSetRead' = 'true' THEN NULL ELSE read_at END,
           metadata = metadata - 'doneBackfillResolvedCovered' - 'doneBackfillSetRead'
     WHERE recipient_type = 'admin'
       AND done_by = 'backfill'
       AND metadata->>'doneBackfillResolvedCovered' = 'true'
  `);
};
