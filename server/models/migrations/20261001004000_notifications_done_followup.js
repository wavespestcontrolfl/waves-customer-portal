/**
 * Follow-up to 20261001001500 (done columns) and 20261001003000 (done backfill),
 * both already run in preview and so frozen.
 *
 * 1. Each done column is ensured on its own: 001500 gated all three on done_at,
 *    so an environment that drifted to only some of them would be left without
 *    done_by / resolution.
 * 2. The backfill dated an auto-cleared episode or a resolved digest done at its
 *    read_at. The old closers kept a person's earlier read (COALESCE) and wrote
 *    the real close time to metadata.autoClearedAt / metadata.resolvedAt, so a
 *    row read before it cleared was dated days early. Those rows are re-dated to
 *    the recorded close time (only a well-formed ISO stamp; a row without one
 *    keeps read_at) and marked metadata.doneBackfillRedated so down() can find
 *    exactly them. Relevance retirements are already right (read_at IS the
 *    stamp instant).
 */
const ISO = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}T'";

const COLUMNS = [
  ['done_at', (t) => t.timestamp('done_at', { useTz: true }).nullable().defaultTo(null)],
  ['done_by', (t) => t.string('done_by', 64).nullable().defaultTo(null)],
  ['resolution', (t) => t.text('resolution').nullable().defaultTo(null)],
];

const redate = (doneBy, key) => `
  UPDATE notifications
     SET done_at = (metadata->>'${key}')::timestamptz,
         metadata = metadata || '{"doneBackfillRedated": true}'::jsonb
   WHERE recipient_type = 'admin'
     AND done_at IS NOT NULL
     AND done_at = read_at
     AND ${doneBy}
     -- CASE, not AND: Postgres does not promise to test the format first.
     AND CASE WHEN metadata->>'${key}' ~ ${ISO} THEN (metadata->>'${key}')::timestamptz END > read_at
`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  for (const [column, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('notifications', column))) {
      await knex.schema.alterTable('notifications', add);
    }
  }
  await knex.raw(redate("done_by = 'episodes' AND metadata->>'autoCleared' = 'true'", 'autoClearedAt'));
  await knex.raw(redate("metadata->>'resolved' = 'true' AND done_by = LEFT(COALESCE(NULLIF(metadata->>'resolvedBy', ''), 'ops-crons'), 64)", 'resolvedAt'));
};

// Puts the re-dated rows back at read_at (what 003000 wrote, so its own down()
// still finds them). Columns are left: 001500's down() owns dropping them.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'done_at'))) return;
  await knex.raw(`
    UPDATE notifications
       SET done_at = read_at,
           metadata = metadata - 'doneBackfillRedated'
     WHERE recipient_type = 'admin'
       AND done_at IS NOT NULL
       AND metadata->>'doneBackfillRedated' = 'true'
  `);
};
