/**
 * Unit token fix for the Fusilade II catalog row that 20261006190400 created
 * (GATE_LAWN_BERMUDA_REMOVAL). 190400 wrote rate_unit 'fl oz', but the unit every completion
 * accepts is 'fl_oz' (shared/rate-units.json): a mix added from that catalog row carried a
 * unit the completion rejects until the tech edited it. The Recognition row's 'oz' is in
 * the list and stays.
 *
 * Only rows 190400 itself created are touched, found through its audit_log rows (action
 * migration:20261006190400_lawn_bermuda_removal_catalog:seeded, kind catalog_row): a prod
 * catalog row that already existed, and any row an admin has edited since, is never changed
 * (the unit is changed only while it is still exactly 'fl oz'). Each change is audited
 * (':seeded' here, with the column and the before and after); down() puts 'fl oz' back only
 * where the column still holds 'fl_oz', then marks the audit rows ':reverted'.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006220200_bermuda_fusilade_unit_token';
const SEEDED = `migration:${MIGRATION}:seeded`;
const REVERTED = `migration:${MIGRATION}:reverted`;
const CATALOG_SEEDED = 'migration:20261006190400_lawn_bermuda_removal_catalog:seeded';
const UNIT_COLUMNS = ['rate_unit', 'cost_unit', 'inventory_unit'];
const BEFORE = 'fl oz';
const AFTER = 'fl_oz';

const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const created = (await knex('audit_log').where({ action: CATALOG_SEEDED, resource_type: 'products_catalog' }).select('resource_id', 'metadata'))
    .filter((row) => meta(row).kind === 'catalog_row');
  for (const row of created) {
    for (const column of UNIT_COLUMNS) {
      if (!(await knex.schema.hasColumn('products_catalog', column))) continue;
      const updated = await knex('products_catalog').where({ id: row.resource_id, [column]: BEFORE }).update({ [column]: AFTER, updated_at: knex.fn.now() });
      if (!updated) continue;
      await recordAuditEvent({
        actor_type: 'system', action: SEEDED, resource_type: 'products_catalog', resource_id: String(row.resource_id),
        metadata: { migration: MIGRATION, column, before: BEFORE, after: AFTER }, critical: true, trx: knex,
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const seeded = await knex('audit_log').where({ action: SEEDED }).select('id', 'resource_id', 'metadata');
  for (const row of seeded) {
    const { column } = meta(row);
    if (UNIT_COLUMNS.includes(column)) await knex('products_catalog').where({ id: row.resource_id, [column]: AFTER }).update({ [column]: BEFORE });
  }
  if (seeded.length) await knex('audit_log').whereIn('id', seeded.map((row) => row.id)).update({ action: REVERTED });
};
