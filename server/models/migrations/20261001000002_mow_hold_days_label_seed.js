// Label mow holds for the two products whose labels state one (lawn report
// rebuild, P2b seed). Owner confirmed both values 2026-10-01:
//   SedgeHammer Plus (EPA 81880-24): "Do not mow turf for 2 days before or
//     2 days after application."                                  -> 2 days
//   Talak 7.9 F (EPA 91234-145): "Postpone watering (irrigation) or mowing
//     for 24 hours after application."                            -> 1 day
//
// Fill-only-empty: a row that already has a value (an admin edit) is never
// overwritten. Matched by EPA reg number where the catalog carries it, else by
// name; a product with no matching row is skipped silently. Every row written
// gets an audit_log entry (before NULL, after the seeded value).
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261001000002_mow_hold_days_label_seed';

const SEEDS = [
  { label: 'SedgeHammer Plus', epa: ['81880-24'], names: ['Sedge%Hammer%'], days: 2 },
  { label: 'Talak 7.9 F', epa: ['91234-145'], names: ['%Talak%'], days: 1 },
];

async function findRows(knex, seed) {
  const byEpa = await knex('products_catalog')
    .whereIn(knex.raw('TRIM(epa_reg_number)'), seed.epa)
    .select('id', 'name', 'epa_reg_number', 'mow_hold_days');
  if (byEpa.length) return byEpa;
  return knex('products_catalog')
    .where((qb) => {
      for (const pattern of seed.names) qb.orWhere('name', 'ilike', pattern);
    })
    .select('id', 'name', 'epa_reg_number', 'mow_hold_days');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'mow_hold_days'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');

  for (const seed of SEEDS) {
    const rows = await findRows(knex, seed);
    for (const row of rows) {
      if (row.mow_hold_days != null) continue; // never overwrite
      const updated = await knex('products_catalog')
        .where({ id: row.id })
        .whereNull('mow_hold_days')
        .update({ mow_hold_days: seed.days, updated_at: knex.fn.now() });
      if (!updated || !canAudit) continue;
      // audit_log.actor_id is a uuid column: the migration identifies itself in
      // action + metadata, as the other data migrations do.
      await recordAuditEvent({
        actor_type: 'system',
        action: `migration:${MIGRATION}:seeded`,
        resource_type: 'products_catalog',
        resource_id: String(row.id),
        metadata: {
          migration: MIGRATION,
          product: row.name,
          epa_reg_number: row.epa_reg_number || null,
          before: null,
          after: seed.days,
          source: 'label',
          confirmed_by: 'owner 2026-10-01',
        },
        critical: true,
        trx: knex,
      });
    }
  }
};

// The seeded values are the labels' own statements and an admin may have
// edited them since; there is nothing safe to restore.
exports.down = async function down() {};
