// The sprayer numbers the owner settled on 2026-11-27 ("I am not going to calibrate them. We will use the best guess."):
//   - "110-Gallon Spray Tank #1": in place, only expires_at -> NULL, only while it is active, field_verified, at 2.0. Its status
//     and number stay, so past visits read the same.
//   - "Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun": 4.0 gal per 1,000 sq ft (its LESCO MAG1 gun runs the stock nozzle).
//   - "FlowZone Typhoon 3.0 #1": 2.0 gal per 1,000 sq ft (2,000 sq ft per 4 gal).
//   For tank #2 and the FlowZone, the active row is retired AS IS and a copy becomes the active row with the new number, status
//   owner_estimate, no expiry, its note, and each coverage figure the row holds recomputed from the new number. This is what
//   recording a calibration in the admin does, so past visits and reports keep the row they used. Only while the active row is
//   status 'estimated' at the number read live (tank #2 2.0, FlowZone 1.33): a field test, or any other state, is kept and logged.
//   - Gun links in the equipment list (equipment_systems.gun_asset_id), only where none is set: tank #1 -> "LESCO Lawn Spray Gun"
//     (Chemlawn Spray Gun 007433), tank #2 -> "LESCO MAG1 Original Spray Gun" (MAG1 052979). Exact names, one row each.
// Every change writes one critical audit_log event with the exact old row (and the new row's id), and a second run changes
// nothing. down() undoes each change only while the row still holds exactly what up() wrote: a new row that nothing points at
// is deleted and the old row is active again; tank #1 gets its old expiry back only while it is still NULL; a gun link is cleared
// only while it is still the one set here. It never throws: a failure is logged and the rows stay.

const MIGRATION = '20261128100000_sprayer_best_guess';
const LOG = '[20261128100000]';
const ACTION = `migration:${MIGRATION}`;
const SQ_FT_PER_ACRE = 43560;

const TANK_1 = '110-Gallon Spray Tank #1';
const TANK_2 = 'Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun';
const FLOWZONE = 'FlowZone Typhoon 3.0 #1';

const NEW_ROWS = [
  {
    name: TANK_2, live: 2, carrier: 4,
    note: 'Owner estimate 2026-11-27: 4.0 gal per 1,000 sq ft. LESCO MAG1 metal gun with its stock nozzle (about 3 to 7 gpm; the Udor pump tops out near 4.75 gpm), against the Honda tank\'s 2 gpm tip at 2.0. Not a sprayer test.',
  },
  {
    name: FLOWZONE, live: 1.33, carrier: 2,
    note: 'Owner estimate 2026-11-27: 2.0 gal per 1,000 sq ft, for area-rated products and area estimates. Spot products mix per gallon from the label. Not a sprayer test.',
  },
];
const GUNS = [
  { system: TANK_1, gun: 'LESCO Lawn Spray Gun' },
  { system: TANK_2, gun: 'LESCO MAG1 Original Spray Gun' },
];

const sameNumber = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-6;
const parse = (metadata) => (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) || {};

async function hasTables(knex) {
  for (const table of ['equipment_calibrations', 'equipment_systems', 'audit_log']) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function audit(knex, step, resourceType, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: `${ACTION}:${step}`, resource_type: resourceType, resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata }, critical: true, trx: knex,
  });
}

// The one active calibration of the named system, locked, with the system's tank size; or null (logged).
async function activeRow(knex, name) {
  const rows = await knex('equipment_calibrations as ec').join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where({ 'es.name': name, 'ec.active': true }).select('ec.*', 'es.tank_capacity_gal as system_tank_gal').forUpdate('ec');
  if (rows.length === 1) return rows[0];
  console.log(`${LOG} "${name}": ${rows.length} active calibrations, need one: kept`);
  return null;
}

// Each coverage figure the row holds, recomputed from the new number (a figure the row leaves empty stays empty).
function coverage(row, carrier) {
  const tankGal = Number(row.tank_size_gallons || row.system_tank_gal) || null;
  const fullSqFt = tankGal ? Math.round((tankGal / carrier) * 1000) : null;
  const out = {};
  if (row.estimated_sq_ft_per_4gal_tank != null) out.estimated_sq_ft_per_4gal_tank = Math.round((4 / carrier) * 1000);
  if (row.estimated_sq_ft_per_full_tank != null && fullSqFt) out.estimated_sq_ft_per_full_tank = fullSqFt;
  if (row.estimated_acres_per_full_tank != null && fullSqFt) out.estimated_acres_per_full_tank = Number((fullSqFt / SQ_FT_PER_ACRE).toFixed(3));
  return out;
}

// The columns that are not part of a copy: its identity, timestamps, and the joined tank size.
function plainRow(row) {
  const { system_tank_gal: _tank, ...rest } = row;
  return rest;
}

async function tank1Expiry(knex) {
  const row = await activeRow(knex, TANK_1);
  if (!row || row.expires_at == null) return;
  if (row.calibration_status !== 'field_verified' || !sameNumber(row.carrier_gal_per_1000, 2)) {
    console.log(`${LOG} "${TANK_1}" is ${row.calibration_status} at ${row.carrier_gal_per_1000}, not field_verified at 2.0: kept`);
    return;
  }
  const wrote = await knex('equipment_calibrations').where({ id: row.id, active: true, calibration_status: 'field_verified' })
    .whereRaw('carrier_gal_per_1000 = 2').whereNotNull('expires_at').update({ expires_at: null, updated_at: knex.fn.now() });
  if (wrote) await audit(knex, 'expiry', 'equipment_calibrations', row.id, { system_name: TANK_1, old_expires_at: row.expires_at });
}

async function newRow(knex, change) {
  const row = await activeRow(knex, change.name);
  if (!row) return;
  if (row.calibration_status === 'owner_estimate' && sameNumber(row.carrier_gal_per_1000, change.carrier)) return; // done already
  if (row.calibration_status !== 'estimated' || !sameNumber(row.carrier_gal_per_1000, change.live)) {
    console.log(`${LOG} "${change.name}" is ${row.calibration_status} at ${row.carrier_gal_per_1000}, not estimated at ${change.live}: kept`);
    return;
  }
  const retired = await knex('equipment_calibrations').where({ id: row.id, active: true, calibration_status: 'estimated' })
    .whereRaw('carrier_gal_per_1000 = ?', [change.live]).update({ active: false });
  if (!retired) return;
  const old = plainRow(row);
  const { id: _id, created_at: _created, updated_at: _updated, ...copy } = old;
  const wrote = {
    carrier_gal_per_1000: change.carrier, calibration_status: 'owner_estimate', expires_at: null, verification_notes: change.note,
    ...coverage(row, change.carrier),
  };
  const [inserted] = await knex('equipment_calibrations').insert({ ...copy, ...wrote, active: true, updated_at: knex.fn.now() }).returning('*');
  await audit(knex, 'new_row', 'equipment_calibrations', inserted.id, { system_name: change.name, new_id: inserted.id, old_id: row.id, old_row: old, wrote, new_row: inserted });
}

// The one row of the table with this exact name, or null (logged).
async function onlyRow(knex, table, name) {
  const rows = await knex(table).where({ name }).select('id', ...(table === 'equipment_systems' ? ['gun_asset_id'] : []));
  if (rows.length === 1) return rows[0];
  console.log(`${LOG} ${table} "${name}": ${rows.length} rows, need one: gun not linked`);
  return null;
}

async function linkGuns(knex) {
  if (!(await knex.schema.hasTable('equipment')) || !(await knex.schema.hasColumn('equipment_systems', 'gun_asset_id'))) return;
  for (const { system, gun } of GUNS) {
    const systemRow = await onlyRow(knex, 'equipment_systems', system);
    const gunRow = systemRow && !systemRow.gun_asset_id ? await onlyRow(knex, 'equipment', gun) : null;
    if (!gunRow) continue;
    const wrote = await knex('equipment_systems').where({ id: systemRow.id }).whereNull('gun_asset_id')
      .update({ gun_asset_id: gunRow.id, updated_at: knex.fn.now() });
    if (wrote) await audit(knex, 'gun', 'equipment_systems', systemRow.id, { system_name: system, gun_name: gun, gun_asset_id: gunRow.id });
  }
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  await tank1Expiry(knex);
  for (const change of NEW_ROWS) await newRow(knex, change);
  await linkGuns(knex);
};

// Anything that points at a calibration row (a visit's completion or assignment) keeps it: down() then leaves the change.
async function referenced(knex, id) {
  for (const [table, column] of [['lawn_protocol_service_completions', 'calibration_id'], ['scheduled_services', 'assigned_calibration_id']]) {
    if (await knex.schema.hasTable(table) && await knex.schema.hasColumn(table, column) && await knex(table).where(column, id).first(column)) return true;
  }
  return false;
}

// The new row is still exactly as up() inserted it: every column but updated_at (an admin edit through the calibration route
// changes at least one other column).
const norm = (value) => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};
const unchangedSince = (row, inserted) => Object.keys(inserted).filter((column) => column !== 'updated_at')
  .every((column) => norm(row[column]) === norm(inserted[column]));

async function undoNewRow(knex, metadata) {
  const row = await knex('equipment_calibrations').where({ id: metadata.new_id, active: true }).forUpdate().first();
  const old = await knex('equipment_calibrations').where({ id: metadata.old_id, active: false }).forUpdate().first('id');
  if (!row || !old || !metadata.new_row || !unchangedSince(row, metadata.new_row) || await referenced(knex, metadata.new_id)) return false;
  await knex('equipment_calibrations').where({ id: metadata.new_id }).del();
  await knex('equipment_calibrations').where({ id: metadata.old_id }).update({ active: true });
  return true;
}

const UNDO = {
  new_row: (knex, event) => undoNewRow(knex, event.metadata),
  expiry: (knex, event) => knex('equipment_calibrations').where({ id: event.resource_id, active: true }).whereNull('expires_at')
    .update({ expires_at: event.metadata.old_expires_at, updated_at: knex.fn.now() }),
  gun: (knex, event) => knex('equipment_systems').where({ id: event.resource_id, gun_asset_id: event.metadata.gun_asset_id })
    .update({ gun_asset_id: null, updated_at: knex.fn.now() }),
};

exports.down = async function down(knex) {
  try {
    if (!(await hasTables(knex))) return;
    const events = await knex('audit_log').where('action', 'like', `${ACTION}:%`)
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).select('action', 'resource_id', 'metadata');
    const done = new Set();
    for (const row of events) {
      const event = { step: row.action.slice(ACTION.length + 1), resource_id: row.resource_id, metadata: parse(row.metadata) };
      const key = `${event.step}:${event.resource_id}`;
      if (done.has(key) || !UNDO[event.step]) continue;
      done.add(key);
      // Each undo in its own savepoint, so one failure leaves the others standing.
      const undone = await knex.transaction((trx) => UNDO[event.step](trx, event)).catch((err) => {
        console.log(`${LOG} down: ${key} failed: ${err.message}`);
        return null;
      });
      if (!undone) console.log(`${LOG} down: ${key} changed since up(), or in use: kept`);
    }
  } catch (err) {
    console.log(`${LOG} down failed, rows kept: ${err.message}`);
  }
};
