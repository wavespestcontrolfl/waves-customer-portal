// The general pest tank carries 2.5 fl oz of LESCO Crosscheck Plus, not 4 (owner 2026-11-25, protocols page pick D21, "fix the label
// failures"; client/src/lib/pest-default-mix.js has the label arithmetic). The close-out records 2.5 from this release on, so the cost
// rows that price a regular pest visit's Crosscheck (service_product_usage, read by the inventory cost pages) move with it: the three
// regular pest mappings each hold one Crosscheck row at 4 fl_oz (read 2026-11-26), and each becomes 2.5 fl_oz.
// Not touched: the mosquito barrier's Crosscheck row (3 oz, its own label use) and every other product's row.
//
// A row is locked (FOR UPDATE) and written only while it still holds 4 fl_oz for the one active Crosscheck catalog row: the checked values
// are in the UPDATE's own WHERE. So an office edit made first wins, and a second run changes nothing. Each changed row gets one critical
// audit_log event with its before and after values.
//
// down() is a documented no-op: the rows are office-editable, and 2.5 is what a visit uses. To undo by hand, read the audit_log events
// with action "migration:20261126220000_pest_crosscheck_tank_amount:usage".

const NAME = 'LESCO Crosscheck Plus';
const SERVICE_TYPES = ['Quarterly Pest Control', 'Bi-Monthly Pest Control', 'General Pest Perimeter'];
const UNIT = 'fl_oz';
const AMOUNT_BEFORE = 4;
const AMOUNT_AFTER = 2.5;
const MIGRATION = '20261126220000_pest_crosscheck_tank_amount';
const LOG = '[20261126220000]';

exports.up = async function up(knex) {
  for (const table of ['products_catalog', 'service_product_usage', 'audit_log']) if (!(await knex.schema.hasTable(table))) return;
  const products = await knex('products_catalog').where({ name: NAME, active: true }).select('id');
  if (products.length !== 1) {
    console.log(`${LOG} ${products.length} active "${NAME}" row(s): nothing changed`);
    return;
  }
  const productId = products[0].id;
  const rows = await knex('service_product_usage').where({ product_id: productId, usage_unit: UNIT }).whereIn('service_type', SERVICE_TYPES)
    .select('id', 'service_type', 'usage_amount').forUpdate();
  const { recordAuditEvent } = require('../../services/audit-log');
  for (const row of rows) {
    if (Number(row.usage_amount) !== AMOUNT_BEFORE) {
      console.log(`${LOG} ${row.service_type}: ${row.usage_amount} ${UNIT}, kept`);
      continue;
    }
    const wrote = await knex('service_product_usage')
      .where({ id: row.id, product_id: productId, usage_unit: UNIT, usage_amount: AMOUNT_BEFORE })
      .update({ usage_amount: AMOUNT_AFTER, updated_at: knex.fn.now() });
    if (!wrote) continue;
    // Critical: a lost event fails the migration (and rolls its transaction back) instead of leaving an unrecorded cost change.
    await recordAuditEvent({
      actor_type: 'system', action: `migration:${MIGRATION}:usage`,
      resource_type: 'service_product_usage', resource_id: String(row.id),
      metadata: { migration: MIGRATION, service_type: row.service_type, product: NAME, before: { usage_amount: AMOUNT_BEFORE, usage_unit: UNIT }, after: { usage_amount: AMOUNT_AFTER, usage_unit: UNIT } },
      critical: true, trx: knex,
    });
    console.log(`${LOG} ${row.service_type}: ${NAME} ${AMOUNT_BEFORE} -> ${AMOUNT_AFTER} ${UNIT}`);
  }
};

// A documented no-op: see the header.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.NAME = NAME;
exports.SERVICE_TYPES = SERVICE_TYPES;
exports.AMOUNT_BEFORE = AMOUNT_BEFORE;
exports.AMOUNT_AFTER = AMOUNT_AFTER;
