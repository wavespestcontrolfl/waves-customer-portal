/**
 * Follow-up to 20261001004000 (frozen): that re-date only moved a backfilled
 * auto-close LATER (recorded close > read_at). A close can also precede
 * read_at: the Activity tab's Open on a resolved digest calls /read, and
 * markReadAdmin overwrites read_at, so a digest resolved at T1 and opened at
 * T2 was backfilled done at T2. Those rows still carry 003000's shape
 * (done_at = read_at) and are re-dated to the recorded close time whenever a
 * well-formed stamp differs from read_at, marked
 * metadata.doneBackfillRedatedEarly so down() finds exactly them.
 *
 * A live close never matches: an unread row closes with done_at, read_at and
 * the stamp from one instant, and a read row keeps its earlier read_at, so
 * done_at differs from read_at.
 */
const ISO = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}T'";

const redate = (doneBy, key) => `
  UPDATE notifications
     SET done_at = (metadata->>'${key}')::timestamptz,
         metadata = metadata || '{"doneBackfillRedatedEarly": true}'::jsonb
   WHERE recipient_type = 'admin'
     AND done_at IS NOT NULL
     AND done_at = read_at
     AND ${doneBy}
     -- CASE, not AND: Postgres does not promise to test the format first.
     AND CASE WHEN metadata->>'${key}' ~ ${ISO} THEN (metadata->>'${key}')::timestamptz END < read_at
`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(redate("done_by = 'episodes' AND metadata->>'autoCleared' = 'true'", 'autoClearedAt'));
  await knex.raw(redate("metadata->>'resolved' = 'true' AND done_by = LEFT(COALESCE(NULLIF(metadata->>'resolvedBy', ''), 'ops-crons'), 64)", 'resolvedAt'));
};

// Puts the re-dated rows back at read_at (what 003000 wrote, so its own
// down() still finds them).
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(`
    UPDATE notifications
       SET done_at = read_at,
           metadata = metadata - 'doneBackfillRedatedEarly'
     WHERE recipient_type = 'admin'
       AND done_at IS NOT NULL
       AND metadata->>'doneBackfillRedatedEarly' = 'true'
  `);
};
