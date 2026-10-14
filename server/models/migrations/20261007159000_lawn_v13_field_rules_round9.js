/**
 * Lawn protocol v13, field rules round 9 (Codex round 9 on #6098). Migrations through
 * 20261007158000 are pushed and frozen.
 *
 * The fertilizer safety block (deflector shield, 10 ft water band, storm / flood / tropical hold,
 * sweep hard surfaces, Manatee BMP decal) lived only in the recipe file, which the job card's
 * structured procedure and the wiki-synced SOP do not read. Every staged N-carrying spreader row (a
 * row whose gates name a targetN) gains gates.fertilizerSafety = true; the job card and the SOP
 * print the one block from services/lawn-fertilizer-safety.js for a window with such a row. A hose
 * visit has no such row and prints nothing. No block text is copied into the rows.
 *
 * Idempotent. One lawn_protocol_audit_log row per protocol (action 'v13_field_rules_r9') holds the
 * row ids written. down() takes the key back only while it still reads true, and leaves a protocol a
 * visit or a completion references alone (a rollback never drops safety data from a protocol in use).
 */

const V13_VERSION = '2026.10-v13';
const ACTION = 'v13_field_rules_r9';
const GATE = 'fertilizerSafety';

const parse = (value, fallback) => {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : fallback;
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

const hasTables = async (knex) => (await Promise.all(['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log']
  .map((table) => knex.schema.hasTable(table)))).every(Boolean);

const carriesN = (gates) => gates.targetN != null;

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION)
    .select('p.id', 'p.gates', 'l.id as protocol_id');
  const written = new Map();
  for (const row of rows) {
    const gates = parse(row.gates, {});
    if (!carriesN(gates) || GATE in gates) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, [GATE]: true }), updated_at: knex.fn.now() });
    written.set(row.protocol_id, [...(written.get(row.protocol_id) || []), row.id]);
  }
  for (const [protocolId, rowIds] of written) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007159000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['gates']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rowIds }),
      metadata: JSON.stringify({ migration: '20261007159000_lawn_v13_field_rules_round9', gate: 'GATE_LAWN_V13' }),
    });
  }
};

// The reference test the earlier v13 gate migrations apply, per protocol.
async function isReferenced(knex, protocol) {
  if ((await knex.schema.hasTable('scheduled_services'))
    && await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id')) return true;
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return false;
  return Boolean(await knex('lawn_protocol_service_completions')
    .where({ lawn_protocol_id: protocol.id })
    .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
    .first('id'));
}

async function removeGate(knex, rowIds) {
  for (const rowId of rowIds || []) {
    const row = await knex('lawn_protocol_products').where({ id: rowId }).first('id', 'gates');
    const gates = row ? parse(row.gates, {}) : null;
    if (!gates || gates[GATE] !== true) continue;
    delete gates[GATE];
    await knex('lawn_protocol_products').where({ id: rowId }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  const logs = await knex('lawn_protocol_audit_log as a')
    .leftJoin('lawn_protocols as l', 'a.lawn_protocol_id', 'l.id')
    .where('a.action', ACTION)
    .select('a.id', 'a.after_snapshot', 'l.id as protocol_id', 'l.protocol_key');
  for (const log of logs) {
    // A referenced protocol keeps its gates (and the audit row that names them).
    if (log.protocol_id && await isReferenced(knex, { id: log.protocol_id, protocol_key: log.protocol_key })) continue;
    await removeGate(knex, parse(log.after_snapshot, {}).rowIds);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};
