/**
 * Lawn protocol v13, round 3 (Codex round 3 on #5942). Migrations 20261005120000,
 * 20261005130000 and 20261005140000 are pushed and frozen; this one fixes their
 * data.
 *
 * 1. Product safety gates. 130000 removed every gate key it judged "not read at
 *    runtime" from the staged v13 product rows. The pre-visit brief hands the
 *    technician each conditional product's COMPLETE gate object (and the tech
 *    screen prints unknown keys as key: value), so those keys ARE the field
 *    instruction: May Tetrino's minDistanceFromWaterFt and applyAlone, Dispatch's
 *    noWaterIn, Talak's delayWateringHours, Dylox's spreaderVisitOnly, the
 *    North Port block, the Dismiss season, the tank-mix partner and surfactant
 *    concentration, the pale-turf and Acelepryn label rates. This migration puts
 *    each one back on its row from the staged recipe (120000's PRODUCTS), never
 *    over a value the row already carries. recheckDays stays removed: it is a
 *    follow-up reminder, not a condition of the application.
 * 2. Combination pre-emergents. LESCO Stonewall 0.43% 15-0-15 and LESCO Dimension
 *    0.21% 18-0-10 are EPA-registered herbicides (pricing.csv says Herbicide), but
 *    130000 inserted them as category 'fertilizer', so customer product facts and
 *    the visit-product classifier read them as plant food and the EPA number is
 *    dropped from reports and outlines. Each exact-name row whose category is not
 *    a herbicide becomes category 'herbicide' and product_type 'pesticide', and
 *    gets its EPA registration (10404-89 Stonewall, 10404-87 Dimension) only where
 *    the number is empty. The nutrient analysis columns are not touched.
 *
 * Idempotent. down() writes nothing it cannot undo: it removes the gate keys it
 * added (only while the value is still the one written) and deletes its audit
 * rows for a protocol 120000.down() is about to delete; a protocol a visit or a
 * completion references keeps the restored gates (a rollback never drops safety
 * data from a protocol still in use). Catalog classification comes back out only
 * while no v13 protocol is referenced and only where the value is still the one
 * written here.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = '2026.10-v13';
const GATE_AUDIT = 'v13_gate_restore';
const CLASS_AUDIT = 'v13_catalog_class';
const N = staged.NAMES;

// Gate keys 130000 removed that state a label limit, a tank-mix or timing rule,
// an ordinance block or a nutrient target. Restored from the staged recipe.
const RESTORED_GATE_KEYS = new Set([
  'minDistanceFromWaterFt', 'applyAlone', 'noWaterIn', 'delayWateringHours', 'spreaderVisitOnly',
  'novToMarOnly', 'northPortBlocked', 'holdForTropicalWatch', 'tankMixWith', 'concentration',
  'paleTurfRate', 'rateRange', 'targetK2O',
]);
// The one key left removed: a follow-up reminder, not a condition.
const INFORMATIONAL_GATE_KEYS = new Set(['recheckDays']);

// Combination products: herbicide first, fertilizer second. Exact catalog names.
const COMBO_PRODUCTS = {
  [N.STW15]: { epa: '10404-89' },
  'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer': { epa: '10404-87' },
};

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function pick(obj, keys) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([key]) => keys.has(key)));
}

// The staged recipe's gates for a product in a window, by window key + name.
const RECIPE_GATES = new Map();
for (const [windowKey, spec] of staged.PRODUCTS) {
  RECIPE_GATES.set(`${windowKey}|${spec[0]}`, pick(spec[7], RESTORED_GATE_KEYS));
}

function v13Rows(knex) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION);
}

// The same reference test 120000.down() applies, per protocol.
async function isReferenced(knex, protocol) {
  if ((await knex.schema.hasTable('scheduled_services'))
    && await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id')) return true;
  if (await knex.schema.hasTable('lawn_protocol_service_completions')) {
    return Boolean(await knex('lawn_protocol_service_completions')
      .where({ lawn_protocol_id: protocol.id })
      .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
      .first('id'));
  }
  return false;
}

const blankEpa = (value) => {
  const text = String(value || '').trim().toLowerCase();
  return !text || text === 'n/a' || text === 'none' || text.startsWith('not epa');
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;

  // 2. Combination pre-emergents are pesticides.
  if (await knex.schema.hasTable('products_catalog')) {
    const hasType = await knex.schema.hasColumn('products_catalog', 'product_type');
    const catalog = await knex('products_catalog').select('id', 'name', 'category', 'epa_reg_number', ...(hasType ? ['product_type'] : []));
    const changes = {};
    for (const row of catalog) {
      const combo = COMBO_PRODUCTS[row.name];
      if (!combo) continue;
      const patch = {};
      if (!/herbicide/i.test(String(row.category || ''))) patch.category = 'herbicide';
      if (hasType && row.product_type !== 'pesticide') patch.product_type = 'pesticide';
      if (blankEpa(row.epa_reg_number)) patch.epa_reg_number = combo.epa;
      if (!Object.keys(patch).length) continue;
      changes[row.id] = {
        before: Object.fromEntries(Object.keys(patch).map((key) => [key, row[key] ?? null])),
        after: patch,
      };
      await knex('products_catalog').where({ id: row.id }).update({ ...patch, updated_at: knex.fn.now() });
    }
    if (Object.keys(changes).length) {
      await knex('lawn_protocol_audit_log').insert({
        lawn_protocol_id: null,
        actor_name: 'migration 20261005160000',
        entity_type: 'catalog',
        entity_id: crypto.randomUUID(),
        action: CLASS_AUDIT,
        changed_fields: JSON.stringify(['category', 'product_type', 'epa_reg_number']),
        before_snapshot: JSON.stringify({}),
        after_snapshot: JSON.stringify({ changes }),
        metadata: JSON.stringify({ migration: '20261005160000_lawn_v13_round3_gates_and_combo_class' }),
      });
    }
  }

  // 1. Restore the safety gate keys on the staged v13 product rows.
  if (!(await knex.schema.hasTable('lawn_protocol_products'))) return;
  const rows = await v13Rows(knex).select('p.id', 'p.product_name', 'p.gates', 'w.window_key', 'l.id as protocol_id');
  const audit = new Map(); // protocol_id -> { rowId: { key: value } }
  for (const row of rows) {
    const recipe = RECIPE_GATES.get(`${row.window_key}|${row.product_name}`);
    if (!recipe) continue;
    const gates = asObject(row.gates);
    const missing = Object.fromEntries(Object.entries(recipe).filter(([key]) => !(key in gates)));
    if (!Object.keys(missing).length) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, ...missing }), updated_at: knex.fn.now() });
    if (!audit.has(row.protocol_id)) audit.set(row.protocol_id, {});
    audit.get(row.protocol_id)[row.id] = missing;
  }
  for (const [protocolId, restored] of audit) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261005160000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: GATE_AUDIT,
      changed_fields: JSON.stringify(['gates']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ restored }),
      metadata: JSON.stringify({ migration: '20261005160000_lawn_v13_round3_gates_and_combo_class', gate: 'GATE_LAWN_V13' }),
    });
  }
};

// Unreferenced protocol: 120000.down() deletes it, so take the restored keys
// back out (only where the value is still the one written) and leave no audit row.
async function revertGates(knex, protocol) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: GATE_AUDIT, lawn_protocol_id: protocol.id }).select('id', 'after_snapshot');
  for (const log of logs) {
    for (const [rowId, restored] of Object.entries(asObject(log.after_snapshot).restored || {})) {
      const row = await knex('lawn_protocol_products').where({ id: rowId }).first('id', 'gates');
      if (!row) continue;
      const gates = asObject(row.gates);
      for (const [key, value] of Object.entries(restored)) {
        if (isDeepStrictEqual(gates[key], value)) delete gates[key];
      }
      await knex('lawn_protocol_products').where({ id: rowId }).update({ gates: JSON.stringify(gates) });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

async function revertClassification(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CLASS_AUDIT }).select('id', 'after_snapshot');
  for (const log of logs) {
    for (const [catalogId, change] of Object.entries(asObject(log.after_snapshot).changes || {})) {
      const row = await knex('products_catalog').where({ id: catalogId }).first();
      if (!row) continue;
      const undo = {};
      for (const [key, written] of Object.entries(change.after || {})) {
        if (row[key] === written) undo[key] = change.before[key] ?? null;
      }
      if (Object.keys(undo).length) await knex('products_catalog').where({ id: catalogId }).update(undo);
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocols'))) return;
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  let anyReferenced = false;
  for (const protocol of protocols) {
    if (await isReferenced(knex, protocol)) anyReferenced = true;
    else await revertGates(knex, protocol);
  }
  // The classification comes back out only while no v13 protocol is in use.
  if (!anyReferenced && await knex.schema.hasTable('products_catalog')) await revertClassification(knex);
};

exports.RESTORED_GATE_KEYS = RESTORED_GATE_KEYS;
exports.INFORMATIONAL_GATE_KEYS = INFORMATIONAL_GATE_KEYS;
exports.COMBO_PRODUCTS = COMBO_PRODUCTS;
