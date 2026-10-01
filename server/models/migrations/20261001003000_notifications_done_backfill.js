/**
 * Backfill the done state for admin rows the auto-closers closed BEFORE
 * notifications.done_at existed (20261001001500 added it with no backfill).
 * Those closes wrote read_at plus a metadata stamp; without done_at the rows
 * would return to the bell, and the relevance sweep — whose put-back and
 * candidate query now fence on done_at — could never re-arm or re-judge them.
 *
 * Three stamped kinds, each only while the module's close still stands:
 * - relevance retirements (metadata.retired.by = 'alert-relevance') whose
 *   read_at is still the stamp's own instant: a person's later read means the
 *   row is theirs, and it stays open. done_at = that instant, so putBack's
 *   `done_at = stamp.at` fence matches.
 * - alert-episode auto-clears (metadata.autoCleared = true; a recurrence
 *   rewrites it to false) that are read.
 * - resolved ops digests (metadata.resolved = true) that are read.
 * Rows already done are never touched. down() clears only what up() wrote.
 */
const RELEVANCE = `
  UPDATE notifications
     SET done_at = read_at,
         done_by = 'relevance',
         resolution = LEFT(NULLIF(metadata->'retired'->>'reason', ''), 200)
   WHERE recipient_type = 'admin'
     AND done_at IS NULL
     AND metadata->'retired'->>'by' = 'alert-relevance'
     AND read_at IS NOT NULL
     AND read_at = NULLIF(metadata->'retired'->>'at', '')::timestamptz
`;

const EPISODES = `
  UPDATE notifications
     SET done_at = read_at,
         done_by = 'episodes',
         resolution = 'The condition that raised this alert cleared'
   WHERE recipient_type = 'admin'
     AND done_at IS NULL
     AND read_at IS NOT NULL
     AND metadata->>'autoCleared' = 'true'
`;

const DIGESTS = `
  UPDATE notifications
     SET done_at = read_at,
         done_by = LEFT(COALESCE(NULLIF(metadata->>'resolvedBy', ''), 'ops-crons'), 64),
         resolution = 'The check that raised this finding has run clean'
   WHERE recipient_type = 'admin'
     AND done_at IS NULL
     AND read_at IS NOT NULL
     AND metadata->>'resolved' = 'true'
`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(RELEVANCE);
  await knex.raw(EPISODES);
  await knex.raw(DIGESTS);
};

// Undo only rows whose done is still the backfill's own (done_at = read_at
// with the backfill's done_by); a later person or module done stands.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(`
    UPDATE notifications
       SET done_at = NULL, done_by = NULL, resolution = NULL
     WHERE recipient_type = 'admin'
       AND done_at IS NOT NULL
       AND done_at = read_at
       AND (
         (done_by = 'relevance' AND metadata->'retired'->>'by' = 'alert-relevance')
         OR (done_by = 'episodes' AND metadata->>'autoCleared' = 'true')
         OR (metadata->>'resolved' = 'true' AND done_by = LEFT(COALESCE(NULLIF(metadata->>'resolvedBy', ''), 'ops-crons'), 64))
       )
  `);
};
