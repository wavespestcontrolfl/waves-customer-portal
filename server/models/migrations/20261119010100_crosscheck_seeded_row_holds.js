/**
 * The LESCO Crosscheck Plus catalog row that migration 20261119010000 (step 0) adds to a catalog with none (every repo-built
 * database: no earlier migration adds it) gets the label's watering hold and mow hold. Migration 20261027190000 wrote both on
 * the Crosscheck row that existed then, and on a repo-built database it ran before the row existed, so it wrote nothing there.
 *
 * This applies that migration's own LESCO Crosscheck Plus entry of its FILL list (imported, so the two cannot disagree):
 * post_application_watering (the 24 h label hold, through validateRule first) and mow_hold_days (1). Each column is written
 * only while it is still empty, so an admin edit stands, and production does not change: its row holds both (read
 * 2026-11-18). One audit_log row per write, with before and after. With no audit_log table nothing is written.
 *
 * Down is a documented no-op, the same as 20261027190000's (waves-db: a data fill never reverts on rollback); the audit rows
 * keep every before value.
 */
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');
const { FILL } = require('./20261027190000_watering_rule_lawn_label_pass_2');

const MIGRATION = '20261119010100_crosscheck_seeded_row_holds';
const CROSSCHECK = 'LESCO Crosscheck Plus';

async function audit(knex, row, kind, before, after) {
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${kind}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, before, after },
    critical: true,
    trx: knex,
  });
}

// The columns to fill: [column, stored value, audited value, audit kind]. Only columns that exist; never a rule validateRule rejects.
async function plannedWrites(knex, item) {
  const writes = [];
  if (await knex.schema.hasColumn('products_catalog', 'post_application_watering') && validateRule(item.rule).valid) {
    writes.push(['post_application_watering', JSON.stringify(item.rule), item.rule, 'seeded']);
  }
  if (item.mowHoldDays && await knex.schema.hasColumn('products_catalog', 'mow_hold_days')) {
    writes.push(['mow_hold_days', item.mowHoldDays, item.mowHoldDays, 'mow_hold_seeded']);
  }
  return writes;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('audit_log'))) return;
  const item = FILL.find((entry) => entry.name === CROSSCHECK);
  if (!item) return;
  const writes = await plannedWrites(knex, item);
  const rows = await knex('products_catalog').where({ name: CROSSCHECK }).select('id', 'name');
  for (const row of rows) {
    for (const [column, value, audited, kind] of writes) {
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull(column)
        .update({ [column]: value, updated_at: knex.fn.now() });
      if (updated) await audit(knex, row, kind, { [column]: null }, { [column]: audited });
    }
  }
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
