// Follows 20261127260000_sprayer_owner_estimates, which changed the active calibration rows of tank #2 and the FlowZone in place
// to the owner's estimates (owner 2026-11-27, "we will use the best guess"). Past visits and reports point at those rows by id and
// read their status (and, for an assigned visit, their number) live, so an in-place change rewrites what an old visit used.
// Recording a calibration in the admin retires the old row and inserts a new one; this does the same after the fact, for each
// row that migration changed: the old row gets back the exact values it had (from that migration's audit event) and is retired,
// and a copy holding the owner estimate becomes the active row. Tank #1 (only its expiry went) is left as it is.
//
// A row is split only while it is still active and still holds exactly what the first migration wrote (an admin edit since then
// wins, and is logged); the checks are in the write's own WHERE, and a second run changes nothing. Each split writes one critical
// audit_log event. down() merges a split back only while the new row is still active and unchanged, and never throws.

const MIGRATION = '20261127270000_sprayer_estimate_new_rows';
const LOG = '[20261127270000]';
const ACTION = `migration:${MIGRATION}:split`;
const FIRST_ACTION = 'migration:20261127260000_sprayer_owner_estimates:calibration';
const SPLIT_SYSTEMS = new Set(['Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun', 'FlowZone Typhoon 3.0 #1']);

const parse = (metadata) => (typeof metadata === 'string' ? JSON.parse(metadata) : metadata);
// The WHERE that pins a row to the values written: numbers by their numeric value, NULL by IS NULL, text by equality.
function pinned(query, values) {
  for (const [column, value] of Object.entries(values)) {
    if (value == null) query.whereNull(column);
    else if (typeof value === 'number') query.whereRaw('?? = ?', [column, value]);
    else query.where(column, value);
  }
  return query;
}

async function hasTables(knex) {
  for (const table of ['equipment_calibrations', 'audit_log']) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function events(knex, action) {
  const rows = await knex('audit_log').where({ action }).orderBy('created_at', 'asc').select('resource_id', 'metadata');
  return rows.map((row) => ({ id: row.resource_id, metadata: parse(row.metadata) || {} }));
}

async function split(knex, event) {
  const { before, after, system_name: name } = event.metadata;
  const row = await pinned(knex('equipment_calibrations').where({ id: event.id, active: true }), after).forUpdate().first();
  if (!row) {
    console.log(`${LOG} "${name}" calibration ${event.id} changed or retired since the owner estimate: kept`);
    return;
  }
  const retired = await pinned(knex('equipment_calibrations').where({ id: row.id, active: true }), after)
    .update({ ...before, active: false, updated_at: knex.fn.now() });
  if (!retired) return;
  const { id: _id, created_at: _created, updated_at: _updated, ...copy } = row;
  const [inserted] = await knex('equipment_calibrations').insert({ ...copy, active: true, updated_at: knex.fn.now() }).returning('id');
  const newId = inserted?.id ?? inserted;
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: ACTION, resource_type: 'equipment_calibrations', resource_id: String(newId),
    metadata: { migration: MIGRATION, system_name: name, old_id: row.id, before, after }, critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  const done = new Set((await events(knex, ACTION)).map((event) => event.metadata.old_id));
  for (const event of await events(knex, FIRST_ACTION)) {
    if (!SPLIT_SYSTEMS.has(event.metadata.system_name) || !event.metadata.before || !event.metadata.after || done.has(event.id)) continue;
    await split(knex, event);
  }
};

exports.down = async function down(knex) {
  try {
    if (!(await hasTables(knex))) return;
    for (const event of (await events(knex, ACTION)).reverse()) {
      const { old_id: oldId, before, after } = event.metadata;
      if (!oldId || !before || !after) continue;
      // Merge back only while the old row still holds its restored values and the new one is still active and unchanged.
      const old = await pinned(knex('equipment_calibrations').where({ id: oldId, active: false }), before).forUpdate().first('id');
      const retired = old ? await pinned(knex('equipment_calibrations').where({ id: event.id, active: true }), after)
        .update({ active: false, updated_at: knex.fn.now() }) : 0;
      if (!retired) {
        console.log(`${LOG} down: calibration ${event.id} or ${oldId} changed since up(): kept`);
        continue;
      }
      await pinned(knex('equipment_calibrations').where({ id: oldId, active: false }), before)
        .update({ ...after, active: true, updated_at: knex.fn.now() });
    }
  } catch (err) {
    console.log(`${LOG} down failed, rows kept: ${err.message}`);
  }
};
