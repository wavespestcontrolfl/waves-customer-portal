// The Victor snap trap is counted, not weighed (owner 2026-11-25, protocols page pick D9: "Fix the trap unit and method on the
// close-out"). Its catalog row has no default_unit (read 2026-11-26), and the close-out's rate prefill falls back to "oz" for a row with
// none (client/src/lib/product-rate-prefill.js resolveRatePrefill), so every trapping job logged its traps in "oz" (live: 3 of 3 jobs).
// This sets the row's unit to "each", the unit the EVO station row already uses.
// Not here: the application method. A snap trap has no method of its own in the close-out list (station_check, the one it gets today, is a
// station inspection); that is its own change, across the service report.
//
// The row is locked (FOR UPDATE) and written only while it is the one active row of that name and its unit is still empty: the checked
// values are in the UPDATE's own WHERE. So an admin edit made first wins, and a second run changes nothing. The change gets one critical
// audit_log event with its before and after values.
//
// down() is a documented no-op: the catalog row is admin-editable, and "each" is the trap's real unit. To undo by hand, read the
// audit_log event with action "migration:20261126180000_victor_trap_count_unit:catalog_row".

const NAME = 'Victor Expanded Trigger Rat Snap Trap';
const UNIT_AFTER = 'each';
const MIGRATION = '20261126180000_victor_trap_count_unit';
const LOG = '[20261126180000]';

exports.up = async function up(knex) {
  for (const table of ['products_catalog', 'audit_log']) if (!(await knex.schema.hasTable(table))) return;
  const rows = await knex('products_catalog').where({ name: NAME, active: true }).select('id', 'default_unit').forUpdate();
  if (rows.length !== 1 || rows[0].default_unit != null) {
    console.log(`${LOG} ${rows.length} active "${NAME}" row(s)${rows.length === 1 ? ` with unit ${rows[0].default_unit}` : ''}: kept`);
    return;
  }
  // default_unit: null is "IS NULL" in knex's object form.
  const wrote = await knex('products_catalog').where({ id: rows[0].id, name: NAME, active: true, default_unit: null })
    .update({ default_unit: UNIT_AFTER, updated_at: knex.fn.now() });
  if (!wrote) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  // Critical: a lost event fails the migration (and rolls its transaction back) instead of leaving an unrecorded catalog change.
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:catalog_row`,
    resource_type: 'products_catalog', resource_id: String(rows[0].id),
    metadata: { migration: MIGRATION, name: NAME, before: { default_unit: null }, after: { default_unit: UNIT_AFTER } },
    critical: true, trx: knex,
  });
  console.log(`${LOG} "${NAME}" default_unit -> ${UNIT_AFTER}`);
};

// A documented no-op: see the header.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.NAME = NAME;
exports.UNIT_AFTER = UNIT_AFTER;
