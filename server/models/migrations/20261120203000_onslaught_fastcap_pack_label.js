/**
 * The Onslaught Fastcap catalog row's pack label becomes '16 fl oz', the package its numbers already describe. The product is
 * a liquid (CS, microencapsulated), stocked and logged in fl oz; its unit_size_oz is 16, and its best_price is 16 fl oz at the
 * SiteOne gallon's price per fl oz (production's row, read 2026-11-20). Only the label read '32 g', a weight, which came from
 * the import file (server/data/pricing.csv, corrected in the same change).
 *
 * The label matters from this change on: calculateInventoryCost (services/inventory-cost.js) reads it to tell weight ounces
 * from fluid ounces, and it no longer prices a volume amount against a weight package. With '32 g', every Onslaught use
 * logged in fl oz would book no cost.
 *
 * Written only on a row named Onslaught Fastcap (any letter case) whose label is '32 g' and whose unit_size_oz is 16, and
 * the update repeats both conditions, so an office edit is never overwritten. A row of any other shape is left alone. One
 * audit_log row per row written, with before and after. With no audit_log table nothing is written. Down is a documented
 * no-op (waves-db: a data correction never reverts on rollback): putting '32 g' back would only restore a wrong label. The
 * audit row keeps the old label.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261120203000_onslaught_fastcap_pack_label';
const PRODUCT = 'Onslaught Fastcap';
const OLD_LABEL = '32 g';
const NEW_LABEL = '16 fl oz';
const UNIT_SIZE_OZ = 16;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('audit_log'))) return;
  const shape = { container_size: OLD_LABEL, unit_size_oz: UNIT_SIZE_OZ };
  const rows = await knex('products_catalog').whereRaw('LOWER(name) = LOWER(?)', [PRODUCT]).where(shape).select('id', 'name');
  for (const row of rows) {
    const written = await knex('products_catalog').where({ id: row.id, ...shape })
      .update({ container_size: NEW_LABEL, updated_at: knex.fn.now() });
    if (!written) continue;
    // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:label`,
      resource_type: 'products_catalog',
      resource_id: String(row.id),
      metadata: {
        migration: MIGRATION,
        product: row.name,
        unit_size_oz: UNIT_SIZE_OZ,
        before: { container_size: OLD_LABEL },
        after: { container_size: NEW_LABEL },
      },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op: see the header. The audit row keeps the old label.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.PRODUCT = PRODUCT;
exports.OLD_LABEL = OLD_LABEL;
exports.NEW_LABEL = NEW_LABEL;
exports.UNIT_SIZE_OZ = UNIT_SIZE_OZ;
