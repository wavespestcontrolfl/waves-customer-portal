/**
 * Audit record for 20261008140500_catalog_tax_marks_residential (owner ruling
 * 2026-10-08: lawn care and every residential service is non-taxable).
 *
 * That migration set services.is_taxable = false on 34 catalog services in
 * one bulk update, which bypasses the service_catalog.update audit that
 * services/service-library.js writes for an admin edit. This writes one
 * audit event per service so the catalog history shows why the displayed
 * tax setting changed.
 *
 * 140500 is already pushed (frozen) and did not capture which of the 34 rows
 * it changed, so `before` is recorded as unknown here, not guessed: a row an
 * admin had already set to false before 140500 gets the same event, marked
 * by the note below. audit_log is append-only and written through
 * services/audit-log.js.
 */
const DATA_MIGRATION = '20261008140500_catalog_tax_marks_residential';
const MIGRATION = '20261008140600_catalog_tax_marks_audit';
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
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  const rows = await knex('services').whereIn('service_key', KEYS).where({ is_taxable: false })
    .orderBy('service_key').select('id', 'service_key');
  for (const row of rows) {
    await recordAuditEvent({
      actor_type: 'system:migration',
      action: 'service_catalog.update',
      resource_type: 'service',
      resource_id: String(row.id),
      metadata: {
        migration: MIGRATION,
        data_migration: DATA_MIGRATION,
        service_key: row.service_key,
        changed_fields: ['is_taxable'],
        before: null,
        after: { is_taxable: false },
        note: `${DATA_MIGRATION} set is_taxable false where it was true and did not record the prior value per row; a row already false before it is unchanged.`,
        reason: 'Owner ruling 2026-10-08: lawn care and every residential service is non-taxable. Display field only; invoice tax reads service_taxability.',
      },
      trx: knex,
      critical: true,
    });
  }
};

// Documented no-op: audit_log is append-only.
exports.down = async function down() {};
