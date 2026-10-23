'use strict';

/**
 * Split the termite checklist's "Flashlight and probe/screwdriver" item into
 * two keyed requirements (docs/tool-inventory-tracker-scope.md, PR 2; Codex
 * P1 on #6497). 20261023000020 keyed that one item as `flashlight`, so any
 * flashlight on the truck cleared the readiness hold with no probe aboard.
 * Now a termite visit requires `flashlight` AND `probe` separately.
 *
 * Admin edits are preserved the same way as the first keying: a row is
 * read-modify-written, the item is split only when its text and key are
 * exactly what the seed left, and an audit row records each changed
 * checklist. down() is a documented no-op: a blanket revert would erase the
 * owner's own checklist edits.
 */
const MIGRATION = '20261023000030_termite_probe_kit_key';
const SEEDED_ITEM = 'Flashlight and probe/screwdriver';
const SEEDED_KEY = 'flashlight';
const SPLIT = [
  { item: 'Flashlight', kit_key: 'flashlight' },
  { item: 'Probe or screwdriver', kit_key: 'probe' },
];

async function audit(knex, id, metadata = {}) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({ actor_type: 'system', action: 'truck_kit_key_seed', resource_type: 'equipment_checklists',
    resource_id: id, metadata: { migration: MIGRATION, ...metadata }, critical: true, trx: knex });
}

function splitItems(groups) {
  let changed = false;
  const after = groups.map((group) => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.items)) return group;
    const items = [];
    for (const item of group.items) {
      if (item && typeof item === 'object' && item.item === SEEDED_ITEM && item.kit_key === SEEDED_KEY) {
        changed = true;
        for (const part of SPLIT) items.push({ ...item, ...part });
      } else {
        items.push(item);
      }
    }
    return { ...group, items };
  });
  return { changed, after };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('equipment_checklists'))) return;
  const rows = await knex('equipment_checklists').where({ service_line: 'termite' });
  for (const row of rows) {
    const before = typeof row.checklist_items === 'string' ? JSON.parse(row.checklist_items) : row.checklist_items;
    if (!Array.isArray(before)) continue;
    const { changed, after } = splitItems(before);
    if (!changed) continue; // Already split, or the owner edited the item by hand.
    await knex('equipment_checklists').where({ id: row.id }).update({ checklist_items: JSON.stringify(after), updated_at: knex.fn.now() });
    await audit(knex, row.id, { before, after });
  }
};

// Documented no-op (waves-db skill): seeded content on an admin-editable row
// is never reverted by a migration.
exports.down = async function down() {};

exports.splitItems = splitItems;
