// Second backfill of the bermuda removal watering rule (20261006200000, 20261006220000), for catalog
// products those two reached only by EXACT catalog name. A database whose Recognition or Fusilade II
// catalog row is spelled differently (an alias-linked product: the staged bermuda rows resolve it
// through product_aliases) kept an empty post_application_watering, so the mix derived a water-in
// from the product's form instead of the owner's 3-hour hold.
//
// This migration finds the catalog ids the staged bermuda removal rows are LINKED to
// (lawn_protocol_products.product_id where gates.bermudaRemoval) and applies the SAME rule
// (hold, 3 hours, source owner) to the two step herbicides among them, fill-only-empty. The
// surfactant is left to its own v13 rule. Append-only audit (one event per write), documented
// no-op down, as in 200000 and 220000.
const { recordAuditEvent } = require('../../services/audit-log');
const { RULE } = require('./20261006200000_watering_rule_bermuda_removal');

const MIGRATION = '20261006220500_watering_rule_bermuda_removal_alias_backfill';
const HERBICIDE_ROLE = 'post_emergent_spot';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('lawn_protocol_products'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const linked = await knex('lawn_protocol_products')
    .whereRaw("gates->>'bermudaRemoval' = 'true'").where({ role: HERBICIDE_ROLE }).whereNotNull('product_id')
    .distinct('product_id');
  for (const { product_id: id } of linked) {
    const row = await knex('products_catalog').where({ id }).whereNull('post_application_watering').first('id', 'name');
    if (!row) continue;
    const updated = await knex('products_catalog').where({ id }).whereNull('post_application_watering')
      .update({ post_application_watering: JSON.stringify(RULE), updated_at: knex.fn.now() });
    if (!updated || !canAudit) continue;
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:seeded`,
      resource_type: 'products_catalog',
      resource_id: String(row.id),
      metadata: { migration: MIGRATION, product: row.name, before: null, after: RULE },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op: the audit row keeps the before value (null).
exports.down = async function down() {};
