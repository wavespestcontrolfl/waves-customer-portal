// Suspend PolyZone's EPA registration in the product catalog: 432-1514 (the Bayer number) -> 101563-143 (the current Envu
// registration). Codex #8615 r2: the mosquito card's PolyZone lines carry the label rate (1.1 fl oz per gallon,
// server/config/protocols.json, mosquito), and protocol-label-rate.js applies it only when the catalog row holds the EPA number the
// card names. Production already holds 101563-143 (read 2026-11-26); a database built from the migrations still holds 432-1514
// (20260528000002_inventory_product_data_completion_batch1, 20260712100000_catalog_label_rate_backfill), so its close-out would fall
// back to the catalog band. Label read 2026-11-26: EPA Reg. No. 101563-143, Suspend PolyZone, deltamethrin 4.75%.
//
// The row is locked (FOR UPDATE) and written only while it is the one active "Suspend Polyzone" row and still holds 432-1514: the
// checked values are in the UPDATE's own WHERE. So production (already 101563-143) is unchanged, an admin edit made first wins, and a
// second run changes nothing. The change gets one critical audit_log event with its before and after values.
//
// down() is a documented no-op: the catalog row is admin-editable, and 101563-143 is the registration on the label. To undo by hand,
// read the audit_log event with action "migration:20261126170100_polyzone_epa_registration:catalog_row".

const NAME = 'Suspend Polyzone';
const EPA_BEFORE = '432-1514';
const EPA_AFTER = '101563-143';
const MIGRATION = '20261126170100_polyzone_epa_registration';
const LOG = '[20261126170100]';

exports.up = async function up(knex) {
  for (const table of ['products_catalog', 'audit_log']) if (!(await knex.schema.hasTable(table))) return;
  const rows = await knex('products_catalog').where({ name: NAME, active: true }).select('id', 'epa_reg_number').forUpdate();
  if (rows.length !== 1 || rows[0].epa_reg_number !== EPA_BEFORE) {
    console.log(`${LOG} ${rows.length} active "${NAME}" row(s)${rows.length === 1 ? ` holding ${rows[0].epa_reg_number}` : ''}: kept`);
    return;
  }
  const wrote = await knex('products_catalog').where({ id: rows[0].id, name: NAME, active: true, epa_reg_number: EPA_BEFORE })
    .update({ epa_reg_number: EPA_AFTER, updated_at: knex.fn.now() });
  if (!wrote) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  // Critical: a lost event fails the migration (and rolls its transaction back) instead of leaving an unrecorded catalog change.
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:catalog_row`,
    resource_type: 'products_catalog', resource_id: String(rows[0].id),
    metadata: { migration: MIGRATION, name: NAME, before: { epa_reg_number: EPA_BEFORE }, after: { epa_reg_number: EPA_AFTER } },
    critical: true, trx: knex,
  });
  console.log(`${LOG} "${NAME}" EPA ${EPA_BEFORE} -> ${EPA_AFTER}`);
};

// A documented no-op: see the header.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.EPA_BEFORE = EPA_BEFORE;
exports.EPA_AFTER = EPA_AFTER;
