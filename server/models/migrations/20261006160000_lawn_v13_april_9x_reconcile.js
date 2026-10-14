/**
 * Lawn protocol v13, before the GATE_LAWN_V13 flip: rollback and re-apply of the 9x
 * April product row (Codex round 2 on #5998). Migration 20261006150000 is pushed and
 * frozen; this one fixes what its down() and up() leave behind.
 *
 * 150000.down() skips a Dimension row that a completion actual references, and leaves
 * the 24-0-11 row marked 12x and its audit row in place. A later 150000.up() then sees a
 * Dimension row in the window and skips it, so the row is never put back in step.
 *
 * up():   per staged v13 April window holding both rows, brings the Dimension row back in
 *         step with the 24-0-11 row (its gates plus planVisitsPerYear 9, default_in_plan
 *         and rate mirror the 24-0-11 row), marks the 24-0-11 row 12x, and makes sure the
 *         protocol has its 'v13_april_9x' audit row (so 150000.down() can find it).
 *         A window already in step is left alone, so a second run changes nothing.
 * down(): for a Dimension row a completion actual references (the row 150000.down() keeps):
 *         switches it off (default_in_plan false, planVisitsPerYear removed), takes the 12x
 *         mark off the 24-0-11 row while it still holds 12, and deletes the audit row.
 *         A row nothing references is left for 150000.down(), which deletes it.
 * Rollback order: this down(), then 150000.down(), ends with no 9x condition anywhere.
 */

const april = require('./20261006150000_lawn_v13_april_9x_branch');
const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = '2026.10-v13';
const AUDIT_ACTION = 'v13_april_9x';
const { DIMENSION, GATE_KEY, APRIL_WINDOW } = april;
const F24 = staged.NAMES.F24;

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_products')) || !(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;

  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION)
    .where('w.window_key', APRIL_WINDOW)
    .select('p.id', 'p.lawn_protocol_window_id', 'p.product_name', 'p.rate_per_1000', 'p.rate_unit', 'p.default_in_plan', 'p.gates', 'l.id as protocol_id');
  const windows = new Map();
  for (const row of rows) {
    if (!windows.has(row.lawn_protocol_window_id)) windows.set(row.lawn_protocol_window_id, { protocolId: row.protocol_id, rows: [] });
    windows.get(row.lawn_protocol_window_id).rows.push(row);
  }

  for (const window of windows.values()) {
    const f24 = window.rows.find((row) => row.product_name === F24);
    const dimension = window.rows.find((row) => row.product_name === DIMENSION);
    if (!f24 || !dimension) continue;
    const f24Gates = asObject(f24.gates);
    const audited = await knex('lawn_protocol_audit_log').where({ action: AUDIT_ACTION, lawn_protocol_id: window.protocolId }).first('id');
    if (audited && asObject(dimension.gates)[GATE_KEY] === 9 && dimension.default_in_plan === f24.default_in_plan && f24Gates[GATE_KEY] === 12) continue;

    // The 24-0-11 row's own gates without a stale 9x/12x mark, then this row's mark.
    const f24Own = { ...f24Gates };
    delete f24Own[GATE_KEY];
    await knex('lawn_protocol_products').where({ id: dimension.id }).update({
      gates: JSON.stringify({ ...asObject(dimension.gates), ...f24Own, [GATE_KEY]: 9 }),
      default_in_plan: f24.default_in_plan,
      rate_per_1000: f24.rate_per_1000,
      rate_unit: f24.rate_unit,
      updated_at: knex.fn.now(),
    });
    await knex('lawn_protocol_products').where({ id: f24.id }).update({ gates: JSON.stringify({ ...f24Own, [GATE_KEY]: 12 }), updated_at: knex.fn.now() });
    if (!audited) {
      await knex('lawn_protocol_audit_log').insert({
        lawn_protocol_id: window.protocolId,
        actor_name: 'migration 20261006160000',
        entity_type: 'protocol',
        entity_id: window.protocolId,
        action: AUDIT_ACTION,
        changed_fields: JSON.stringify(['products', 'gates']),
        before_snapshot: JSON.stringify({ f24RowId: f24.id, f24Gates: f24Own }),
        after_snapshot: JSON.stringify({ dimensionRowId: dimension.id }),
        metadata: JSON.stringify({ migration: '20261006160000_lawn_v13_april_9x_reconcile', gate: 'GATE_LAWN_V13', reconciledExisting: true }),
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocol_products'))
    || !(await knex.schema.hasTable('lawn_protocol_product_actuals'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: AUDIT_ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    const { dimensionRowId } = asObject(log.after_snapshot);
    const { f24RowId } = asObject(log.before_snapshot);
    // Unreferenced rows are 150000.down()'s to delete.
    if (!dimensionRowId || !(await knex('lawn_protocol_product_actuals').where({ protocol_product_id: dimensionRowId }).first('id'))) continue;

    const dimension = await knex('lawn_protocol_products').where({ id: dimensionRowId }).first('id', 'gates');
    if (dimension) {
      const gates = asObject(dimension.gates);
      delete gates[GATE_KEY];
      await knex('lawn_protocol_products').where({ id: dimensionRowId }).update({ default_in_plan: false, gates: JSON.stringify(gates) });
    }
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
