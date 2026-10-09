/**
 * Mow hold for the bermuda removal herbicides (GATE_LAWN_BERMUDA_REMOVAL, owner plan 2026-10-06:
 * "no mowing 2 days before or after the spray"). The AFTER half is what the customer report states:
 * report-data.js freezes products_catalog.mow_hold_days into each applied product's report facts, and
 * lawn-watering-instruction.js buildMowHold takes the longest valid hold across the visit's products and
 * prints "Mowing: hold off until <clock time>, 2 days after today's treatment." (completion + 2 x 24 h,
 * rounded up to the hour). The BEFORE half is a tech and scheduling condition, carried as the staged rows'
 * noMowDaysBeforeAfter gate note, and is not a report claim.
 *
 * Without a value the report says nothing about mowing for this mix. This sets 2 on the two step
 * herbicides, resolved by the catalog ids the staged bermuda rows are LINKED to (so an alias-spelled
 * product is reached too, like 20261006220500), fill-only-empty: an admin value is never touched. The
 * surfactant is left to the herbicides in the mix (the longest hold applies).
 *
 * Audit is append-only: one ':seeded' event per write. down() is a documented no-op: a still-2 value
 * cannot be told from an admin who set 2 on purpose, and 2 is the plan's own rule either way.
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261006220800_bermuda_mow_hold_days';
const HERBICIDE_ROLE = 'post_emergent_spot';
const MOW_HOLD_DAYS = 2;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('lawn_protocol_products'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'mow_hold_days'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const linked = await knex('lawn_protocol_products')
    .whereRaw("gates->>'bermudaRemoval' = 'true'").where({ role: HERBICIDE_ROLE }).whereNotNull('product_id')
    .distinct('product_id');
  for (const { product_id: id } of linked) {
    const row = await knex('products_catalog').where({ id }).whereNull('mow_hold_days').first('id', 'name');
    if (!row) continue;
    const updated = await knex('products_catalog').where({ id }).whereNull('mow_hold_days')
      .update({ mow_hold_days: MOW_HOLD_DAYS, updated_at: knex.fn.now() });
    if (!updated || !canAudit) continue;
    await recordAuditEvent({
      actor_type: 'system', action: `migration:${MIGRATION}:seeded`, resource_type: 'products_catalog', resource_id: String(row.id),
      metadata: { migration: MIGRATION, product: row.name, column: 'mow_hold_days', before: null, after: MOW_HOLD_DAYS }, critical: true, trx: knex,
    });
  }
};

// Documented no-op: see the header. The audit rows keep the before value (null).
exports.down = async function down() {};

exports.MOW_HOLD_DAYS = MOW_HOLD_DAYS;
