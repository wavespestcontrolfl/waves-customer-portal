/**
 * Done backfill for SYSTEM retires that only set read_at (docs/admin-
 * notifications.md section 4: read is not done). Before the system writers
 * spread doneColumns into their retire, the call-commitments watchdog, the
 * follow-up pager, the supplies deduction check and the setup-fee reconcile
 * closed a standing admin row by stamping read_at plus a metadata marker.
 * The bell and the needs-me list show rows with done_at IS NULL, so those
 * rows look like open work forever. The migrations before this one are
 * already run in preview and frozen, so this is a new file.
 *
 * A row is a system retire only by its marker, each one written by code that
 * retires and never by a person:
 * - metadata.retired = true, or dedupeVersion retired / empty / individuals
 *   (call-commitments-watchdog.js: a reminder no longer overdue, an aggregate
 *   that emptied or was replaced by per-promise rows).
 * - metadata.batchedBy (the watchdog: a reminder absorbed into the summary).
 * - metadata.emptied = true (followup-sla-watcher.js: the list emptied).
 * - metadata.autoRetired = true (supplies-consumption.js: the deduction landed).
 * - metadata.resolvedCovered = true (setup-fee reconcile / completion: live
 *   invoices cover the fee; a recurrence rewrites it to false).
 * Only rows still read and not done are touched; done_at = read_at, the
 * only close time the old writers left behind. A row with no marker (the
 * collections, procurement and cancellation retires wrote none) cannot be
 * told from a person's read and stays as it is. metadata.doneBackfillSystemRetire
 * marks exactly the rows written here so down() undoes only them.
 */
const MARKERS = `(
         metadata->>'retired' = 'true'
      OR metadata->>'dedupeVersion' IN ('retired', 'empty', 'individuals')
      OR metadata->>'emptied' = 'true'
      OR metadata->>'autoRetired' = 'true'
      OR metadata->>'resolvedCovered' = 'true'
      OR jsonb_exists(metadata, 'batchedBy')
    )`;

async function ready(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return false;
  for (const column of ['done_at', 'done_by', 'resolution', 'read_at', 'metadata']) {
    if (!(await knex.schema.hasColumn('notifications', column))) return false;
  }
  return true;
}

exports.up = async function up(knex) {
  if (!(await ready(knex))) return;
  await knex.raw(`
    UPDATE notifications
       SET done_at = read_at,
           done_by = 'backfill',
           resolution = 'Retired automatically before the done state existed',
           metadata = metadata || '{"doneBackfillSystemRetire": true}'::jsonb
     WHERE recipient_type = 'admin'
       AND done_at IS NULL
       AND read_at IS NOT NULL
       AND ${MARKERS}
  `);
};

// Clears the done fields only on rows this migration stamped and whose done is
// still its own (a person's or module's later done stands).
exports.down = async function down(knex) {
  if (!(await ready(knex))) return;
  await knex.raw(`
    UPDATE notifications
       SET done_at = NULL,
           done_by = NULL,
           resolution = NULL,
           metadata = metadata - 'doneBackfillSystemRetire'
     WHERE recipient_type = 'admin'
       AND metadata->>'doneBackfillSystemRetire' = 'true'
       AND done_by = 'backfill'
  `);
};
