/**
 * Completion-lane decision registry — B0 of the universal one-time services
 * plan (docs/design/universal-onetime-services-plan.md §5 Phase B, ratified
 * 2026-07-12).
 *
 * Coverage principle (owner directive 2026-07-12: "encompass ALL the
 * services we provide"): every ACTIVE catalog service must resolve to
 * exactly one completion lane — typed service-report, recurring Service
 * Report V1, compliance project, billing rider, or explicitly
 * owner-excluded. "Generic report in a family that has a typed flow" is a
 * DEFECT, not a lane.
 *
 * Enforcement, mirroring the write-gate contract pattern
 * (tests/intelligence-bar-write-gate-contract.test.js):
 *  - tests/completion-lane-coverage-contract.test.js runs classifyCatalogRow
 *    over the MIGRATED catalog on every CI run — a migration that seeds a
 *    new service without a registry decision (or a typed profile) fails CI.
 *  - ops/agents/completion-lane-coverage.js runs the same classifier against
 *    the LIVE prod catalog (admin-added services included) and exits
 *    non-zero on defects.
 *
 * A key belongs in AT MOST one list below. Typed profiles need no listing —
 * the profile row (completion_mode 'service_report' + project_type pointer)
 * IS the decision.
 */

// Q4 (ratified 2026-07-12): deliberately stay on the project flow — they are
// not customer-report lanes.
const OWNER_EXCLUDED_KEYS = [
  'general_appointment',
  'waveguard_initial_setup',
];

// Q6/W1 (ratified 2026-07-12): universal EXPERIENCE, legal pipeline intact —
// FDACS-13645 / FBC certificate machinery, V1_EXCLUDED_PROJECT_TYPES stays.
const COMPLIANCE_PROJECT_KEYS = [
  'wdo_inspection',
  'termite_slab_pretreat',
];

// Q5 (ratified 2026-07-12): typed cutover blocked on the owner's
// FS 482.226 / FS 482.2265 / FAC 5E-14 review of the inspection + remedial
// lanes (bait-station lane precedent signed off 2026-06-12).
const PENDING_COMPLIANCE_REVIEW_KEYS = [
  'termite_inspection',
  'termite_spot_treatment',
  'termite_pretreatment',
  'termite_trenching',
  'termite_liquid',
];

// Owner-approved cutovers/repoints not yet shipped — classification accepts
// the declared BEFORE state and the typed AFTER state, nothing else (a
// missing profile or an undeclared shape is still a defect — in-flight is
// not a suppression blanket). Remove each entry when its migration lands
// (a stale entry is flagged once the key reads as typed).
// `before`: 'project' (project_required/special_project), 'generic'
// (service_report with no pointer), or 'consultation' (internal_only mode).
const CUTOVER_IN_FLIGHT_KEYS = {
  wildlife_trapping: { before: 'project', note: 'Phase B — typed sectioned form built, cutover migration pending' },
  bed_bug_treatment: { before: 'project', note: 'Phase B — Q2: customer copy approved 2026-07-12, visibility later' },
  cockroach_control: { before: 'project', note: 'Phase B — Q3: flip to the typed cockroach flow' },
  one_time_pest_control: { before: 'project', note: 'Phase B — straggler found by the B0 scan 2026-07-12' },
  rodent_monitoring: { before: 'generic', note: 'PR #2673 — repoint to the typed rodent_bait_station flow' },
  palm_treatment: { before: 'generic', note: 'owner 2026-07-12 — repoint to the typed palm form' },
  lawn_inspection: { before: 'consultation', note: 'owner 2026-07-12 — tie to the lawn-assessment experience; customers get a report' },
};

// Owner 2026-07-12: scheduled as services, but billing riders — invoice line
// + post-service report REFERENCE only. No standalone completion report, and
// NEVER included in reminder SMS. Enforced end state: generic service_report
// profile with delivery 'disabled' (or 'internal_only'); an auto_send rider
// is a defect (20260712400000 flips the four keys). Reminder-SMS exclusion +
// report/invoice reference lines are follow-up work items in the plan.
const BILLING_RIDER_KEYS = [
  'termite_renewal',
  'termite_bond_1yr',
  'termite_bond_5yr',
  'termite_bond_10yr',
];

// Recurring programs whose GENERIC Service Report V1 is the decided lane —
// the standard recurring report is the product, not a fall-through.
const RECURRING_GENERIC_BY_DESIGN = [
  'lawn_care_6week',
  'lawn_care_monthly',
  'lawn_care_quarterly',
  'lawn_care_recurring',
  'lawn_fertilization',
  'lawn_tree_shrub_combo',
  'mosquito_monthly',
  'mosquito_seasonal',
  'pest_general_bimonthly',
  'pest_general_monthly',
  'pest_general_quarterly',
  'pest_general_semiannual',
  'pest_rodent_quarterly',
  'pest_termite_bait_quarterly',
  'waveguard_membership',
];

const ALL_LISTS = {
  owner_excluded: OWNER_EXCLUDED_KEYS,
  compliance_project: COMPLIANCE_PROJECT_KEYS,
  pending_compliance_review: PENDING_COMPLIANCE_REVIEW_KEYS,
  cutover_in_flight: Object.keys(CUTOVER_IN_FLIGHT_KEYS),
  billing_rider: BILLING_RIDER_KEYS,
  recurring_generic_by_design: RECURRING_GENERIC_BY_DESIGN,
};

/**
 * Classify one catalog row (services LEFT JOIN service_completion_profiles).
 *
 * @param {object} row - { service_key, billing_type, completion_mode,
 *   project_type, delivery_mode, profile_active } — profile fields null
 *   when no row.
 * @returns {{ lane: string, flags: string[] }} lane is the resolved
 *   completion lane; flags are defects/inconsistencies (empty = healthy).
 */
function classifyCatalogRow(row) {
  const key = row.service_key;
  const flags = [];
  const listed = Object.entries(ALL_LISTS)
    .filter(([, keys]) => keys.includes(key))
    .map(([name]) => name);
  if (listed.length > 1) {
    flags.push(`registry_conflict:${listed.join('+')}`);
  }
  const lane = listed[0] || null;
  const hasProfile = row.completion_mode != null;
  const profileInactive = hasProfile && row.profile_active === false;
  if (profileInactive) flags.push('profile_inactive');

  const isTyped = row.completion_mode === 'service_report' && !!row.project_type;
  const isProjectMode = row.completion_mode === 'project_required' || row.completion_mode === 'special_project';
  const isConsultation = row.completion_mode === 'internal_only';
  const isGenericReport = row.completion_mode === 'service_report' && !row.project_type;

  if (lane === 'owner_excluded' || lane === 'pending_compliance_review') {
    if (isTyped) flags.push('listed_but_typed:remove_registry_entry_or_revert');
    return { lane, flags };
  }
  if (lane === 'compliance_project') {
    if (!isProjectMode) flags.push(`compliance_key_unexpected_mode:${row.completion_mode || 'none'}`);
    return { lane, flags };
  }
  if (lane === 'cutover_in_flight') {
    // In-flight accepts exactly the declared BEFORE state or the typed
    // AFTER state — a missing profile or any other shape is still the
    // fall-through defect this registry exists to catch (Codex P2).
    const declared = CUTOVER_IN_FLIGHT_KEYS[key];
    const beforeOk = (declared.before === 'project' && isProjectMode)
      || (declared.before === 'generic' && isGenericReport)
      || (declared.before === 'consultation' && isConsultation);
    if (!hasProfile) {
      flags.push('cutover_key_missing_profile:no_decision_recorded_in_db');
    } else if (!beforeOk && !isTyped) {
      flags.push(`cutover_key_unexpected_state:${row.completion_mode || 'none'}/${row.project_type || '-'}`);
    }
    return { lane, flags };
  }
  if (lane === 'billing_rider') {
    // Riders must not run their own customer report lane: generic
    // service_report with delivery disabled/internal_only is the decided
    // end state; auto_send or a typed pointer is a live report lane the
    // owner ruled out (Codex P2).
    if (!hasProfile) {
      flags.push('billing_rider_missing_profile');
    } else if (row.project_type) {
      flags.push('billing_rider_has_typed_pointer');
    } else if (row.completion_mode === 'service_report' && row.delivery_mode === 'auto_send') {
      flags.push('billing_rider_report_lane_active:expected_delivery_disabled');
    }
    return { lane, flags };
  }
  if (lane === 'recurring_generic_by_design') {
    if (row.billing_type === 'one_time') flags.push('recurring_list_but_one_time_billing');
    if (row.project_type) flags.push('recurring_generic_listed_but_typed:remove_registry_entry');
    return { lane, flags };
  }

  // Unlisted keys: the profile itself must be an explicit decision.
  if (isTyped) return { lane: 'typed', flags };
  if (isProjectMode) {
    flags.push('unlisted_project_flow:straggler_needs_cutover_or_registry_decision');
    return { lane: 'legacy_project', flags };
  }
  if (isConsultation) {
    flags.push('unlisted_internal_consultation:needs_owner_decision');
    return { lane: 'consultation', flags };
  }
  if (isGenericReport) {
    flags.push(row.billing_type === 'one_time'
      ? 'generic_report_one_time_key:defect'
      : 'generic_recurring_unlisted:add_to_registry_or_assign_typed_flow');
    return { lane: 'generic_fallthrough', flags };
  }
  flags.push('no_completion_decision:no_profile_and_no_registry_entry');
  return { lane: 'undecided', flags };
}

module.exports = {
  OWNER_EXCLUDED_KEYS,
  COMPLIANCE_PROJECT_KEYS,
  PENDING_COMPLIANCE_REVIEW_KEYS,
  CUTOVER_IN_FLIGHT_KEYS,
  BILLING_RIDER_KEYS,
  RECURRING_GENERIC_BY_DESIGN,
  ALL_LISTS,
  classifyCatalogRow,
};
