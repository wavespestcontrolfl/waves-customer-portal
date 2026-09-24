/**
 * Rollback/reapply safety companion to
 * 20260924000100_customer_photo_id_columns.js (already pushed to origin) —
 * per this repo's migration-guard (a pushed migration is frozen — fix
 * mistakes with a new migration, never edit) this is a NEW file rather than
 * an edit to it. Same pattern as 20260924000140 (property_id), one stamp
 * later so it rolls back first and reapplies last.
 *
 * THE GAP: 20260924000100's down() unconditionally `dropColumn('note')` and
 * `dropColumn('location')` on pest_identifications, lawn_diagnostics, and
 * tree_shrub_assessments — for every row, whatever its value, with no
 * side-channel column that lets a later migration infer what was there once
 * the columns are gone. A customer's own free-text note and selected
 * location (server/routes/photo-id.js's history-request prefills read these
 * back) would be silently blanked forever after an operator rolls back and
 * reapplies, even though every other photo-id column round-trips fine.
 *
 * THE FIX — capture, in `system_settings` (durable, survives the column
 * drop), the (row id -> { note, location }) map for every row currently
 * carrying a non-null note OR location, across all three tables, BEFORE
 * 20260924000100's down() ever runs. This migration's down() runs FIRST in
 * the same rollback batch (newer stamp rolls back first: 000150, then
 * 000140, then 000130, ..., then 000100), so it is the one chance to
 * capture that map. This migration's up() runs LAST on a reapply (000100's
 * up() re-adds the columns as NULL, ..., 000140's up(), then this file's
 * up()) — by then the columns exist again and this restores note/location
 * for exactly the captured ids that still exist. Unlike 000140's
 * property_id, note/location carry no foreign key, so there is no
 * "referenced row still exists" check beyond the row itself.
 *
 * Key derivation follows the migration-state-key convention (this file's
 * own stamp, never shared with another migration —
 * server/tests/migration-state-key-uniqueness.test.js enforces it).
 */

const STATE_KEY = 'migration.20260924000150.state';
const TABLES = ['pest_identifications', 'lawn_diagnostics', 'tree_shrub_assessments'];

async function readState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first('value');
  if (!row || !row.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

exports.up = async function up(knex) {
  const state = await readState(knex);
  if (!state) return;

  for (const table of TABLES) {
    const entries = Array.isArray(state[table]) ? state[table] : [];
    if (!entries.length) continue;

    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'note')) || !(await knex.schema.hasColumn(table, 'location'))) continue;

    for (const entry of entries) {
      if (!entry || !entry.id) continue;
      const updates = {};
      if (entry.note != null) updates.note = entry.note;
      if (entry.location != null) updates.location = entry.location;
      if (!Object.keys(updates).length) continue;

      // Only restore onto an id that still exists.
      await knex(table).where({ id: entry.id }).update(updates);
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;

  const state = {};
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))
      || !(await knex.schema.hasColumn(table, 'note'))
      || !(await knex.schema.hasColumn(table, 'location'))) {
      state[table] = [];
      continue;
    }

    const rows = await knex(table).select('id', 'note', 'location');
    state[table] = rows
      .filter((r) => r.note != null || r.location != null)
      .map((r) => ({ id: r.id, note: r.note ?? null, location: r.location ?? null }));
  }

  // Always write (even an all-empty snapshot) so a later up() reads a
  // definitive "nothing to restore" rather than a stale value from a
  // previous rollback/reapply cycle.
  await knex('system_settings')
    .insert({
      key: STATE_KEY,
      value: JSON.stringify(state),
      category: 'migration_state',
      description: 'pest_identifications/lawn_diagnostics/tree_shrub_assessments (id -> {note, location}) captured before 20260924000100 dropped the note/location columns — restored by this migration on reapply.',
    })
    .onConflict('key')
    .merge(['value']);
};

module.exports.STATE_KEY = STATE_KEY;
