/**
 * Catalog tax marks follow the owner's rule (2026-10-08): lawn care and
 * every residential service is non-taxable.
 *
 * services.is_taxable is a Service Library display field only. Invoice tax
 * comes from tax-calculator.js, which reads the service_taxability table
 * (residential_taxable) and the customer's property type; nothing computes
 * tax from this column. But the column defaulted to TRUE, so 34 catalog
 * services added without an explicit choice read "Taxable" in the library
 * while their invoices carry no tax (prod 2026-10-08: 406 residential
 * invoices in 365 days, 2 with tax, $0.36 total, none in the last 90 days).
 *
 * For each of the 34 that is still marked taxable: set it to false and
 * write the same service_catalog.update audit event an admin edit writes
 * (services/audit-log.js), with the real before and after. A row already
 * false is not touched and gets no event, so a replay writes nothing twice.
 * Also makes false the column default. No invoice, estimate or tax rate
 * changes.
 */
const MIGRATION = '20261008141000_catalog_tax_marks_residential';
const KEYS = [
  'bed_bug_treatment', 'cockroach_control', 'dethatching', 'foam_drill', 'foam_recurring',
  'lawn_care_6week', 'lawn_care_one_time', 'lawn_pest_knockdown', 'lawn_re_service', 'lawn_tree_shrub_combo',
  'mosquito_misting_system', 'mosquito_one_time', 'mosquito_seasonal',
  'palm_injection', 'palm_injection_semiannual',
  'pest_initial_german_knockdown', 'pest_initial_palmetto_knockdown', 'pest_re_service',
  'pest_rodent_quarterly', 'pest_termite_bait_quarterly', 'plugging',
  'rodent_bait_quarterly', 'rodent_bait_setup', 'rodent_inspection',
  'rodent_sanitation_heavy', 'rodent_sanitation_light', 'rodent_sanitation_standard',
  'rodent_trap_check_additional', 'rodent_trapping_exclusion', 'rodent_trapping_followup',
  'top_dressing', 'trap_only_retainer_monthly', 'trap_only_retainer_plus', 'trap_only_retainer_standard',
];

exports.up = async function up(knex) {
  const hasAudit = await knex.schema.hasTable('audit_log');
  const rows = await knex('services').whereIn('service_key', KEYS).where({ is_taxable: true })
    .orderBy('service_key').select('id', 'service_key');
  for (const row of rows) {
    const changed = await knex('services').where({ id: row.id, is_taxable: true }).update({ is_taxable: false });
    if (!changed || !hasAudit) continue;
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system:migration',
      action: 'service_catalog.update',
      resource_type: 'service',
      resource_id: String(row.id),
      metadata: {
        migration: MIGRATION,
        service_key: row.service_key,
        changed_fields: ['is_taxable'],
        before: { is_taxable: true },
        after: { is_taxable: false },
        reason: 'Owner ruling 2026-10-08: lawn care and every residential service is non-taxable. Display field only; invoice tax reads service_taxability.',
      },
      trx: knex,
      critical: true,
    });
  }
  await knex.raw('ALTER TABLE services ALTER COLUMN is_taxable SET DEFAULT false');
};

// Restores the column default only. Setting the 34 back to true could mark a
// service taxable that an admin set to not taxable after this ran; the
// column is display only and an admin can set any row in the Service
// Library. audit_log is append-only.
exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE services ALTER COLUMN is_taxable SET DEFAULT true');
};
