/**
 * Rollback/reapply safety companion to
 * 20260924000130_customer_photo_id_property_scope.js (codex P1 on PR #4752)
 * — that migration is already pushed to origin, so per this repo's
 * migration-guard (a pushed migration is frozen — fix mistakes with a new
 * migration, never edit) this is a NEW file rather than an edit to it.
 *
 * THE GAP: 20260924000130's down() unconditionally `dropColumn('property_id')`
 * on pest_identifications, lawn_diagnostics, and tree_shrub_assessments —
 * for every row, whatever its value. There is no side-channel column (unlike
 * 20260924000110/000111's mode<->source trick) that lets a later migration
 * infer which rows were scoped to which property once the column is gone:
 * a real customer's selected-property Photo ID submission would be silently
 * unscoped (property_id NULL) forever after an operator rolls back and
 * reapplies, even though every OTHER photo-id column round-trips fine.
 *
 * THE FIX — capture, in `system_settings` (durable, survives the column
 * drop), the (row id -> property_id) map for every currently-non-null
 * property_id across all three tables, BEFORE 20260924000130's down() ever
 * runs. This migration's down() runs FIRST in the same rollback batch
 * (newer stamp rolls back first: 000140, then 000130), so it is the one
 * chance to capture that map. This migration's up() runs LAST on a reapply
 * (…, 000130's up() re-adds the column, then this file's up()) — by then
 * the column exists again (NULL for every row) and this restores
 * property_id for exactly the captured ids that still exist AND whose
 * captured property still exists (property_id's own ON DELETE SET NULL
 * contract: a property removed while the column was gone must not be
 * resurrected as a dangling reference — the FK would reject it anyway).
 *
 * Key derivation follows the migration-state-key convention (this file's
 * own stamp, never shared with another migration —
 * server/tests/migration-state-key-uniqueness.test.js enforces it).
 */

const STATE_KEY = 'migration.20260924000140.state';
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

    if (!(await knex.schema.hasColumn(table, 'property_id'))) continue;

    for (const entry of entries) {
      if (!entry || !entry.id || !entry.property_id) continue;
      // Only restore onto an id that still exists, and only a property_id
      // that still exists (customer_properties.id) — the column's own FK
      // (ON DELETE SET NULL) would otherwise reject a dangling reference to
      // a property removed while the column was gone.

      await knex(table)
        .where({ id: entry.id })
        .whereExists(
          knex.select(1).from('customer_properties').whereRaw('customer_properties.id = ?', [entry.property_id]),
        )
        .update({ property_id: entry.property_id });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;

  const state = {};
  for (const table of TABLES) {

    if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, 'property_id'))) {
      state[table] = [];
      continue;
    }

    const rows = await knex(table).whereNotNull('property_id').select('id', 'property_id');
    state[table] = rows.map((r) => ({ id: r.id, property_id: r.property_id }));
  }

  // Always write (even an all-empty snapshot) so a later up() reads a
  // definitive "nothing to restore" rather than a stale value from a
  // previous rollback/reapply cycle.
  await knex('system_settings')
    .insert({
      key: STATE_KEY,
      value: JSON.stringify(state),
      category: 'migration_state',
      description: 'pest_identifications/lawn_diagnostics/tree_shrub_assessments (id -> property_id) captured before 20260924000130 dropped the property_id columns — restored by this migration on reapply.',
    })
    .onConflict('key')
    .merge(['value']);
};

module.exports.STATE_KEY = STATE_KEY;
