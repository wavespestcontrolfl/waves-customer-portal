/**
 * Active ingredient for the Recognition catalog row that 20261006190400 created
 * (GATE_LAWN_BERMUDA_REMOVAL). 190400 left active_ingredient empty because none was given;
 * the wording the repo already uses for this product (server/data/pricing.csv, and the
 * correction in 20260808000001) is 'Trifloxysulfuron-sodium 20.4% + metcamifen (safener)'.
 * Compliance reads and product pickers use the field.
 *
 * Only a Recognition row 190400 created is touched, found through its audit_log rows
 * (action migration:20261006190400_lawn_bermuda_removal_catalog:seeded, kind catalog_row),
 * and only where active_ingredient is still empty (a prod row, or one an admin filled, is
 * left alone). Audit is append-only: each change adds a ':seeded' event; down() appends a
 * ':reverted' event per original event id and sets the field back to null only while it
 * still equals the value written here; an original that already has a reverted event is skipped.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006220400_bermuda_recognition_active_ingredient';
const SEEDED = `migration:${MIGRATION}:seeded`;
const REVERTED = `migration:${MIGRATION}:reverted`;
const CATALOG_SEEDED = 'migration:20261006190400_lawn_bermuda_removal_catalog:seeded';
const NAME = 'Recognition Post Emergent Herbicide';
const ACTIVE_INGREDIENT = 'Trifloxysulfuron-sodium 20.4% + metcamifen (safener)';

const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const created = (await knex('audit_log').where({ action: CATALOG_SEEDED, resource_type: 'products_catalog' }).select('resource_id', 'metadata'))
    .filter((row) => meta(row).kind === 'catalog_row' && meta(row).name === NAME);
  for (const row of created) {
    const updated = await knex('products_catalog').where({ id: row.resource_id }).where((q) => q.whereNull('active_ingredient').orWhere('active_ingredient', ''))
      .update({ active_ingredient: ACTIVE_INGREDIENT, updated_at: knex.fn.now() });
    if (!updated) continue;
    await recordAuditEvent({
      actor_type: 'system', action: SEEDED, resource_type: 'products_catalog', resource_id: String(row.resource_id),
      metadata: { migration: MIGRATION, column: 'active_ingredient', before: null, after: ACTIVE_INGREDIENT }, critical: true, trx: knex,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const seeded = await knex('audit_log').where({ action: SEEDED }).select('id', 'resource_id');
  const done = new Set((await knex('audit_log').where({ action: REVERTED }).select('metadata')).map((row) => String(meta(row).originalAuditId)));
  for (const row of seeded) {
    if (done.has(String(row.id))) continue;
    const restored = (await knex('products_catalog').where({ id: row.resource_id, active_ingredient: ACTIVE_INGREDIENT })
      .update({ active_ingredient: null, updated_at: knex.fn.now() })) > 0;
    await recordAuditEvent({
      actor_type: 'system', action: REVERTED, resource_type: 'products_catalog', resource_id: String(row.resource_id),
      metadata: { migration: MIGRATION, originalAuditId: row.id, column: 'active_ingredient', restored }, critical: true, trx: knex,
    });
  }
};

exports.ACTIVE_INGREDIENT = ACTIVE_INGREDIENT;
