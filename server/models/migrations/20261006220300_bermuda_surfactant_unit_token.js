/**
 * Unit token fix for the LESCO 90/10 Nonionic Surfactant catalog row that
 * 20261005130000 created (the third product of the bermuda removal mix). That migration
 * wrote rate_unit 'fl oz'; the unit every completion accepts is 'fl_oz'
 * (shared/rate-units.json), so the surfactant row of the mix carried a unit the completion
 * rejects until the tech edited it. (Recognition's 'oz' and, since 20261006220200,
 * Fusilade II's 'fl_oz' are accepted.)
 *
 * 20261005130000 wrote no audit row for its catalog inserts, so the row is identified by
 * what that migration left on it, all together:
 *   exact name 'LESCO 90/10 Nonionic Surfactant'
 *   AND rate_unit exactly 'fl oz'
 *   AND its own provenance note, label_source_note = 'Added for the Waves lawn protocol v13
 *       (owner 2026-10-05); price pending.', with needs_pricing true, content_status 'draft'
 *       and customer_visibility 'internal_only'.
 * A prod row that already existed (a data write, a different note), a row an admin has
 * edited (any of those fields changed, or the unit already changed), is never touched.
 * Unit columns changed: rate_unit, cost_unit, inventory_unit, only where exactly 'fl oz'.
 *
 * Audit is append-only: every change adds an audit_log event (':seeded', with the column,
 * before and after). down() appends a ':reverted' event for each original event id and
 * restores 'fl oz' only where the column still holds 'fl_oz'; it never rewrites an earlier
 * audit row, and an original that already has a reverted event is skipped.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006220300_bermuda_surfactant_unit_token';
const SEEDED = `migration:${MIGRATION}:seeded`;
const REVERTED = `migration:${MIGRATION}:reverted`;
const NAME = 'LESCO 90/10 Nonionic Surfactant';
const PROVENANCE_NOTE = 'Added for the Waves lawn protocol v13 (owner 2026-10-05); price pending.';
const UNIT_COLUMNS = ['rate_unit', 'cost_unit', 'inventory_unit'];
const BEFORE = 'fl oz';
const AFTER = 'fl_oz';

const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('audit_log'))) return;
  // Only the row 20261005130000 created and nobody has touched: its exact provenance, with the old unit.
  const rows = await knex('products_catalog')
    .where({ name: NAME, rate_unit: BEFORE, label_source_note: PROVENANCE_NOTE, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' })
    .select('id');
  for (const row of rows) {
    for (const column of UNIT_COLUMNS) {
      if (!(await knex.schema.hasColumn('products_catalog', column))) continue;
      const updated = await knex('products_catalog').where({ id: row.id, [column]: BEFORE }).update({ [column]: AFTER, updated_at: knex.fn.now() });
      if (!updated) continue;
      await recordAuditEvent({
        actor_type: 'system', action: SEEDED, resource_type: 'products_catalog', resource_id: String(row.id),
        metadata: { migration: MIGRATION, column, before: BEFORE, after: AFTER }, critical: true, trx: knex,
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('audit_log'))) return;
  const seeded = await knex('audit_log').where({ action: SEEDED }).select('id', 'resource_id', 'metadata');
  const done = new Set((await knex('audit_log').where({ action: REVERTED }).select('metadata')).map((row) => String(meta(row).originalAuditId)));
  for (const row of seeded) {
    if (done.has(String(row.id))) continue;
    const { column } = meta(row);
    let restored = false;
    if (UNIT_COLUMNS.includes(column)) {
      restored = (await knex('products_catalog').where({ id: row.resource_id, [column]: AFTER }).update({ [column]: BEFORE, updated_at: knex.fn.now() })) > 0;
    }
    await recordAuditEvent({
      actor_type: 'system', action: REVERTED, resource_type: 'products_catalog', resource_id: String(row.resource_id),
      metadata: { migration: MIGRATION, originalAuditId: row.id, column, restored }, critical: true, trx: knex,
    });
  }
};
