/**
 * Visit-groups catalog backfill (visit-group-scope.md §2 schema note:
 * "groupable — default true recurring residential programs"; prod pre-read
 * 2026-08-30 confirmed all 92 services at groupable=false / group_family
 * NULL, so nothing — not even the office group/split API — can create a
 * visit until this lands).
 *
 * Policy: every ACTIVE recurring field program shares ONE family,
 * 'recurring_property_service' — familiesCompatible() is strict equality,
 * so this single family is what lets the observed real-world pairs (pest ×
 * rodent bait, pest × termite bait/bond, lawn × pest, lawn × tree & shrub)
 * share a stop while leaving the policy narrowable later without a schema
 * change. Deliberately NOT groupable: one-time treatments and inspections
 * (their completion/report flows differ per visit), re-services/callbacks,
 * specialty jobs, and waveguard_membership (a billing program, not a field
 * visit). Key-based so archived rows and future services are untouched.
 */
const GROUPABLE_KEYS = [
  // lawn programs
  'lawn_care_6week', 'lawn_care_monthly', 'lawn_care_quarterly', 'lawn_care_recurring',
  'lawn_tree_shrub_combo',
  // tree & shrub / palm programs
  'tree_shrub_6week', 'tree_shrub_program', 'tree_shrub_quarterly', 'palm_injection_semiannual',
  // mosquito programs
  'mosquito_monthly', 'mosquito_seasonal',
  // pest programs
  'pest_general_bimonthly', 'pest_general_monthly', 'pest_general_quarterly', 'pest_general_semiannual',
  'pest_termite_bait_quarterly',
  // rodent programs
  'rodent_bait_quarterly', 'trap_only_retainer_monthly', 'trap_only_retainer_plus', 'trap_only_retainer_standard',
  // termite programs (bond/renewal rows are billing riders whose comms are
  // already suppressed — grouping them merges the route stop, nothing else)
  'foam_recurring', 'termite_active_annual', 'termite_active_bait_quarterly', 'termite_bait',
  'termite_bond_1yr', 'termite_bond_5yr', 'termite_bond_10yr', 'termite_monitoring', 'termite_renewal',
];

const FAMILY = 'recurring_property_service';

exports.up = async function up(knex) {
  await knex('services')
    .whereIn('service_key', GROUPABLE_KEYS)
    .update({ groupable: true, group_family: FAMILY });
};

exports.down = async function down(knex) {
  await knex('services')
    .whereIn('service_key', GROUPABLE_KEYS)
    .where({ group_family: FAMILY })
    .update({ groupable: false, group_family: null });
};
