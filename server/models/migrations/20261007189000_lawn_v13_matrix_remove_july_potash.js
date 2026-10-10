/**
 * Lawn protocol v13 matrix adds: the July 0-0-50 potash step is removed (owner ruling expected: December only, no
 * July potash). Migrations 20261007180000 to 20261007188000 are pushed and frozen; this one takes the step back out.
 * July is the scout/inspect visit again, as on main, for the 12-visit and the 9-visit plan.
 *
 * Per v13 protocol:
 *   1. The July 0-0-50 staged row(s) that THIS PR's migrations inserted (180000's audit row lists them) are deleted,
 *      only while a row is exactly what those migrations left (the inserted potash row, plus the gates and default flag
 *      182000 and 185000 put on it: fertilizerSafety, planVisitsPerYear, default_in_plan cleared). A row that differs
 *      (an admin edit), or that a completion actual references, is left and logged.
 *   2. The July window goes back to its pre-180000 shape (visit type, production mode, goal, required tasks) where
 *      180000 changed it and it still reads what 180000 wrote. An admin-edited window is left alone.
 * In the catalog: the LESCO Elite 0-0-50 row STAYS (an unused catalog product, never deleted, its pricing and
 * approval untouched); only the watering rule 180000 wrote on it is cleared, and only while it is unchanged.
 * The earlier migrations' July entries are neutralized (the potash rows, the window change, the safety gate, the
 * 185000 July change and the 0-0-50 watering fill), so rolling the matrix back never brings the potash back.
 *
 * Audited. down() puts all of it back (rows with their ids, the window, the catalog rule, the earlier audit
 * entries), unless a v13 protocol is referenced by a visit or a completion: then it changes nothing (the shared
 * live-rollback guard), like the other matrix migrations.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { anyV13ProtocolReferenced, V13_VERSION } = require('../../services/lawn-v13-rollback-guard');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');
const round2 = require('./20261007182000_lawn_v13_matrix_adds_round2');
const round5 = require('./20261007185000_lawn_v13_matrix_adds_round5');

const ACTION = 'v13_matrix_remove_july_potash';
const CATALOG_ACTION = 'v13_matrix_remove_july_potash_catalog';
const ACTOR = 'migration 20261007189000';
const MIGRATION = '20261007189000_lawn_v13_matrix_remove_july_potash';
const JULY = matrix.WINDOWS.JUL;
const SOP = matrix.SOP;

// What the potash row may carry: the inserted gates, and the ones 182000 and 185000 added.
const INSERTED_GATES = { targetK2O: '0.5 lb K2O/1000', requiresZeroNP: true };
const LATER_GATES = { fertilizerSafety: true, planVisitsPerYear: 12 };

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || []; } catch { return []; }
  }
  return Array.isArray(value) ? value : [];
}

// The row is exactly the potash row the matrix migrations left.
function isMatrixPotashRow(row, productId) {
  if (row.product_name !== SOP || String(row.product_id) !== String(productId)) return false;
  if (row.role !== 'potassium_nutrition' || row.application_mode !== 'broadcast' || row.rate_unit !== 'lb' || Number(row.rate_per_1000) !== 1) return false;
  const gates = asObject(row.gates);
  const allowed = { ...INSERTED_GATES, ...LATER_GATES };
  const keys = Object.keys(gates);
  return Object.keys(INSERTED_GATES).every((key) => isDeepStrictEqual(gates[key], INSERTED_GATES[key]))
    && keys.every((key) => key in allowed && isDeepStrictEqual(gates[key], allowed[key]));
}

async function referencedByActuals(knex, rowId) {
  if (!(await knex.schema.hasTable('lawn_protocol_product_actuals'))) return false;
  return Boolean(await knex('lawn_protocol_product_actuals').where({ protocol_product_id: rowId }).first('id'));
}

// ── The earlier migrations' July entries ─────────────────────────────────────

// Rewrites an audit row's snapshot; returns {id, before} for the record, or null when nothing changed.
async function rewriteAudit(knex, log, change) {
  const before = asObject(log.after_snapshot);
  const after = change(JSON.parse(JSON.stringify(before)));
  if (isDeepStrictEqual(before, after)) return null;
  await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify(after) });
  return { id: log.id, before };
}

async function neutralizeJulyEntries(knex, rowIds, windowIds) {
  const touched = [];
  const keepRow = (entry) => !rowIds.has(String(entry?.id ?? entry?.rowId));
  const changes = [
    [matrix.ACTION, (after) => ({ ...after, inserted: (after.inserted || []).filter(keepRow), windows: (after.windows || []).filter((entry) => !windowIds.has(String(entry.windowId))) })],
    [matrix.CATALOG_ACTION, (after) => ({ ...after, watering: (after.watering || []).filter((entry) => entry.name !== SOP) })],
    [round2.ACTION, (after) => ({ ...after, updates: (after.updates || []).filter(keepRow) })],
    [round5.ACTION, (after) => (after.change && rowIds.has(String(after.change.rowId)) ? { ...after, change: null } : after)],
  ];
  for (const [action, change] of changes) {
    for (const log of await knex('lawn_protocol_audit_log').where({ action }).select('id', 'after_snapshot')) {
      const done = await rewriteAudit(knex, log, change);
      if (done) touched.push(done);
    }
  }
  return touched;
}

// ── up ───────────────────────────────────────────────────────────────────────

async function removablePotashRows(knex, protocolId, productId) {
  const log = await knex('lawn_protocol_audit_log').where({ lawn_protocol_id: protocolId, action: matrix.ACTION }).first('after_snapshot');
  const listed = (asObject(log && log.after_snapshot).inserted || []).filter((entry) => entry.windowKey === JULY && entry.product_name === SOP);
  const rows = [];
  for (const entry of listed) {
    const row = await knex('lawn_protocol_products').where({ id: entry.id }).first();
    if (!row) continue;
    if (!isMatrixPotashRow(row, productId)) { console.log(`[lawn-v13-remove-july-potash] ${row.id} is not the row the matrix left: kept`); continue; }
    if (await referencedByActuals(knex, row.id)) { console.log(`[lawn-v13-remove-july-potash] ${row.id} has completion actuals: kept`); continue; }
    rows.push(row);
  }
  return rows;
}

async function restoreWindow(knex, protocolId) {
  const window = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocolId, window_key: JULY }).first('id', 'visit_type', 'production_mode', 'goal', 'required_tasks');
  const now = matrix.JULY_NEW;
  const unchanged = window && window.visit_type === now.visit_type && window.production_mode === now.production_mode
    && window.goal === now.goal && isDeepStrictEqual(asArray(window.required_tasks), now.required_tasks);
  if (!unchanged) return null;
  const old = matrix.JULY_OLD;
  await knex('lawn_protocol_windows').where({ id: window.id }).update({
    visit_type: old.visit_type, production_mode: old.production_mode, goal: old.goal, required_tasks: JSON.stringify(old.required_tasks), updated_at: knex.fn.now(),
  });
  return { windowId: window.id };
}

const REQUIRED = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  const catalog = await knex('products_catalog').where({ name: SOP }).first('id', 'post_application_watering');
  const rowIds = new Set();
  const windowIds = new Set();
  const perProtocol = [];
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id')) {
    const rows = catalog ? await removablePotashRows(knex, protocol.id, catalog.id) : [];
    for (const row of rows) await knex('lawn_protocol_products').where({ id: row.id }).del();
    const window = await restoreWindow(knex, protocol.id);
    if (!rows.length && !window) continue;
    rows.forEach((row) => rowIds.add(String(row.id)));
    if (window) windowIds.add(String(window.windowId));
    perProtocol.push({ protocolId: protocol.id, rows, window });
  }
  const touched = await neutralizeJulyEntries(knex, rowIds, windowIds);
  for (const entry of perProtocol) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: entry.protocolId,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: entry.protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['products', 'window']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows: entry.rows, window: entry.window }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
  const clearWatering = catalog && catalog.post_application_watering != null
    && isDeepStrictEqual(asObject(catalog.post_application_watering), matrix.WATERING.find((item) => item.name === SOP).rule);
  if (clearWatering) await knex('products_catalog').where({ id: catalog.id }).update({ post_application_watering: null, updated_at: knex.fn.now() });
  if (!touched.length && !clearWatering) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog', 'audit']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId: catalog ? catalog.id : null, clearedWatering: clearWatering ? asObject(catalog.post_application_watering) : null, neutralized: touched }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// ── down ─────────────────────────────────────────────────────────────────────

async function putBackProtocol(knex, record) {
  for (const row of record.rows || []) {
    if (await knex('lawn_protocol_products').where({ id: row.id }).first('id')) continue;
    await knex('lawn_protocol_products').insert({
      ...row,
      gates: JSON.stringify(asObject(row.gates)),
      annual_counter: JSON.stringify(asObject(row.annual_counter)),
      mixing: JSON.stringify(asObject(row.mixing)),
      report_copy: JSON.stringify(asObject(row.report_copy)),
    });
  }
  if (record.window) {
    const now = matrix.JULY_OLD;
    const window = await knex('lawn_protocol_windows').where({ id: record.window.windowId }).first('visit_type', 'production_mode', 'goal', 'required_tasks');
    if (window && window.visit_type === now.visit_type && window.production_mode === now.production_mode && window.goal === now.goal
      && isDeepStrictEqual(asArray(window.required_tasks), now.required_tasks)) {
      const next = matrix.JULY_NEW;
      await knex('lawn_protocol_windows').where({ id: record.window.windowId }).update({
        visit_type: next.visit_type, production_mode: next.production_mode, goal: next.goal, required_tasks: JSON.stringify(next.required_tasks), updated_at: knex.fn.now(),
      });
    }
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  // A rollback on a live protocol is a no-op: the potash stays out.
  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`[lawn-v13-remove-july-potash] a visit or completion references ${V13_VERSION}: nothing restored`);
    return;
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    await putBackProtocol(knex, asObject(log.after_snapshot));
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot')) {
    const record = asObject(log.after_snapshot);
    for (const entry of record.neutralized || []) {
      await knex('lawn_protocol_audit_log').where({ id: entry.id }).update({ after_snapshot: JSON.stringify(entry.before) });
    }
    if (record.clearedWatering && record.productId) {
      await knex('products_catalog').where({ id: record.productId }).whereNull('post_application_watering')
        .update({ post_application_watering: JSON.stringify(record.clearedWatering), updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
