// The sprayer numbers the owner settled on 2026-11-27 ("I am not going to calibrate them. We will use the best guess."). Three
// active equipment_calibrations rows, matched by their equipment_systems.name:
//   - "110-Gallon Spray Tank #1": carrier 2.0 and status field_verified stay; expires_at becomes NULL (from tank counts, no
//     re-test date); verification_notes unchanged.
//   - "Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun": carrier 2.0; status owner_estimate; expires_at NULL; a note.
//   - "FlowZone Typhoon 3.0 #1": carrier 1.33 -> 2.0; status owner_estimate; expires_at NULL; estimated square feet per 4 gal and
//     per full tank 3000 -> 2000; a note.
// It also links each big-tank sprayer to its gun in the equipment list (equipment_systems.gun_asset_id): tank #1 -> "LESCO Lawn
// Spray Gun" (Chemlawn Spray Gun 007433), tank #2 -> "LESCO MAG1 Original Spray Gun" (MAG1 052979). Exact names, one row each, set
// only while gun_asset_id is NULL; down() clears only a link this migration set.
// Each row is locked (FOR UPDATE) and changed only while it still holds the carrier (and, for the FlowZone, the square feet) read
// from production on 2026-11-27, and for tank #2 and the FlowZone only while it is not field verified (an admin's field test wins).
// The checked values are in the write's own WHERE. A row an admin changed first is kept and logged; a second run changes nothing.
// Tank #1 only loses its expiry, in place. Tank #2 and the FlowZone change number or status, so (as recording a calibration in the
// admin does) the old row is retired and a copy with the new values becomes the active row: past visits and reports that point at
// the old row keep the number and status they used. Each change writes one critical audit_log event.
//
// down() undoes each change only while the row still holds exactly what up() wrote (an admin edit since then wins): tank #1 gets
// its expiry back; a replacement is retired and the old row active again. It never throws: a failure is logged and the rows stay.

const MIGRATION = '20261127260000_sprayer_owner_estimates';
const LOG = '[20261127260000]';
const ACTION = `migration:${MIGRATION}:calibration`;
const GUN_ACTION = `migration:${MIGRATION}:gun`;

const TANK_1 = '110-Gallon Spray Tank #1';
const TANK_2 = 'Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun';
const FLOWZONE = 'FlowZone Typhoon 3.0 #1';

const CHANGES = [
  { name: TANK_1, inPlace: true, live: { carrier_gal_per_1000: 2 }, after: { calibration_status: 'field_verified', expires_at: null } },
  {
    name: TANK_2,
    live: { carrier_gal_per_1000: 2 },
    after: {
      carrier_gal_per_1000: 2, calibration_status: 'owner_estimate', expires_at: null,
      verification_notes: 'Owner estimate 2026-11-27: 2.0 gal per 1,000 sq ft. LESCO MAG1 metal gun (not the Chemlawn gun on tank #1); its nozzle is not recorded and sets the output. Not a sprayer test.',
    },
  },
  {
    name: FLOWZONE,
    live: { carrier_gal_per_1000: 1.33, estimated_sq_ft_per_4gal_tank: 3000, estimated_sq_ft_per_full_tank: 3000 },
    after: {
      carrier_gal_per_1000: 2, calibration_status: 'owner_estimate', expires_at: null,
      estimated_sq_ft_per_4gal_tank: 2000, estimated_sq_ft_per_full_tank: 2000,
      verification_notes: 'Owner estimate 2026-11-27: 2.0 gal per 1,000 sq ft, for area-rated products and area estimates. Spot products mix per gallon from the label. Not a sprayer test.',
    },
  },
];

// Each sprayer's gun, by the exact names in equipment_systems and equipment.
const GUNS = [
  { system: TANK_1, gun: 'LESCO Lawn Spray Gun' },
  { system: TANK_2, gun: 'LESCO MAG1 Original Spray Gun' },
];

async function hasTables(knex) {
  for (const table of ['equipment_calibrations', 'equipment_systems', 'audit_log']) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// The one active calibration of the named system, locked, or null (logged).
async function activeRow(knex, name) {
  const rows = await knex('equipment_calibrations as ec')
    .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where({ 'es.name': name, 'ec.active': true })
    .select('ec.*')
    .forUpdate('ec');
  if (rows.length !== 1) {
    console.log(`${LOG} "${name}": ${rows.length} active calibrations, need one: kept`);
    return null;
  }
  return rows[0];
}

const sameNumber = (a, b) => a != null && Math.abs(Number(a) - Number(b)) < 1e-9;
const holds = (row, values) => Object.entries(values).every(([column, value]) => (value == null ? row[column] == null : sameNumber(row[column], value)));
const sameValue = (a, b) => (b == null ? a == null : String(a) === String(b) || sameNumber(a, b));
// The WHERE that pins a row to the values checked: numbers by their numeric value, NULL by IS NULL, text by equality.
function pinned(query, values) {
  for (const [column, value] of Object.entries(values)) {
    if (value == null) query.whereNull(column);
    else if (typeof value === 'number') query.whereRaw('?? = ?', [column, value]);
    else query.where(column, value);
  }
  return query;
}
// An admin's field test on tank #2 or the FlowZone wins over the owner estimate.
const notFieldVerified = (query) => query.where((q) => q.whereNull('calibration_status').orWhereNot('calibration_status', 'field_verified'));

async function writeAudit(knex, id, name, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: ACTION, resource_type: 'equipment_calibrations', resource_id: String(id),
    metadata: { migration: MIGRATION, system_name: name, ...metadata },
    critical: true, trx: knex,
  });
}

// Tank #1: the expiry goes, in place (its number and status stay).
async function changeInPlace(knex, row, change) {
  const before = Object.fromEntries(Object.keys(change.after).map((column) => [column, row[column] ?? null]));
  const wrote = await pinned(knex('equipment_calibrations').where({ id: row.id, active: true }), change.live)
    .update({ ...change.after, updated_at: knex.fn.now() });
  if (wrote) await writeAudit(knex, row.id, change.name, { before, after: change.after });
}

// Tank #2 and the FlowZone: retire the old row, and a copy with the new values becomes the active one.
async function replaceRow(knex, row, change) {
  if (row.calibration_status === 'field_verified') {
    console.log(`${LOG} "${change.name}" is field verified: kept`);
    return;
  }
  const retired = await notFieldVerified(pinned(knex('equipment_calibrations').where({ id: row.id, active: true }), change.live))
    .update({ active: false, updated_at: knex.fn.now() });
  if (!retired) return;
  const { id: _id, created_at: _created, updated_at: _updated, system_name: _name, ...copy } = row;
  const [inserted] = await knex('equipment_calibrations')
    .insert({ ...copy, ...change.after, active: true, updated_at: knex.fn.now() })
    .returning('id');
  const newId = inserted?.id ?? inserted;
  await writeAudit(knex, newId, change.name, { replaced_id: row.id, after: change.after });
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
    const [systemRow, gunRow] = [await onlyRow(knex, 'equipment_systems', system), await onlyRow(knex, 'equipment', gun)];
    if (!systemRow || !gunRow) continue;
    if (systemRow.gun_asset_id) {
      if (systemRow.gun_asset_id !== gunRow.id) console.log(`${LOG} "${system}" already has a gun linked: kept`);
      continue;
    }
    const wrote = await knex('equipment_systems').where({ id: systemRow.id }).whereNull('gun_asset_id')
      .update({ gun_asset_id: gunRow.id, updated_at: knex.fn.now() });
    if (!wrote) continue;
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: GUN_ACTION, resource_type: 'equipment_systems', resource_id: String(systemRow.id),
      metadata: { migration: MIGRATION, system_name: system, gun_name: gun, gun_asset_id: gunRow.id }, critical: true, trx: knex,
    });
  }
}

async function unlinkGuns(knex) {
  const events = await knex('audit_log').where({ action: GUN_ACTION }).select('resource_id', 'metadata');
  for (const event of events) {
    const metadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
    if (!metadata?.gun_asset_id) continue;
    const wrote = await knex('equipment_systems').where({ id: event.resource_id, gun_asset_id: metadata.gun_asset_id })
      .update({ gun_asset_id: null, updated_at: knex.fn.now() });
    if (!wrote) console.log(`${LOG} down: system ${event.resource_id} gun changed since up(): kept`);
  }
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  await linkGuns(knex);
  for (const change of CHANGES) {
    const row = await activeRow(knex, change.name);
    // Already done (a second run): nothing to change.
    if (!row || Object.entries(change.after).every(([column, value]) => sameValue(row[column], value))) continue;
    if (!holds(row, change.live)) {
      console.log(`${LOG} "${change.name}" no longer holds the values read on 2026-11-27 (${JSON.stringify(change.live)}): kept`);
      continue;
    }
    await (change.inPlace ? changeInPlace : replaceRow)(knex, row, change);
  }
};

// Undo one calibration event: tank #1 gets its expiry back; a replacement is retired and the row it replaced is active again.
async function undoCalibration(knex, event, metadata) {
  const current = pinned(knex('equipment_calibrations').where({ id: event.resource_id, active: true }), metadata.after);
  if (!metadata.replaced_id) return current.update({ ...metadata.before, updated_at: knex.fn.now() });
  const retired = await current.update({ active: false, updated_at: knex.fn.now() });
  if (!retired) return 0;
  return knex('equipment_calibrations').where({ id: metadata.replaced_id, active: false }).update({ active: true, updated_at: knex.fn.now() });
}

exports.down = async function down(knex) {
  try {
    if (!(await hasTables(knex))) return;
    await unlinkGuns(knex);
    const events = await knex('audit_log').where({ action: ACTION }).orderBy('created_at', 'desc').select('resource_id', 'metadata');
    const done = new Set();
    for (const event of events) {
      const metadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
      if (done.has(event.resource_id) || !metadata?.after) continue;
      done.add(event.resource_id);
      if (!(await undoCalibration(knex, event, metadata))) console.log(`${LOG} down: calibration ${event.resource_id} changed since up(): kept`);
    }
  } catch (err) {
    console.log(`${LOG} down failed, rows kept: ${err.message}`);
  }
};
