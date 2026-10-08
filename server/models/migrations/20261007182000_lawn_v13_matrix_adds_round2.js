/**
 * Lawn protocol v13 matrix adds, Codex round 2 (PR #6116). Migrations 20261007180000 and 20261007181000
 * are pushed and frozen; this one fixes their data. Every write is guarded (a value changes only while
 * it is still what the earlier migration left), recorded before and after, and put back by down().
 *
 *   1. Trigger gates. The recipe folded new uses into lines of products the staged protocol already
 *      carried (Velista in October and November; Artavia in June, August and September), and the
 *      staged rows kept their old trigger text, so the pre-visit brief and the job card named only
 *      the old use. Each row's gates.trigger now lists the new uses, only where it still equals the
 *      old value.
 *   2. Advion limits. The Advion Fire Ant Bait label (EPA 100-1481): at least 12 weeks between
 *      applications and 6 lb per acre a year at 1.5 lb per acre, so 4 a year. Two product limit rows
 *      for the Advion product id, both hard blocks, inserted only where the product has none of that
 *      limit type: min_interval_days 84 and annual_max_apps 4. The plan's limit reader (and the
 *      closeout's) blocks a second application inside 84 days and a fifth in a year.
 *   3. July fertilizer safety. The July 0-0-50 spreader row gets gates.fertilizerSafety = true, so the
 *      job card and the SOP print the fertilizer safety block for the July window (the block prints
 *      for any window with a gated row).
 *   4. Rollback. 181000's down() reverts catalog-wide and staged-row data without asking whether a
 *      protocol is live. This migration's down() runs first: when any v13 protocol is referenced by a
 *      scheduled visit or a completion, it rewrites 181000's audit rows so that down() has nothing to
 *      revert (the earlier lanes' neutralize pattern; the original entries are kept under `keptLive`).
 *      The same live check decides this migration's own rollback: a live protocol keeps its rows, and
 *      the limit rows stay.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');
const fixes = require('./20261007181000_lawn_v13_matrix_adds_fixes');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_matrix_adds_round2';
const CATALOG_ACTION = 'v13_matrix_adds_round2_catalog';
const ACTOR = 'migration 20261007182000';
const MIGRATION = '20261007182000_lawn_v13_matrix_adds_round2';
const W = matrix.WINDOWS;
const N = staged.NAMES;

// [window, product, old trigger, new trigger]. The new text lists every use the recipe line now names.
const TRIGGERS = [
  [W.OCT, N.VEL, 'mapped_large_patch_with_artavia', 'mapped_large_patch_with_artavia_fairy_ring_dollar_spot_rust_leaf_spot'],
  [W.NOV, N.VEL, 'mapped_large_patch', 'mapped_large_patch_dollar_spot_rust_leaf_spot'],
  [W.JUN, N.ART, 'gray_leaf_spot', 'gray_leaf_spot_pythium_root_rot'],
  [W.AUG, N.ART, 'gray_leaf_spot', 'gray_leaf_spot_pythium_root_rot'],
  [W.SEP, N.ART, 'mapped_take_all_fall_1', 'mapped_take_all_fall_1_pythium_root_rot'],
];

// Gate added to rows of the July window: the 0-0-50 spreader row.
const SAFETY_GATE = 'fertilizerSafety';

const LABEL = 'Advion Fire Ant Bait label, EPA Reg. No. 100-1481';
const ADVION_LIMITS = [
  { limit_type: 'min_interval_days', limit_value: 84, limit_unit: 'days', severity: 'hard_block', description: `Advion Fire Ant Bait: at least 12 weeks between applications (${LABEL}).` },
  { limit_type: 'annual_max_apps', limit_value: 4, limit_unit: 'applications', severity: 'hard_block', description: `Advion Fire Ant Bait: at most 4 applications a year at 1.5 lb per acre = 6 lb per acre a year (${LABEL}).` },
];

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

// ── Staged rows ──────────────────────────────────────────────────────────────

async function patchGates(knex, protocolId) {
  const windows = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocolId }).select('id', 'window_key');
  const byKey = new Map(windows.map((window) => [window.window_key, window.id]));
  const updates = [];
  const apply = async (windowKey, matches, changes) => {
    const windowId = byKey.get(windowKey);
    if (!windowId) return;
    for (const row of await knex('lawn_protocol_products').where({ lawn_protocol_window_id: windowId }).select('id', 'product_name', 'gates')) {
      if (!matches(row)) continue;
      const gates = asObject(row.gates);
      const entry = { rowId: row.id, gates: {} };
      for (const [key, after] of Object.entries(changes(gates))) entry.gates[key] = { before: gates[key] ?? null, after };
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, ...Object.fromEntries(Object.entries(entry.gates).map(([key, change]) => [key, change.after])) }), updated_at: knex.fn.now() });
      updates.push(entry);
    }
  };
  for (const [windowKey, product, oldTrigger, newTrigger] of TRIGGERS) {
    await apply(windowKey, (row) => row.product_name === product && asObject(row.gates).trigger === oldTrigger, () => ({ trigger: newTrigger }));
  }
  await apply(W.JUL, (row) => row.product_name === matrix.SOP && asObject(row.gates)[SAFETY_GATE] !== true, () => ({ [SAFETY_GATE]: true }));
  return updates;
}

// ── Limits ───────────────────────────────────────────────────────────────────

async function insertAdvionLimits(knex) {
  if (!(await knex.schema.hasTable('product_limits'))) return null;
  const productId = await resolveProductId(knex, matrix.ADVION);
  if (!productId) { console.log(`[lawn-v13-matrix-adds-round2] no catalog row for ${matrix.ADVION}; no limits written`); return null; }
  const inserted = [];
  for (const spec of ADVION_LIMITS) {
    if (await knex('product_limits').where({ product_id: productId, limit_type: spec.limit_type }).first('id')) continue;
    const row = { product_id: productId, match_type: 'product', ...spec };
    const [made] = await knex('product_limits').insert(row).returning('id');
    inserted.push({ id: made && typeof made === 'object' ? made.id : made, ...row });
  }
  return inserted.length ? { productId, limits: inserted } : null;
}

const REQUIRED = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key')) {
    const updates = await patchGates(knex, protocol.id);
    if (!updates.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['gates']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ updates }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
  const limits = await insertAdvionLimits(knex);
  if (limits) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: ACTOR,
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: CATALOG_ACTION,
      changed_fields: JSON.stringify(['limits']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify(limits),
      metadata: JSON.stringify({ migration: MIGRATION }),
    });
  }
};

// ── Down ─────────────────────────────────────────────────────────────────────

async function protocolReferenced(knex, protocol) {
  if (await knex.schema.hasTable('scheduled_services')) {
    if (await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id')) return true;
  }
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return false;
  const completion = await knex('lawn_protocol_service_completions')
    .where({ lawn_protocol_id: protocol.id })
    .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
    .first('id');
  return Boolean(completion);
}

// 181000's down() reverts without a live check: leave it nothing to revert while a protocol is live.
async function neutralizeEarlier(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: fixes.ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    if (after.keptLive) continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id })
      .update({ after_snapshot: JSON.stringify({ arena: null, headway: [], advion: null, keptLive: after }) });
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  let live = false;
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key')) {
    if (await protocolReferenced(knex, protocol)) { live = true; break; }
  }
  if (live) {
    await neutralizeEarlier(knex);
    console.log(`[lawn-v13-matrix-adds-round2] a visit or completion references ${V13_VERSION}: 20261007181000 will not revert; rows and limits kept`);
  }

  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  for (const log of logs) {
    const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
    if (protocol && await protocolReferenced(knex, protocol)) continue;
    for (const entry of asObject(log.after_snapshot).updates || []) {
      const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'gates');
      if (!row) continue;
      const gates = asObject(row.gates);
      for (const [key, change] of Object.entries(entry.gates || {})) {
        if (!isDeepStrictEqual(gates[key], change.after)) continue;
        if (change.before == null) delete gates[key]; else gates[key] = change.before;
      }
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  if (live) return;

  for (const log of await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot')) {
    for (const written of asObject(log.after_snapshot).limits || []) {
      const row = await knex('product_limits').where({ id: written.id }).first();
      const fields = ['product_id', 'match_type', 'limit_type', 'limit_value', 'limit_unit', 'severity', 'description'];
      // limit_value is a pg decimal ('84.0000'): numbers compare as numbers.
      const same = (field) => (field === 'limit_value' ? Number(row[field]) === Number(written[field]) : String(row[field] ?? '') === String(written[field] ?? ''));
      if (row && fields.every(same)) await knex('product_limits').where({ id: written.id }).del();
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.TRIGGERS = TRIGGERS;
exports.SAFETY_GATE = SAFETY_GATE;
exports.ADVION_LIMITS = ADVION_LIMITS;
