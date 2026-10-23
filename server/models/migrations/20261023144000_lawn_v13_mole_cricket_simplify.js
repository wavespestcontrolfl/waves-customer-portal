/**
 * Lawn protocol v13, mole crickets simplified: Acelepryn leaves the mole cricket line (owner 2026-10-23). Follows 20261023141000 and
 * 20261023143000, which are frozen.
 *
 * Mole crickets are Advion Insect Granule bait in June and the July scout visit (new areas), and Dylox 6.2 G for fall adults. Acelepryn keeps only
 * its existing caterpillar and grub uses: as a second mole cricket product it needed a target default, a water-in rule that disagrees with
 * Advion's 72 hour hold when both go on one visit, and its own July row. The recipe file no longer names it for mole crickets; this undoes what
 * the two migrations above wrote for it, and only that.
 *
 * up():
 *   1. Deletes the June Acelepryn mole cricket row 20261023141000 inserted into each staged v13 protocol (found by its audit row), only while it
 *      is exactly as written (name, window, product link, rate, unit, carrier, mode, role, gates) and no completion actual references it. A row
 *      staff changed, or a completion used, is kept and logged.
 *   2. Removes the mole cricket entry 20261023143000 appended to the Acelepryn watering rule (by_target), only while an entry exactly equal to the
 *      one it wrote is there. The rest of the rule is not touched.
 *   One audit row records the deleted rows in full and the rule before and after.
 *
 * down() puts back only what up() removed, and is all or nothing: the deleted rows are inserted again with their own ids (their window must
 * still exist and the id must be free), and the mole cricket entry is put back only while the Acelepryn rule is still exactly as up() left it.
 * Otherwise it does nothing and logs why. Run it before the downs of 143000 and 141000 (whose checks expect those rows and that entry).
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const rowsMigration = require('./20261023141000_lawn_v13_mole_cricket_bait_staged_rows');
const followMigration = require('./20261023143000_lawn_v13_advion_followups');

const ACTION = 'v13_mole_cricket_simplify';
const ACTOR = 'migration 20261023144000';
const MIGRATION = '20261023144000_lawn_v13_mole_cricket_simplify';
const ACELEPRYN = 'Acelepryn Insecticide';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}
const numberOrNull = (value) => (value == null ? null : Number(value));

// A row holds exactly what 20261023141000 wrote for the June Acelepryn mole cricket row.
function writtenRow(row, entry) {
  const spec = rowsMigration.ACELEPRYN_ROW;
  return row.product_name === spec.product_name && row.role === spec.role && row.application_mode === spec.application_mode
    && numberOrNull(row.rate_per_1000) === spec.rate_per_1000 && row.rate_unit === spec.rate_unit
    && numberOrNull(row.carrier_gal_per_1000) === spec.carrier_gal_per_1000 && row.default_in_plan === spec.default_in_plan
    && isDeepStrictEqual(asObject(row.gates), spec.gates)
    && String(row.lawn_protocol_window_id) === String(entry.windowId) && String(row.product_id) === String(entry.productId);
}

async function hasAll(knex) {
  for (const table of ['products_catalog', 'lawn_protocol_products', 'lawn_protocol_audit_log']) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  if (await knex('lawn_protocol_audit_log').where({ action: ACTION }).first('id')) return;
  const hasActuals = await knex.schema.hasTable('lawn_protocol_product_actuals');
  const record = { deletedRows: [] };

  const rowLogs = await knex('lawn_protocol_audit_log').where({ action: rowsMigration.ACTION }).select('after_snapshot');
  for (const log of rowLogs) {
    for (const entry of asObject(log.after_snapshot).inserted || []) {
      if (entry.windowKey !== rowsMigration.WINDOWS.JUN || entry.product_name !== ACELEPRYN) continue;
      const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first();
      if (!row) continue;
      const used = hasActuals && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: row.id }).first('protocol_product_id');
      if (used || !writtenRow(row, entry)) {
        console.log(`[lawn-v13-mole-cricket-simplify] June Acelepryn row ${row.id} kept: it changed since it was written, or a completion references it`);
        continue;
      }
      await knex('lawn_protocol_products').where({ id: row.id }).del();
      record.deletedRows.push(row);
    }
  }

  const followLogs = await knex('lawn_protocol_audit_log').where({ action: followMigration.ACTION }).select('after_snapshot');
  const written = followLogs.map((log) => asObject(log.after_snapshot).acelepryn).find(Boolean);
  if (written) {
    const ace = await knex('products_catalog').where({ id: written.productId }).first('id', 'post_application_watering');
    const rule = ace ? asObject(ace.post_application_watering) : null;
    const entries = rule && Array.isArray(rule.by_target) ? rule.by_target : [];
    const at = entries.findIndex((entry) => isDeepStrictEqual(entry, followMigration.MOLE_CRICKET_ENTRY));
    if (at >= 0) {
      const after = { ...rule, by_target: entries.filter((_, index) => index !== at) };
      await knex('products_catalog').where({ id: ace.id }).update({ post_application_watering: JSON.stringify(after), updated_at: knex.fn.now() });
      record.acelepryn = { productId: String(ace.id), before: rule, after };
    } else {
      console.log('[lawn-v13-mole-cricket-simplify] Acelepryn rule left alone: the mole cricket entry is not there exactly as written');
    }
  }

  if (!record.deletedRows.length && !record.acelepryn) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['products']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify(record),
    metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
  });
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  if (!logs.length) return;
  const records = logs.map((log) => asObject(log.after_snapshot));
  // Check everything first: a problem with one part makes the whole rollback a no-op.
  for (const record of records) {
    for (const row of record.deletedRows || []) {
      const window = await knex('lawn_protocol_windows').where({ id: row.lawn_protocol_window_id }).first('id');
      if (!window || await knex('lawn_protocol_products').where({ id: row.id }).first('id')) {
        console.log(`[lawn-v13-mole-cricket-simplify] rollback did nothing: the deleted row ${row.id} cannot be put back (its window is gone, or the id is taken)`);
        return;
      }
    }
    if (record.acelepryn) {
      const ace = await knex('products_catalog').where({ id: record.acelepryn.productId }).first('post_application_watering');
      if (!ace || !isDeepStrictEqual(asObject(ace.post_application_watering), record.acelepryn.after)) {
        console.log('[lawn-v13-mole-cricket-simplify] rollback did nothing: the Acelepryn rule is no longer as this migration left it');
        return;
      }
    }
  }
  for (const record of records) {
    for (const row of record.deletedRows || []) {
      await knex('lawn_protocol_products').insert({
        ...row,
        gates: JSON.stringify(asObject(row.gates)),
        annual_counter: JSON.stringify(asObject(row.annual_counter)),
        mixing: JSON.stringify(asObject(row.mixing)),
        report_copy: JSON.stringify(asObject(row.report_copy)),
      });
    }
    if (record.acelepryn) {
      await knex('products_catalog').where({ id: record.acelepryn.productId }).update({ post_application_watering: JSON.stringify(record.acelepryn.before), updated_at: knex.fn.now() });
    }
  }
  for (const log of logs) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
};

exports.ACTION = ACTION;
