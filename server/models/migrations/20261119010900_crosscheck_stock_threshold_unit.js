/**
 * The LESCO Crosscheck Plus low-stock threshold that 20261119010000 filled is set in the row's own unit. That migration fills
 * inventory_unit ('fl_oz') and low_stock_threshold (128: one 1 gal jug, as Talak's row holds one 96 fl oz jug) each only while it
 * is NULL, so a row whose unit is already set keeps that unit and takes 128 in it. Production: the receipt reader logged the first
 * two jugs (SiteOne) at 2026-11-19 05:15Z and set the unit to 'gal', with no threshold (read 2026-11-19). The swap alone would set
 * 128 gal, and the row would show low stock at 2 gal and at every level under 128 gal.
 *
 * 20261119010000 is pushed, so it cannot change. Where its catalog event (not rolled back) filled the threshold but not the unit,
 * and the row still holds that 128 in another unit, the threshold becomes one jug in the row's unit (1 gal, 4 qt, 8 pt). In a unit
 * with no such conversion it goes back to NULL, as before the swap. The write is guarded by the unit and threshold it read. One
 * audit_log event records it. Nothing is done without exactly one Crosscheck catalog row or without audit_log. down() is a
 * documented no-op (waves-db: a data correction that keeps office edits is never reverted): after a full rollback the row keeps
 * one jug, because 20261119010000's down() keeps a column that changed since its up().
 */
const MIGRATION = '20261119010900_crosscheck_stock_threshold_unit';
const LOG = '[crosscheck-stock-threshold-unit]';
const SWAP_CATALOG = 'migration:20261119010000_house_bifenthrin_crosscheck:catalog';
const ACTION = `migration:${MIGRATION}:catalog`;
const CROSSCHECK = 'LESCO Crosscheck Plus';
const SWAP_THRESHOLD = 128; // 20261119010000's FILL_IF_NULL value, in its fl_oz
// One 1 gal jug in each unit the row may count stock in. fl_oz is the swap's own unit, so its 128 stays.
const ONE_JUG = new Map([['fl_oz', 128], ['gal', 1], ['gallon', 1], ['gallons', 1], ['qt', 4], ['pt', 8]]);

const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
};
const unitKey = (unit) => String(unit).trim().toLowerCase().replace(/[\s.]+/g, '_');

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// True when a catalog event of the swap that no rollback names filled this row's threshold and not its unit.
async function swapFilledThresholdOnly(knex, crosscheckId) {
  const events = await knex('audit_log').where({ action: SWAP_CATALOG }).select('id', 'resource_id', 'metadata');
  const rollbacks = await knex('audit_log').where({ action: `${SWAP_CATALOG}:rollback` }).select('metadata');
  const reversed = new Set(rollbacks.map((row) => String(asObject(row.metadata).from_audit_id)));
  return events.some((event) => {
    if (reversed.has(String(event.id)) || String(event.resource_id) !== String(crosscheckId)) return false;
    const { changes = {} } = asObject(event.metadata);
    return Boolean(changes.low_stock_threshold) && !changes.inventory_unit;
  });
}

// Critical, so a lost event fails the migration instead of leaving a changed threshold with no record.
async function writeAudit(knex, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: ACTION,
    resource_type: 'products_catalog', resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'audit_log']))) return;
  for (const column of ['inventory_unit', 'low_stock_threshold']) {
    if (!(await knex.schema.hasColumn('products_catalog', column))) return;
  }
  const named = await knex('products_catalog').where({ name: CROSSCHECK }).select('id', 'inventory_unit', 'low_stock_threshold');
  if (named.length !== 1) {
    console.log(`${LOG} ${named.length} catalog rows are named "${CROSSCHECK}": nothing to do`);
    return;
  }
  const [row] = named;
  if (row.inventory_unit == null || Number(row.low_stock_threshold) !== SWAP_THRESHOLD) return;
  if (!(await swapFilledThresholdOnly(knex, row.id))) return;
  const unit = unitKey(row.inventory_unit);
  const after = ONE_JUG.has(unit) ? ONE_JUG.get(unit) : null;
  if (after === SWAP_THRESHOLD) return;
  const changed = await knex('products_catalog')
    .where({ id: row.id, inventory_unit: row.inventory_unit, low_stock_threshold: row.low_stock_threshold })
    .update({ low_stock_threshold: after });
  if (!changed) return;
  await writeAudit(knex, row.id, { product: CROSSCHECK, unit: row.inventory_unit, changes: { low_stock_threshold: { before: SWAP_THRESHOLD, after } } });
  console.log(`${LOG} "${CROSSCHECK}" counts stock in ${row.inventory_unit}: low-stock threshold ${SWAP_THRESHOLD} -> ${after == null ? 'none' : after}`);
};

// Documented no-op: see the header.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.ACTION = ACTION;
