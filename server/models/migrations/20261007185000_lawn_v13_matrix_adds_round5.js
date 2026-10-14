/**
 * Lawn protocol v13 matrix adds, Codex round 5 (PR #6116). Migrations 20261007180000 to 20261007184000 are
 * pushed and frozen; this one fixes their data. Every write is guarded, recorded and put back by down().
 *
 *   1. July potash is a 12-visit-plan step. The recipe's July visit now carries a 9-visit variant (scout only,
 *      no potash), so a 9-visit lawn with a July appointment plans no whole-lawn product (the plan picks the
 *      step by plan: lawn-program.js visitForCadence). The staged July 0-0-50 row gets the same condition the
 *      April rows carry for the brief: gates.planVisitsPerYear 12, only where absent.
 *   2. Atomic July. 180000 turned the July window into a spreader window only while the window still held its
 *      original values (an admin-edited window is left alone) and inserted the 0-0-50 as the default tool
 *      regardless. For a protocol whose July window update was skipped, the 0-0-50 row is made non-default
 *      (default_in_plan false), so the window never says "scout, no tool" and "default potash" together.
 *   3. Headway report approval. 184000 approved only the Headway row our migrations inserted; the production
 *      row (not ours: no inserted label note) stays unapproved, so a completion freezes null facts for it.
 *      Its facts are filled only where empty (EPA Reg. No. 100-1216, manufacturer, label source, plain customer
 *      summary), and approved_for_service_report is set true only when every fact the freeze reads is present:
 *      a valid EPA number, a stored valid watering rule, a product type and a customer summary.
 *   4. Rollback. 184000's down() takes back each approval it made. When one of the fields it filled for a
 *      product was edited by an admin since, this migration's down() (which runs first) removes that product's
 *      approval revert from 184000's audit entry (kept under `keptApproval`), so 184000's down leaves the
 *      product approved. This migration's own Headway approval follows the same rule.
 */

const crypto = require('crypto');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');
const round4 = require('./20261007184000_lawn_v13_matrix_adds_round4');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_matrix_adds_round5';
const CATALOG_ACTION = 'v13_matrix_adds_round5_catalog';
const ACTOR = 'migration 20261007185000';
const MIGRATION = '20261007185000_lawn_v13_matrix_adds_round5';
const PLAN_GATE = 'planVisitsPerYear';
const APPROVED = 'approved_for_service_report';
const HEADWAY_EPA = '100-1216';

const isEmpty = (value) => value == null || String(value).trim() === '';
const validEpa = (value) => !isEmpty(value) && !/^(n\/a|not epa|not epa-registered fertilizer|none)$/i.test(String(value).trim());

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// ── 1 and 2: the July 0-0-50 row ─────────────────────────────────────────────

async function julySopRow(knex, protocolId) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where({ 'w.lawn_protocol_id': protocolId, 'w.window_key': matrix.WINDOWS.JUL, 'p.product_name': matrix.SOP })
    .first('p.id', 'p.gates', 'p.default_in_plan');
}

// 180000 skipped this protocol's July window update: its audit row exists and names no window change.
async function julyWindowSkipped(knex, protocolId) {
  const log = await knex('lawn_protocol_audit_log').where({ lawn_protocol_id: protocolId, action: matrix.ACTION }).first('after_snapshot');
  if (!log) return false;
  const windows = asObject(log.after_snapshot).windows;
  return !Array.isArray(windows) || windows.length === 0;
}

async function fixJulyRow(knex, protocolId) {
  const row = await julySopRow(knex, protocolId);
  if (!row) return null;
  const gates = asObject(row.gates);
  const update = {};
  const change = { rowId: row.id, gate: null, defaultInPlan: null };
  if (gates[PLAN_GATE] === undefined) {
    update.gates = JSON.stringify({ ...gates, [PLAN_GATE]: 12 });
    change.gate = { key: PLAN_GATE, after: 12 };
  }
  if (row.default_in_plan === true && await julyWindowSkipped(knex, protocolId)) {
    update.default_in_plan = false;
    change.defaultInPlan = { before: true, after: false };
  }
  if (!Object.keys(update).length) return null;
  await knex('lawn_protocol_products').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
  return change;
}

// ── 3: the production Headway row ─────────────────────────────────────────────

function headwayFill(row) {
  const fill = { ...round4.FACTS.find((fact) => fact.name === matrix.HEAD).fill, epa_reg_number: HEADWAY_EPA };
  return Object.fromEntries(Object.entries(fill).filter(([column]) => isEmpty(row[column])));
}

// Every fact the freeze reads is present: a valid EPA number, a stored valid watering rule, a type and a summary.
function freezeReady(row) {
  const rule = row.post_application_watering != null ? validateRule(row.post_application_watering) : { valid: false };
  return validEpa(row.epa_reg_number) && rule.valid && !isEmpty(row.product_type) && !isEmpty(row.service_report_summary);
}

async function approveProductionHeadway(knex) {
  const row = await knex('products_catalog').where({ name: matrix.HEAD }).first();
  const ours = round4.FACTS.find((fact) => fact.name === matrix.HEAD).owned;
  if (!row || ours(row) || row[APPROVED]) return null;
  const fields = headwayFill(row);
  const after = { ...row, ...fields };
  if (freezeReady(after)) fields[APPROVED] = true;
  if (!Object.keys(fields).length) return null;
  await knex('products_catalog').where({ id: row.id }).update({ ...fields, updated_at: knex.fn.now() });
  return { id: row.id, name: row.name, fields };
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
    const change = await fixJulyRow(knex, protocol.id);
    if (!change) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['gates', 'default_in_plan']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ change }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
  const columns = await knex('products_catalog').columnInfo();
  if (!(APPROVED in columns)) return;
  const headway = await approveProductionHeadway(knex);
  if (!headway) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ approved: [headway] }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// ── down ─────────────────────────────────────────────────────────────────────

// A field written as `written` that no longer holds it was edited since.
const sameValue = (current, written) => (typeof written === 'boolean' ? Boolean(current) === written : current === written);

async function editedSince(knex, made) {
  const row = await knex('products_catalog').where({ id: made.id }).first();
  if (!row) return false;
  return Object.entries(made.fields).some(([column, written]) => column !== APPROVED && !sameValue(row[column], written));
}

// 184000's down() takes back every approval it made: leave the approval of a product an admin edited since.
// A product can have several entries (184000 ran again after an admin un-approved it): one edited field in any
// entry keeps the approval in all of them.
async function keepEditedApprovals(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: round4.ACTION }).select('id', 'after_snapshot');
  const edited = new Set();
  for (const log of logs) {
    for (const made of asObject(log.after_snapshot).approved || []) if (await editedSince(knex, made)) edited.add(String(made.id));
  }
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    let changed = false;
    for (const made of after.approved || []) {
      if (made.fields?.[APPROVED] === undefined || !edited.has(String(made.id))) continue;
      made.keptApproval = made.fields[APPROVED];
      delete made.fields[APPROVED];
      changed = true;
    }
    if (changed) await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify(after) });
  }
}

async function revertHeadway(knex, made) {
  const row = await knex('products_catalog').where({ id: made.id }).first();
  if (!row) return;
  const keep = await editedSince(knex, made);
  const update = {};
  for (const [column, written] of Object.entries(made.fields)) {
    if (!sameValue(row[column], written)) continue;
    if (column === APPROVED) { if (!keep) update[column] = false; } else update[column] = null;
  }
  if (Object.keys(update).length) await knex('products_catalog').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
}

async function revertJulyRow(knex, change) {
  const row = await knex('lawn_protocol_products').where({ id: change.rowId }).first('id', 'gates', 'default_in_plan');
  if (!row) return;
  const update = { updated_at: knex.fn.now() };
  const gates = asObject(row.gates);
  if (change.gate && gates[change.gate.key] === change.gate.after) {
    delete gates[change.gate.key];
    update.gates = JSON.stringify(gates);
  }
  if (change.defaultInPlan && row.default_in_plan === change.defaultInPlan.after) update.default_in_plan = change.defaultInPlan.before;
  await knex('lawn_protocol_products').where({ id: row.id }).update(update);
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  await keepEditedApprovals(knex);
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    const { change } = asObject(log.after_snapshot);
    if (change) await revertJulyRow(knex, change);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
  for (const log of await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot')) {
    for (const made of asObject(log.after_snapshot).approved || []) await revertHeadway(knex, made);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.PLAN_GATE = PLAN_GATE;
