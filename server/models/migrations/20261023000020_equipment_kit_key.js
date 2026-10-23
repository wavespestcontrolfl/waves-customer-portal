'use strict';

/**
 * equipment.kit_key, and kit keys on the seeded equipment checklists
 * (docs/tool-inventory-tracker-scope.md, PR 2; read only behind GATE_TRUCK_KIT).
 *
 * A kit key names WHAT a tool is (moisture_meter, bg_sprayer) independent of
 * the row's name, so a service type's required tools (equipment_checklists
 * items carrying the same key) can be matched against what a truck carries.
 * The office sets a row's key on Equipment → Assets; this migration keys the
 * seeded checklist items whose text is unchanged. Admin edits are preserved:
 * rows are read-modify-written, an item is touched only when its text matches
 * exactly and it carries no key yet, and an audit row records each changed
 * checklist. down() drops only the column; the checklist keys stay, since a
 * blanket revert would erase keys the owner added by hand.
 */
const MIGRATION = '20261023000020_equipment_kit_key';

// Seeded item text (20260401000026_service_protocols.js,
// 20260506000008_pest_termite_protocol_templates.js) → kit key. Rig parts
// (pump, reel, nozzles), consumables and PPE carry no key: the rig has its own
// calibration readiness and stock is company inventory, not a truck count.
const KEYS = {
  lawn: {
    'LESCO push spreader — calibrated': 'push_spreader',
    'Soil probe (thatch)': 'soil_probe',
    'Soil thermometer': 'soil_thermometer',
  },
  pest: {
    'B&G 1 gal sprayer (interior)': 'bg_sprayer',
    'FlowZone Typhoon backpack (exterior)': 'backpack_sprayer',
    'Bait gun': 'bait_gun',
    'Webster duster (cobweb sweep)': 'cobweb_duster',
    Flashlight: 'flashlight',
  },
  tree_shrub: {
    'FlowZone backpack — charged': 'backpack_sprayer',
    'Hand lens/loupe': 'hand_lens',
    'Hand spreader': 'hand_spreader',
  },
  termite: {
    'Flashlight and probe/screwdriver': 'flashlight',
    'Moisture meter': 'moisture_meter',
    'Foam drill kit and patch materials': 'foam_drill_kit',
    'Bait station keys and replacement cartridges': 'bait_station_key',
  },
  mosquito: {
    'Backpack mist blower or sprayer charged/primed': 'backpack_sprayer',
  },
};

async function audit(knex, type, id, metadata = {}) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({ actor_type: 'system', action: 'truck_kit_key_seed', resource_type: type,
    resource_id: id, metadata: { migration: MIGRATION, ...metadata }, critical: true, trx: knex });
}

function keyedItems(groups, map) {
  let changed = false;
  const after = groups.map((group) => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.items)) return group;
    return { ...group, items: group.items.map((item) => {
      if (!item || typeof item !== 'object' || item.kit_key || !map[item.item]) return item;
      changed = true;
      return { ...item, kit_key: map[item.item] };
    }) };
  });
  return { changed, after };
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('equipment') && !(await knex.schema.hasColumn('equipment', 'kit_key'))) {
    await knex.schema.alterTable('equipment', (t) => { t.string('kit_key', 60).nullable().index(); });
  }
  if (!(await knex.schema.hasTable('equipment_checklists'))) return;
  const rows = await knex('equipment_checklists').whereIn('service_line', Object.keys(KEYS));
  for (const row of rows) {
    const before = typeof row.checklist_items === 'string' ? JSON.parse(row.checklist_items) : row.checklist_items;
    if (!Array.isArray(before)) continue;
    const { changed, after } = keyedItems(before, KEYS[row.service_line]);
    if (!changed) continue; // Already keyed, or every matching item was edited by hand.
    await knex('equipment_checklists').where({ id: row.id }).update({ checklist_items: JSON.stringify(after), updated_at: knex.fn.now() });
    await audit(knex, 'equipment_checklists', row.id, { before, after });
  }
};

// Seed rollbacks are never destructive (waves-db skill): the checklist keys
// stay. Only the column goes.
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('equipment', 'kit_key')) {
    await knex.schema.alterTable('equipment', (t) => { t.dropColumn('kit_key'); });
  }
};

exports.KEYS = KEYS;
