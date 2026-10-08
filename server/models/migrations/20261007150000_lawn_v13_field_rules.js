/**
 * Lawn protocol v13, field rules (owner 2026-10-06; evidence: the Fable premise
 * audit of 2026-10-06). Migrations 20261005120000 to 20261007100000 are pushed
 * and frozen; this one adds to the rows they staged. The recipe file
 * (lawn-protocol-v13.json) carries the text; this migration carries the data the
 * plan reads. Three changes, each declared once in RULES below:
 *
 * 1. North Port Nutra-TECH, June, August and September windows: the row gains
 *    `northPortProductWindow`. The plan holds a row with that key back in North
 *    Port (not selected, no amount) and a completion that records the product
 *    there is flagged like the nitrogen ban. The product has no N or P analysis,
 *    so the ordinance check cannot see it; the city fact sheet bans all turf
 *    fertilizing April 1 to September 30 (city confirmation pending).
 * 2. Acelepryn, every staged row: `delayWateringOrMowingHours` 24 (label: delay
 *    watering (irrigation) or mowing for 24 hours after application). No product
 *    level watering rule: its grub use needs the water-in.
 * 3. Dismiss 64 oz leaves the staged windows (use up the jug, do not reorder). A
 *    row a completion actual already references is kept, so no actual loses its
 *    link.
 *
 * Idempotent. One lawn_protocol_audit_log row per protocol (action
 * 'v13_field_rules') holds what was written: the gate keys added (by row id) and
 * the full Dismiss rows deleted. down() takes back exactly that: a gate key only
 * while it still holds the value written here, and every deleted Dismiss row
 * under its own id.
 */

const { isDeepStrictEqual } = require('node:util');

const V13_VERSION = '2026.10-v13';
const ACTION = 'v13_field_rules';
const NUTRA = 'LESCO Nutra-TECH T&O Micronutrient Package';
const ACELEPRYN = 'Acelepryn Insecticide';
const DISMISS = 'Dismiss 64 oz';
const NORTH_PORT_WINDOWS = ['jun_v13_hose_blackout', 'aug_v13_hose_blackout', 'sep_v13_hose_blackout'];
const JSONB_COLUMNS = ['gates', 'annual_counter', 'mixing', 'report_copy'];

// One entry per gate key written: which staged rows get it, and the value.
const RULES = [
  { key: 'northPortProductWindow', value: true, applies: (row) => row.product_name === NUTRA && NORTH_PORT_WINDOWS.includes(row.window_key) },
  { key: 'delayWateringOrMowingHours', value: 24, applies: (row) => row.product_name === ACELEPRYN },
];

const parse = (value, fallback) => {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : fallback;
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

const hasTables = async (knex) => (await Promise.all(['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log']
  .map((table) => knex.schema.hasTable(table)))).every(Boolean);

function stagedRows(knex) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION)
    .select('p.id', 'p.product_name', 'p.gates', 'w.window_key', 'l.id as protocol_id');
}

// The gate keys a row is missing (a key it already carries is never overwritten).
function missingGates(row) {
  const gates = parse(row.gates, {});
  return Object.fromEntries(RULES.filter((rule) => rule.applies(row) && !(rule.key in gates)).map((rule) => [rule.key, rule.value]));
}

async function addGates(knex, rows) {
  const written = {};
  for (const row of rows) {
    const add = missingGates(row);
    if (!Object.keys(add).length) continue;
    await knex('lawn_protocol_products').where({ id: row.id })
      .update({ gates: JSON.stringify({ ...parse(row.gates, {}), ...add }), updated_at: knex.fn.now() });
    written[row.id] = add;
  }
  return written;
}

async function retireDismiss(knex, rows) {
  const ids = rows.filter((row) => row.product_name === DISMISS).map((row) => row.id);
  if (!ids.length) return [];
  const used = new Set((await knex.schema.hasTable('lawn_protocol_product_actuals'))
    ? (await knex('lawn_protocol_product_actuals').whereIn('protocol_product_id', ids).select('protocol_product_id')).map((r) => String(r.protocol_product_id))
    : []);
  const free = ids.filter((id) => !used.has(String(id)));
  if (!free.length) return [];
  const full = await knex('lawn_protocol_products').whereIn('id', free);
  await knex('lawn_protocol_products').whereIn('id', free).del();
  return full;
}

const logRow = (protocolId, before, after) => ({
  lawn_protocol_id: protocolId,
  actor_name: 'migration 20261007150000',
  entity_type: 'protocol',
  entity_id: protocolId,
  action: ACTION,
  changed_fields: JSON.stringify(['gates', 'products']),
  before_snapshot: JSON.stringify(before),
  after_snapshot: JSON.stringify(after),
  metadata: JSON.stringify({ migration: '20261007150000_lawn_v13_field_rules', gate: 'GATE_LAWN_V13' }),
});

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const rows = await stagedRows(knex);
  const protocolIds = [...new Set(rows.map((row) => row.protocol_id))];
  for (const protocolId of protocolIds) {
    const own = rows.filter((row) => row.protocol_id === protocolId);
    const gates = await addGates(knex, own);
    const dismissRows = await retireDismiss(knex, own);
    if (!Object.keys(gates).length && !dismissRows.length) continue;
    await knex('lawn_protocol_audit_log').insert(logRow(protocolId, { dismissRows }, { gates }));
  }
};

async function removeGates(knex, written) {
  for (const [rowId, added] of Object.entries(written || {})) {
    const row = await knex('lawn_protocol_products').where({ id: rowId }).first('id', 'gates');
    if (!row) continue;
    const gates = parse(row.gates, {});
    for (const [key, value] of Object.entries(added)) if (isDeepStrictEqual(gates[key], value)) delete gates[key];
    await knex('lawn_protocol_products').where({ id: rowId }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }
}

async function restoreDismiss(knex, dismissRows) {
  for (const saved of dismissRows || []) {
    const window = await knex('lawn_protocol_windows').where({ id: saved.lawn_protocol_window_id }).first('id');
    const back = window && await knex('lawn_protocol_products').where({ id: saved.id }).first('id');
    if (!window || back) continue;
    const restored = { ...saved };
    for (const column of JSONB_COLUMNS) restored[column] = JSON.stringify(parse(saved[column], {}));
    await knex('lawn_protocol_products').insert(restored);
  }
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    await removeGates(knex, parse(log.after_snapshot, {}).gates);
    await restoreDismiss(knex, parse(log.before_snapshot, {}).dismissRows);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.RULES = RULES;
exports.NAMES = { NUTRA, ACELEPRYN, DISMISS };
exports.NORTH_PORT_WINDOWS = NORTH_PORT_WINDOWS;
exports.missingGates = missingGates;
