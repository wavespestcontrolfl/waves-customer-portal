/**
 * Fusilade II default rate: back to NULL on the catalog row 20261006190400 created
 * (GATE_LAWN_BERMUDA_REMOVAL). 190400 wrote default_rate_per_1000 = 0.55, which is the BERMUDA MIX
 * spot rate (a backpack line on mapped bermuda areas), not a label broadcast rate. Every reader that
 * prefills a rate from the catalog (a hand-added Fusilade II row, an inventory estimate) would apply
 * 0.55 fl oz per 1,000 sq ft as a lawn-wide rate. The step's own rate stays on the staged v13 rows
 * (rate_per_1000 0.55), where the plan and the tank sheet read it.
 *
 * Only the Fusilade II row 190400 created (found through its audit_log rows, kind catalog_row), and only
 * while the default still equals exactly 0.55 (an admin value is left alone). Recognition's default
 * (0.03 oz) is left as it is: it is the step's own stated rate, and this migration does not change a
 * value it cannot back with a label read.
 *
 * Audit is append-only: a ':seeded' event per row changed (before 0.55, after null). down() restores
 * 0.55 only where the column is still null, appends a ':reverted' event per original event id, and
 * skips an original that already has one.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006220700_bermuda_fusilade_default_rate_null';
const SEEDED = `migration:${MIGRATION}:seeded`;
const REVERTED = `migration:${MIGRATION}:reverted`;
const CATALOG_SEEDED = 'migration:20261006190400_lawn_bermuda_removal_catalog:seeded';
const NAME = 'Fusilade II Post Emergent Liquid Herbicide';
const BEFORE = 0.55;

const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const created = (await knex('audit_log').where({ action: CATALOG_SEEDED, resource_type: 'products_catalog' }).select('resource_id', 'metadata'))
    .filter((row) => meta(row).kind === 'catalog_row' && meta(row).name === NAME);
  for (const row of created) {
    const updated = await knex('products_catalog').where({ id: row.resource_id }).whereRaw('default_rate_per_1000 = ?', [BEFORE])
      .update({ default_rate_per_1000: null, updated_at: knex.fn.now() });
    if (!updated) continue;
    await recordAuditEvent({
      actor_type: 'system', action: SEEDED, resource_type: 'products_catalog', resource_id: String(row.resource_id),
      metadata: { migration: MIGRATION, column: 'default_rate_per_1000', before: BEFORE, after: null }, critical: true, trx: knex,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const seeded = await knex('audit_log').where({ action: SEEDED }).select('id', 'resource_id');
  const done = new Set((await knex('audit_log').where({ action: REVERTED }).select('metadata')).map((row) => String(meta(row).originalAuditId)));
  for (const row of seeded) {
    if (done.has(String(row.id))) continue;
    const restored = (await knex('products_catalog').where({ id: row.resource_id }).whereNull('default_rate_per_1000')
      .update({ default_rate_per_1000: BEFORE, updated_at: knex.fn.now() })) > 0;
    await recordAuditEvent({
      actor_type: 'system', action: REVERTED, resource_type: 'products_catalog', resource_id: String(row.resource_id),
      metadata: { migration: MIGRATION, originalAuditId: row.id, column: 'default_rate_per_1000', restored }, critical: true, trx: knex,
    });
  }
};
