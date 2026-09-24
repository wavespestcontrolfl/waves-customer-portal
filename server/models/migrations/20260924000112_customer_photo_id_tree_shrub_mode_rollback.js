/**
 * Rollback/reapply safety for tree_shrub_assessments' customer Photo ID rows
 * (codex GH r2 P1 on PR #4752) — a companion to 20260924000110/000111 (both
 * now frozen too, already pushed), which only handle pest_identifications
 * and lawn_diagnostics.
 *
 * WHY TREE_SHRUB IS DIFFERENT: pest_identifications/lawn_diagnostics only
 * ever have their `mode` VALUE changed by a rollback (000110's down() flips
 * 'customer' -> 'internal'; the column itself always exists). But
 * 20260924000100's down() DROPS tree_shrub_assessments' `mode` and `source`
 * COLUMNS entirely and unconditionally — for every row, whatever its value.
 * There is nothing to "flip back" once the column is gone: a customer
 * submission's `mode='customer', source='portal'` is destroyed outright,
 * and reapplying just re-adds the columns at their DEFAULTS
 * ('internal'/'tech') — permanently losing which tree_shrub_assessments
 * rows were customer Photo ID submissions.
 *
 * THE FIX: capture, in `system_settings` (durable, survives the column
 * drop), the ids of every tree_shrub_assessments row that is currently
 * mode='customer' — BEFORE 20260924000100's down() ever runs. This
 * migration's down() runs FIRST in the same rollback (newest stamp rolls
 * back first: 000112, then 000111, then 000110, then 000100), so it is the
 * one chance to capture that set. This migration's up() runs LAST on a
 * reapply (000100 up, then 000110 up [no-op], then 000111 up [pest/lawn
 * restore], then this file's up()) — by then the columns exist again (at
 * their defaults) and this restores mode='customer'/source='portal' for
 * exactly the captured ids that still exist.
 *
 * Key derivation follows the migration-state-key convention (this file's
 * own stamp, never shared with another migration —
 * server/tests/migration-state-key-uniqueness.test.js enforces it).
 */

const STATE_KEY = 'migration.20260924000112.tree_shrub_customer_ids';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tree_shrub_assessments'))) return;
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first('value');
  if (!row || !row.value) return;
  let ids;
  try {
    ids = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!Array.isArray(ids) || !ids.length) return;
  if (!(await knex.schema.hasColumn('tree_shrub_assessments', 'mode'))
    || !(await knex.schema.hasColumn('tree_shrub_assessments', 'source'))) {
    // 20260924000100 hasn't run (or ran without these columns) yet on this
    // database — nothing to restore onto.
    return;
  }
  await knex('tree_shrub_assessments').whereIn('id', ids).update({ mode: 'customer', source: 'portal' });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('tree_shrub_assessments'))) return;
  if (!(await knex.schema.hasTable('system_settings'))) return;
  let ids = [];
  if (await knex.schema.hasColumn('tree_shrub_assessments', 'mode')) {
    const rows = await knex('tree_shrub_assessments').where({ mode: 'customer' }).select('id');
    ids = rows.map((r) => r.id);
  }
  // Always write (even an empty array) so a later up() reads a definitive
  // "nothing to restore" rather than a stale value from a previous cycle.
  await knex('system_settings')
    .insert({
      key: STATE_KEY,
      value: JSON.stringify(ids),
      category: 'migration_state',
      description: 'tree_shrub_assessments row ids that were mode=customer before 20260924000100 dropped the mode/source columns — restored by this migration on reapply.',
    })
    .onConflict('key')
    .merge(['value']);
};

module.exports.STATE_KEY = STATE_KEY;
