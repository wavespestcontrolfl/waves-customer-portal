/**
 * The lawn protocol rows on LESCO Crosscheck Plus carry its label's 25 ft water setback in the minDistanceFromWaterFt gate (label page
 * 7: "For soil or foliar applications, do not apply by ground within 25 feet of lakes, reservoirs, rivers, permanent streams, marshes or
 * natural ponds, estuaries and commercial fish farm ponds."). Migration 20261119010000 moved Talak's rows to Crosscheck by link and name
 * only, so they kept Talak's gates; AGENTS.md "Lawn protocol data fan-out": a product change reaches the rows' gates. The plan and the
 * tank sheet show the gate as a required note (waveguard-plan-engine V13_GATE_NOTES: "Keep 25 ft from ponds, lakes and canals; skip that
 * strip."), and the pre-visit brief hands the technician the row's whole gate object. Tetrino's rows carry the same gate.
 *
 * A row on the Crosscheck catalog row whose setback is missing or under 25 ft gets 25 ft; a wider setback stays. Nothing else in the
 * gates changes. The rows are read FOR UPDATE and each write is guarded by the gates it replaces. One lawn_protocol_audit_log row per
 * protocol, with before and after. Nothing is done without exactly one Crosscheck catalog row. down() gives a row back its old setback
 * (none: the gate comes off) only while the row still holds 25 ft, and deletes its audit row once every row it names is restored.
 * Production: the 15 rows 20261119010000 moves, none with the gate (read 2026-11-19).
 */
const MIGRATION = '20261119010500_crosscheck_water_setback_gate';
const LOG = '[crosscheck-water-setback]';
const ACTOR = 'migration 20261119010500';
const LAWN_ACTION = 'crosscheck_water_setback'; // lawn_protocol_audit_log.action is varchar(40)
const CROSSCHECK = 'LESCO Crosscheck Plus';
const GATE = 'minDistanceFromWaterFt';
const SETBACK_FT = 25;

// gates is jsonb NOT NULL (default {}): pg hands it back parsed, and a JSON string is read the same way. Anything else is no gate object.
function gateObject(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function protocolOfWindow(knex, rows) {
  const ids = rows.map((row) => row.lawn_protocol_window_id).filter(Boolean);
  const windows = ids.length ? await knex('lawn_protocol_windows').whereIn('id', ids).select('id', 'lawn_protocol_id') : [];
  return new Map(windows.map((window) => [String(window.id), window.lawn_protocol_id]));
}

async function writeAudit(knex, byProtocol, crosscheck) {
  for (const { protocolId, before, after } of byProtocol.values()) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocolId || crosscheck.id,
      action: LAWN_ACTION,
      changed_fields: JSON.stringify(['gates']),
      before_snapshot: JSON.stringify({ rows: before }),
      after_snapshot: JSON.stringify({ rows: after }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: GATE, feet: SETBACK_FT }),
    });
  }
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocol_audit_log']))) return;
  const named = await knex('products_catalog').where({ name: CROSSCHECK }).select('id');
  if (named.length !== 1) {
    console.log(`${LOG} ${named.length} catalog rows are named "${CROSSCHECK}": nothing to do`);
    return;
  }
  const crosscheck = named[0];
  // Locked until the migration commits, so each audit snapshot is the gates its update replaced.
  const rows = await knex('lawn_protocol_products').where({ product_id: crosscheck.id })
    .select('id', 'gates', 'lawn_protocol_window_id').forUpdate();
  const protocols = await protocolOfWindow(knex, rows);
  const byProtocol = new Map();
  for (const row of rows) {
    const before = gateObject(row.gates);
    if (!before || Number(before[GATE]) >= SETBACK_FT) continue;
    const after = { ...before, [GATE]: SETBACK_FT };
    const changed = await knex('lawn_protocol_products').where({ id: row.id, gates: JSON.stringify(before) })
      .update({ gates: JSON.stringify(after) });
    if (!changed) continue;
    const protocolId = protocols.get(String(row.lawn_protocol_window_id)) || null;
    const key = protocolId || 'none';
    if (!byProtocol.has(key)) byProtocol.set(key, { protocolId, before: [], after: [] });
    byProtocol.get(key).before.push({ rowId: row.id, gates: before });
    byProtocol.get(key).after.push({ rowId: row.id, gates: after });
  }
  await writeAudit(knex, byProtocol, crosscheck);
};

// The old setback goes back (none: the gate comes off) only while the row still holds 25 ft; any other gate edited since stays.
async function restoreRow(knex, rowId, oldGates) {
  const row = await knex('lawn_protocol_products').where({ id: rowId }).first('id', 'gates');
  const gates = gateObject(row && row.gates);
  if (!gates || gates[GATE] !== SETBACK_FT) return 0;
  const { [GATE]: _written, ...rest } = gates;
  const restored = oldGates && oldGates[GATE] != null ? { ...rest, [GATE]: oldGates[GATE] } : rest;
  return knex('lawn_protocol_products').where({ id: rowId, gates: JSON.stringify(gates) }).update({ gates: JSON.stringify(restored) });
}

exports.down = async function down(knex) {
  if (!(await hasTables(knex, ['lawn_protocol_products', 'lawn_protocol_audit_log']))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: LAWN_ACTION }).select('id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    const before = new Map((gateObject(log.before_snapshot)?.rows || []).map((row) => [String(row.rowId), row.gates]));
    let kept = 0;
    for (const written of gateObject(log.after_snapshot)?.rows || []) {
      if (await restoreRow(knex, written.rowId, before.get(String(written.rowId)))) continue;
      kept += 1;
      console.log(`${LOG} protocol row ${written.rowId} no longer holds the ${SETBACK_FT} ft setback up() wrote: kept`);
    }
    if (!kept) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.MIGRATION = MIGRATION;
exports.LAWN_ACTION = LAWN_ACTION;
exports.GATE = GATE;
exports.SETBACK_FT = SETBACK_FT;
