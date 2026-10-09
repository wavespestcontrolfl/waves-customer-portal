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
 * Sets those 34 to false and makes false the column default, so the library
 * shows what the invoices do. No invoice, estimate or tax rate changes.
 */
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
  await knex('services').whereIn('service_key', KEYS).where({ is_taxable: true }).update({ is_taxable: false });
  await knex.raw('ALTER TABLE services ALTER COLUMN is_taxable SET DEFAULT false');
};

// Restores the column default only. up() does not record which of the 34 rows
// it changed, so setting all 34 back to true could mark a service taxable
// that an admin had already set to not taxable. The column is display only;
// an admin can set any row back in the Service Library.
exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE services ALTER COLUMN is_taxable SET DEFAULT true');
};
