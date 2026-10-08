/**
 * Lawn protocol v13, field rules round 7 (Codex round 7 on #6098). 20261007150000,
 * 20261007155000 and 20261007157000 are pushed and frozen; this one finishes retiring Dismiss.
 *
 * 1. A Dismiss row 150000 kept (a completion actual references it, and the actual's
 *    protocol_product_id is ON DELETE SET NULL, so deleting it would lose the link) stayed in the
 *    protocol window and could still be offered. lawn_protocol_products has no active or retired
 *    column, so the row keeps its place and gains gates.retired = true; the operating-layer reader
 *    (getProtocolWindowContext, the one reader the plan, the previsit brief and the completion
 *    context share) leaves a retired row out of the window's products. The row, its id and every
 *    actual that points at it stay as they were.
 * 2. The staged window goals still named the repeat sedge spots Dismiss covered (November and
 *    December). They now read as the recipe does: no repeat sedge spots.
 *
 * Idempotent. One lawn_protocol_audit_log row per protocol (action 'v13_field_rules_r7') holds what
 * was written. down() takes back exactly that: a goal only while it still reads what this migration
 * wrote, the retired key only while it still reads true.
 */

const { isDeepStrictEqual } = require('node:util');

const V13_VERSION = '2026.10-v13';
const ACTION = 'v13_field_rules_r7';
const DISMISS = 'Dismiss 64 oz';

// [pattern, replacement] applied in order to a window goal.
const GOAL_EDITS = [
  [/; repeat sedge spots/i, ''],
  [/, weed and repeat sedge spots/i, ' and weed spots'],
];

const parse = (value, fallback) => {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : fallback;
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

const editedGoal = (goal) => GOAL_EDITS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(goal || ''));

const hasTables = async (knex) => (await Promise.all(['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log']
  .map((table) => knex.schema.hasTable(table)))).every(Boolean);

async function retireDismissRows(knex, protocolId) {
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where({ 'w.lawn_protocol_id': protocolId, 'p.product_name': DISMISS })
    .select('p.id', 'p.gates');
  const retired = [];
  for (const row of rows) {
    const gates = parse(row.gates, {});
    if (gates.retired === true) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, retired: true }), updated_at: knex.fn.now() });
    retired.push(row.id);
  }
  return retired;
}

async function editGoals(knex, protocolId) {
  const windows = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocolId }).select('id', 'goal');
  const before = {};
  const after = {};
  for (const window of windows) {
    const goal = editedGoal(window.goal);
    if (goal === (window.goal || '')) continue;
    await knex('lawn_protocol_windows').where({ id: window.id }).update({ goal, updated_at: knex.fn.now() });
    before[window.id] = window.goal;
    after[window.id] = goal;
  }
  return { before, after };
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  for (const { id: protocolId } of protocols) {
    const retired = await retireDismissRows(knex, protocolId);
    const goals = await editGoals(knex, protocolId);
    if (!retired.length && !Object.keys(goals.after).length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007158000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['goal', 'gates']),
      before_snapshot: JSON.stringify({ goals: goals.before }),
      after_snapshot: JSON.stringify({ goals: goals.after, retired }),
      metadata: JSON.stringify({ migration: '20261007158000_lawn_v13_field_rules_round7', gate: 'GATE_LAWN_V13' }),
    });
  }
};

async function restoreGoals(knex, before, after) {
  for (const [windowId, written] of Object.entries(after || {})) {
    const window = await knex('lawn_protocol_windows').where({ id: windowId }).first('id', 'goal');
    if (window && window.goal === written) await knex('lawn_protocol_windows').where({ id: windowId }).update({ goal: before[windowId], updated_at: knex.fn.now() });
  }
}

async function unretire(knex, rowIds) {
  for (const rowId of rowIds || []) {
    const row = await knex('lawn_protocol_products').where({ id: rowId }).first('id', 'gates');
    const gates = row ? parse(row.gates, {}) : null;
    if (!gates || !isDeepStrictEqual(gates.retired, true)) continue;
    delete gates.retired;
    await knex('lawn_protocol_products').where({ id: rowId }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    const after = parse(log.after_snapshot, {});
    await restoreGoals(knex, parse(log.before_snapshot, {}).goals || {}, after.goals);
    await unretire(knex, after.retired);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.editedGoal = editedGoal;
