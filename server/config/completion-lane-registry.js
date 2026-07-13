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
// Pointer is validated (Codex r2): drift off the compliance project type
// would route the appointment away from the legal pipeline this protects.
const COMPLIANCE_PROJECT_KEYS = {
  wdo_inspection: 'wdo_inspection',
  termite_slab_pretreat: 'pre_treatment_termite_certificate',
};

// Q5 (ratified 2026-07-12): typed cutover blocked on the owner's
// FS 482.226 / FS 482.2265 / FAC 5E-14 review of the inspection + remedial
// lanes (bait-station lane precedent signed off 2026-06-12). CLEARED
// 2026-07-13: the Phase-3 compliance fields + send gates shipped with owner
// signoff (#2703), and 20260713100000 flips the five termite keys
// (termite_inspection, termite_spot_treatment, termite_pretreatment,
// termite_trenching, termite_liquid) to the typed flow keeping their exact
// Jobs-form pointers — they now classify as unlisted typed. The list stays
// for the next family that needs a compliance hold.
const PENDING_COMPLIANCE_REVIEW_KEYS = [];

// Owner-approved cutovers/repoints not yet shipped — classification accepts
// the declared BEFORE state and the typed AFTER state, nothing else (a
// missing profile or an undeclared shape is still a defect — in-flight is
// not a suppression blanket). Remove each entry when its migration lands
// (a stale entry is flagged once the key reads as typed).
// `before`: 'project' (project_required/special_project), 'generic'
// (service_report with no pointer), or 'consultation' (internal_only mode).
// `to`: the expected typed pointer after the cutover (Codex r3 — accepting
// ANY typed pointer would pass a repoint onto the wrong form); null = the
// typed target is not designed yet, any registered typed pointer passes.
const CUTOVER_IN_FLIGHT_KEYS = {
  // Shipped 2026-07-12 and REMOVED from this list (entries come out as
  // their migrations land): wildlife_trapping, cockroach_control,
  // bed_bug_treatment, one_time_pest_control (#2675 — now typed) and
  // rodent_monitoring (#2673 — repointed, catalog row inactive).
  palm_treatment: { before: 'generic', to: 'palm_injection', note: 'owner 2026-07-12 — repoint to the typed palm form, DEFERRED pending typed-palm closeout-gate parity (#2675 r3)' },
  lawn_inspection: { before: 'consultation', to: null, note: 'owner 2026-07-12 — tie to the lawn-assessment experience; customers get a report (typed target TBD)' },
};

// Owner 2026-07-12: scheduled as services, but billing riders — invoice line
// + post-service report REFERENCE only. No standalone completion report, and
// NEVER included in reminder SMS. Enforced end state (Codex r2): completion
// mode 'internal_only' with no pointer — the consultation posture is the
// ONLY mechanism resolveCompletionDeliveryPosture honors for non-typed
// completions (delivery_mode is ignored on generic profiles), and it
// suppresses the report token AND completion comms while keeping the
// service_records audit row. 20260712400000 flips the four keys.
// Reminder-SMS exclusion + report/invoice reference lines are follow-up
// work items in the plan.
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
  // pest_rodent_quarterly RETIRED 2026-07-12 (#2679 + 20260712700000
  // archives the catalog row everywhere) — removed from this list.
  'pest_termite_bait_quarterly',
  'waveguard_membership',
];

// Registered typed findings schemas — a typed pointer that isn't a real
// schema strands the service (no form payload, completion validation
// rejects the unknown type; Codex r3). project-types is a pure data module.
const { PROJECT_TYPES } = require('../services/project-types');

const ALL_LISTS = {
  owner_excluded: OWNER_EXCLUDED_KEYS,
  compliance_project: Object.keys(COMPLIANCE_PROJECT_KEYS),
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

  const pointerRegistered = !!row.project_type && !!PROJECT_TYPES[row.project_type];
  const isTyped = row.completion_mode === 'service_report' && pointerRegistered;
  if (row.completion_mode === 'service_report' && row.project_type && !pointerRegistered) {
    flags.push(`typed_pointer_unregistered_schema:${row.project_type}`);
  }
  const isProjectMode = row.completion_mode === 'project_required' || row.completion_mode === 'special_project';
  const isConsultation = row.completion_mode === 'internal_only';
  const isGenericReport = row.completion_mode === 'service_report' && !row.project_type;

  if (lane === 'owner_excluded' || lane === 'pending_compliance_review') {
    // These keys must stay project-backed — a missing profile or a generic
    // service_report profile regains the default auto-send report lane the
    // exclusion exists to prevent (Codex r2).
    if (isTyped) {
      flags.push('listed_but_typed:remove_registry_entry_or_revert');
    } else if (!hasProfile) {
      flags.push('excluded_key_missing_profile:falls_through_to_generic_report');
    } else if (!isProjectMode) {
      flags.push(`excluded_key_unexpected_mode:${row.completion_mode || 'none'}`);
    }
    return { lane, flags };
  }
  if (lane === 'compliance_project') {
    const expectedPointer = COMPLIANCE_PROJECT_KEYS[key];
    if (!hasProfile) {
      flags.push('compliance_key_missing_profile:falls_through_to_generic_report');
    } else if (!isProjectMode) {
      flags.push(`compliance_key_unexpected_mode:${row.completion_mode || 'none'}`);
    } else if (row.project_type !== expectedPointer) {
      flags.push(`compliance_key_pointer_drift:${row.project_type || 'none'}_expected_${expectedPointer}`);
    }
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
    // Typed AFTER state must land on the declared target form (Codex r3) —
    // a null target means the design is pending and any registered typed
    // pointer passes.
    const afterOk = isTyped && (declared.to === null || row.project_type === declared.to);
    if (!hasProfile) {
      flags.push('cutover_key_missing_profile:no_decision_recorded_in_db');
    } else if (!beforeOk && !afterOk) {
      flags.push(`cutover_key_unexpected_state:${row.completion_mode || 'none'}/${row.project_type || '-'}${isTyped ? `_expected_${declared.to}` : ''}`);
    }
    return { lane, flags };
  }
  if (lane === 'billing_rider') {
    // Riders must not run their own customer report lane. The ONLY posture
    // the runtime honors for non-typed suppression is completion_mode
    // 'internal_only' (resolveCompletionDeliveryPosture ignores
    // delivery_mode on generic profiles — Codex r2), so anything else is a
    // live report lane the owner ruled out.
    if (!hasProfile) {
      flags.push('billing_rider_missing_profile:falls_through_to_generic_report');
    } else if (row.project_type) {
      flags.push('billing_rider_has_typed_pointer');
    } else if (row.completion_mode !== 'internal_only') {
      flags.push(`billing_rider_report_lane_active:${row.completion_mode || 'none'}_expected_internal_only`);
    }
    return { lane, flags };
  }
  if (lane === 'recurring_generic_by_design') {
    // The decided lane IS the recurring Service Report V1 — the profile
    // must stay generic service_report. internal_only (consultation) or a
    // project mode silently suppresses/diverts the customer report
    // (Codex r2); a missing profile still resolves to the default generic
    // report, which matches the decision, so it is accepted.
    if (row.billing_type === 'one_time') flags.push('recurring_list_but_one_time_billing');
    if (row.project_type) flags.push('recurring_generic_listed_but_typed:remove_registry_entry');
    else if (hasProfile && row.completion_mode !== 'service_report') {
      flags.push(`recurring_generic_unexpected_mode:${row.completion_mode || 'none'}_suppresses_the_decided_report`);
    }
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
