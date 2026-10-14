// Backfill of the bermuda removal watering rule (20261006200000) for catalog rows that
// did not exist when it ran. On a database built from migrations alone, 20261006200000
// found no Recognition or Fusilade II row (they were added later, by 20261006190400, whose
// timestamp sorts before it only on a database that already ran it), so it wrote nothing.
// This migration applies the SAME rule to the two products' rows whose
// post_application_watering is still empty: hold, 3 hours, source owner.
//
// Fill-only-empty by exact catalog name, one audit_log row per write, and a documented
// no-op down (waves-db SKILL), as in 20261006200000. A row an admin or the earlier
// migration already filled is never touched.
const { recordAuditEvent } = require('../../services/audit-log');
const { ITEMS } = require('./20261006200000_watering_rule_bermuda_removal');

const MIGRATION = '20261006220000_watering_rule_bermuda_removal_backfill';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  for (const item of ITEMS) {
    const rows = await knex('products_catalog').where({ name: item.name }).whereNull('post_application_watering').select('id', 'name');
    for (const row of rows) {
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
        .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
      if (!updated || !canAudit) continue;
      await recordAuditEvent({
        actor_type: 'system',
        action: `migration:${MIGRATION}:seeded`,
        resource_type: 'products_catalog',
        resource_id: String(row.id),
        metadata: { migration: MIGRATION, product: row.name, before: null, after: item.rule },
        critical: true,
        trx: knex,
      });
    }
  }
};

// Documented no-op: the audit row keeps the before value (null).
exports.down = async function down() {};
