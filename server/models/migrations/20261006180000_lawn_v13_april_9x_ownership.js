/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: who owns the 9x April Dimension row
 * (Codex round 3 on #5998). Migrations 20261006150000 and 20261006160000 are pushed and
 * frozen. 160000.up() reconciles ANY Dimension row in the April window, including one the
 * window held before 150000 ran, and the downs of 150000/160000 then delete or switch off
 * a row they did not create.
 *
 * up(): marks every 'v13_april_9x' audit row with ownership in its after_snapshot:
 *   created_by_migration: true  when 150000 wrote the row. 150000 writes its audit row in
 *     the same step that inserts the Dimension row, never otherwise, so an audit row whose
 *     actor is 'migration 20261006150000' proves it created the row (a created_at compare
 *     cannot: created_at is the migration's own transaction time).
 *   created_by_migration: false when the audit row is 160000's. 160000 writes one only when
 *     no 150000 audit row existed, i.e. the row was already there (or was kept by a rollback
 *     because a completion actual references it): not created by this stack. Its
 *     preexisting_snapshot holds the row's default_in_plan, rate and gates as they stand
 *     when this runs. Known limit: 160000 may already have mirrored the 24-0-11 row onto
 *     such a row before this migration ran, and the values it overwrote are not recorded
 *     anywhere, so the snapshot is the row as 160000 left it, not as it was before 150000.
 * down() runs FIRST on a rollback: for a row not created by the stack it restores the
 * snapshot, takes the 12x mark off the 24-0-11 row (while it still holds 12) and deletes
 * the audit row, so 160000.down() and 150000.down() find nothing to delete or switch off;
 * for a created row it only removes the ownership keys (150000/160000 handle it as before).
 * Idempotent: an audit row that already carries created_by_migration is left alone.
 */
const april = require('./20261006150000_lawn_v13_april_9x_branch');

const ACTION = 'v13_april_9x';
const CREATOR_ACTOR = 'migration 20261006150000';
const { GATE_KEY } = april;

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'actor_name', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    if (!after.dimensionRowId || 'created_by_migration' in after) continue;
    const created = log.actor_name === CREATOR_ACTOR;
    const payload = { ...after, created_by_migration: created };
    if (!created) {
      const row = await knex('lawn_protocol_products').where({ id: after.dimensionRowId })
        .first('default_in_plan', 'rate_per_1000', 'rate_unit', 'gates');
      if (!row) continue;
      payload.preexisting_snapshot = {
        default_in_plan: row.default_in_plan, rate_per_1000: row.rate_per_1000, rate_unit: row.rate_unit, gates: asObject(row.gates),
      };
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify(payload) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    if (!('created_by_migration' in after)) continue;
    const { created_by_migration: created, preexisting_snapshot: snapshot, ...rest } = after;
    if (created || !snapshot) {
      await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify(rest) });
      continue;
    }
    await knex('lawn_protocol_products').where({ id: after.dimensionRowId }).update({
      default_in_plan: snapshot.default_in_plan,
      rate_per_1000: snapshot.rate_per_1000,
      rate_unit: snapshot.rate_unit,
      gates: JSON.stringify(snapshot.gates || {}),
    });
    const { f24RowId } = asObject(log.before_snapshot);
    const f24 = f24RowId ? await knex('lawn_protocol_products').where({ id: f24RowId }).first('id', 'gates') : null;
    if (f24) {
      const gates = asObject(f24.gates);
      if (gates[GATE_KEY] === 12) {
        delete gates[GATE_KEY];
        await knex('lawn_protocol_products').where({ id: f24RowId }).update({ gates: JSON.stringify(gates) });
      }
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};
