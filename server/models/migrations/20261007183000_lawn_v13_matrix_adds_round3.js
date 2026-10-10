/**
 * Lawn protocol v13 matrix adds, Codex round 3 (PR #6116). Migrations 20261007180000, 20261007181000
 * and 20261007182000 are pushed and frozen; this one fixes their data. Every write is guarded (a value
 * changes only while it is still what the earlier migration or the schema left), recorded before and
 * after, and put back by down().
 *
 *   A. No customer-report override for Talak on mole crickets. 180000 put the row gate
 *      `moleCricketWaterInInches` on the July Talak row and the August Talak row; a code path used it to
 *      freeze a water-in instead of the product's 24-hour hold, but it needed a recorded target (Fast
 *      Complete sends none) and it broke mixed-product visits. The code is gone. The gate is removed
 *      here, only where it still holds 0.5. The recipe now tells the technician to water the product in
 *      with the hose right after application (up to 0.5 inch) before leaving; July and August are hose
 *      visits. The customer keeps Talak's 24-hour hold, which then runs after the technician's water-in.
 *   B. The July and August Talak rows carry the mole cricket rate: rate_per_1000 1.0, rate_unit 'fl oz'
 *      (label: nymphs 0.5 to 1.0 fl oz per 1,000 sq ft, use the higher rate later in the year), only
 *      where they still hold no rate (null / 'label_rate'). They stay spot rows: no quantity is planned.
 *   C. The Headway Fungicide catalog row prod already has was never touched by 180000 (insert-if-missing).
 *      It gets frac_group '3 + 11' (so the rotation reader sees groups 3 and 11) and, where it has none, a
 *      default rate of 3 fl oz per 1,000 sq ft (the take-all rate) with unit 'fl oz'. A field that already
 *      holds a value is never changed.
 *   D. Rollback. 182000's down() deletes the Advion limit rows it inserted; one that is already gone made
 *      it fail. This migration's down() runs first and removes from 182000's catalog audit entry every
 *      limit whose row no longer exists (kept under `absent`), so 182000's down() skips it.
 */

const crypto = require('crypto');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');
const round2 = require('./20261007182000_lawn_v13_matrix_adds_round2');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_matrix_adds_round3';
const CATALOG_ACTION = 'v13_matrix_adds_round3_catalog';
const ACTOR = 'migration 20261007183000';
const MIGRATION = '20261007183000_lawn_v13_matrix_adds_round3';
const W = matrix.WINDOWS;

const TALAK_WINDOWS = [W.JUL, W.AUG];
const GATE = 'moleCricketWaterInInches';
const MOLE_CRICKET_RATE = 1;
const MOLE_CRICKET_UNIT = 'fl oz';

const HEADWAY_FRAC = '3 + 11';
const HEADWAY_RATE = 3;
const HEADWAY_UNIT = 'fl oz';

const isEmpty = (value) => value == null || String(value).trim() === '';
const isFlOz = (unit) => ['fl oz', 'fl_oz', 'floz'].includes(String(unit || '').trim().toLowerCase());

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// ── A and B: the Talak rows ──────────────────────────────────────────────────

async function talakRows(knex, protocolId) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where({ 'w.lawn_protocol_id': protocolId, 'p.product_name': staged.NAMES.TAL })
    .whereIn('w.window_key', TALAK_WINDOWS)
    .select('p.id', 'p.rate_per_1000', 'p.rate_unit', 'p.gates');
}

function talakChange(row) {
  const gates = asObject(row.gates);
  const change = { rowId: row.id, update: {}, gateRemoved: null, rate: null };
  if (Number(gates[GATE]) === matrix.MOLE_CRICKET_WATER_IN) {
    delete gates[GATE];
    change.update.gates = JSON.stringify(gates);
    change.gateRemoved = matrix.MOLE_CRICKET_WATER_IN;
  }
  if (row.rate_per_1000 == null && (isEmpty(row.rate_unit) || row.rate_unit === 'label_rate')) {
    change.update.rate_per_1000 = MOLE_CRICKET_RATE;
    change.update.rate_unit = MOLE_CRICKET_UNIT;
    change.rate = { beforeUnit: row.rate_unit ?? null };
  }
  return change;
}

async function fixTalak(knex, protocolId) {
  const changes = [];
  for (const row of await talakRows(knex, protocolId)) {
    const change = talakChange(row);
    if (!Object.keys(change.update).length) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ ...change.update, updated_at: knex.fn.now() });
    changes.push({ rowId: change.rowId, gateRemoved: change.gateRemoved, rate: change.rate });
  }
  return changes;
}

// ── C: the Headway catalog row ───────────────────────────────────────────────

function headwayFields(row) {
  const fields = {};
  if (isEmpty(row.frac_group)) fields.frac_group = HEADWAY_FRAC;
  if (isEmpty(row.rate_unit)) fields.rate_unit = HEADWAY_UNIT;
  if (isEmpty(row.default_rate_per_1000) && (isEmpty(row.rate_unit) || isFlOz(row.rate_unit))) fields.default_rate_per_1000 = HEADWAY_RATE;
  return fields;
}

async function fixHeadway(knex) {
  const row = await knex('products_catalog').where({ name: matrix.HEAD }).first('id', 'frac_group', 'default_rate_per_1000', 'rate_unit');
  if (!row) return null;
  const fields = headwayFields(row);
  if (!Object.keys(fields).length) return null;
  await knex('products_catalog').where({ id: row.id }).update({ ...fields, updated_at: knex.fn.now() });
  return { id: row.id, fields };
}

// ── up ───────────────────────────────────────────────────────────────────────

const REQUIRED = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id')) {
    const changes = await fixTalak(knex, protocol.id);
    if (!changes.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['gates', 'rate']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ changes }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
  const headway = await fixHeadway(knex);
  if (!headway) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ headway }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// ── down ─────────────────────────────────────────────────────────────────────

// 182000's down() deletes the limit rows it wrote: drop the entries whose row is already gone.
async function skipAbsentLimits(knex) {
  if (!(await knex.schema.hasTable('product_limits'))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: round2.CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    const limits = Array.isArray(after.limits) ? after.limits : [];
    const present = [];
    const absent = [];
    for (const written of limits) {
      const row = await knex('product_limits').where({ id: written.id }).first('id');
      (row ? present : absent).push(written);
    }
    if (!absent.length) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id })
      .update({ after_snapshot: JSON.stringify({ ...after, limits: present, absent: [...(after.absent || []), ...absent] }) });
  }
}

async function revertTalak(knex, entry) {
  const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'rate_per_1000', 'rate_unit', 'gates');
  if (!row) return;
  const update = { updated_at: knex.fn.now() };
  const gates = asObject(row.gates);
  if (entry.gateRemoved != null && gates[GATE] === undefined) {
    update.gates = JSON.stringify({ ...gates, [GATE]: entry.gateRemoved });
  }
  if (entry.rate && Number(row.rate_per_1000) === MOLE_CRICKET_RATE && row.rate_unit === MOLE_CRICKET_UNIT) {
    update.rate_per_1000 = null;
    update.rate_unit = entry.rate.beforeUnit;
  }
  await knex('lawn_protocol_products').where({ id: row.id }).update(update);
}

async function revertHeadway(knex, headway) {
  const row = await knex('products_catalog').where({ id: headway.id }).first('id', 'frac_group', 'default_rate_per_1000', 'rate_unit');
  if (!row) return;
  const update = {};
  for (const [column, written] of Object.entries(headway.fields)) {
    const current = row[column];
    const same = column === 'default_rate_per_1000' ? Number(current) === Number(written) : current === written;
    if (same) update[column] = null;
  }
  if (Object.keys(update).length) await knex('products_catalog').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  await skipAbsentLimits(knex);
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    for (const entry of asObject(log.after_snapshot).changes || []) await revertTalak(knex, entry);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot')) {
    const { headway } = asObject(log.after_snapshot);
    if (headway) await revertHeadway(knex, headway);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.GATE = GATE;
exports.MOLE_CRICKET_RATE = MOLE_CRICKET_RATE;
exports.MOLE_CRICKET_UNIT = MOLE_CRICKET_UNIT;
exports.HEADWAY_FRAC = HEADWAY_FRAC;
exports.HEADWAY_RATE = HEADWAY_RATE;
exports.HEADWAY_UNIT = HEADWAY_UNIT;
