// Centralized spray-trace eligibility (GATE_TRACE_ELIGIBILITY, dark —
// owner-ruled build 2026-08-04, scope doc 2026-08-02).
//
// The Treatment Zone Mapper's trace was eligible everywhere by accident:
// the only exclusions ever added were bed bug (interior lane) and rodent
// trapping (trap lane), each hand-built at the render point after a
// customer-visible defect. Every other decision — capture button, write
// route, eight client render sites, the exterior re-entry advisory — keyed
// on display-name strings independently. This module is the ONE registry:
// `{ eligible, variant, captionKey, reason }` keyed on the stable
// findingsType/serviceKey identity (display names only as the last-resort
// fallback, same posture the bed-bug lane ratified), mirroring
// buildStationMapReportContext's `{available, reason}` contract.
//
// Bias: a service this registry does not recognize is INELIGIBLE
// ('unclassified_service') — a trace asserts "we treated along this line",
// and an unfounded spray claim on a bait/inspection/trapping report is the
// defect this module exists to end. The coverage contract test forces
// every ACTIVE catalog key to classify explicitly, so the default only
// ever bites admin-added keys — which is exactly when the safe answer is
// "no spray claim until classified".
//
// Legacy data: traces already saved on now-ineligible services are
// SUPPRESSED at render (reports recompose at view time), never deleted or
// relabeled.

// Typed lanes first — findingsType is the most specific stable identity
// (the typed pointer), and a typed lane's verdict must not depend on which
// catalog key routed to it.
const FINDINGS_TYPE_RULES = {
  // spray/spatial typed lanes
  // Inspection-capable lanes (codex P1 r6): T&S derives
  // treatments_completed = 'Inspection only' when no products were
  // recorded, and the mosquito + one-time-lawn schemas offer inspection
  // as a first-class completion — an inspection-only visit must not
  // publish a treated map or an exterior re-entry claim.
  tree_shrub: {
    eligible: true, variant: 'spray', captionKey: 'sprayPerimeter', requiresAppliedWork: true,
  },
  mosquito_event: {
    eligible: true, variant: 'spray', captionKey: 'sprayPerimeter', requiresAppliedWork: true,
  },
  // Flea joins the evidence-conditional lanes (codex P1 r5): interior-only
  // and inspection-only completions are first-class choices on its form.
  // OUTLINE geometry (codex P1 r9): the active flea_tick service is a
  // full-yard broadcast (interior as add-on) and the form records "Lawn
  // treatment" — the treated area is the yard, not the building line.
  flea: {
    eligible: true, variant: 'outline', captionKey: 'lawnCoverage', requiresExteriorChip: true,
  },
  // The roach family is CONDITIONAL (codex P1 r3+r4): exterior perimeter
  // treatment is an optional chip on these forms — a German-species
  // cockroach_control visit can be pure interior bait/IGR — so the RENDER
  // verdict requires the recorded exterior chip in the frozen snapshot's
  // treatment values. Capture stays allowed (typedValues absent at
  // capture time → eligible): the tech tracing mid-visit knows what they
  // treated, and the render screen is the customer-facing guarantee.
  cockroach: {
    eligible: true, variant: 'spray', captionKey: 'sprayPerimeter', requiresExteriorChip: true,
  },
  palmetto_roach_knockdown: {
    eligible: true, variant: 'spray', captionKey: 'sprayPerimeter', requiresExteriorChip: true,
  },
  // German knockdown is an INTERIOR bait/IGR program (rooms, harborage,
  // prep — no exterior or perimeter work in its treatment choices at all),
  // so a satellite perimeter trace would be a false exterior claim (codex
  // P1 r3).
  german_roach_knockdown: { eligible: false, reason: 'interior_only_lane' },
  one_time_pest_treatment: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  one_time_lawn_treatment: {
    eligible: true, variant: 'outline', captionKey: 'lawnCoverage', requiresAppliedWork: true,
  },
  // liquid termite family (trench/rod/spot) — a perimeter application IS
  // the product; the compliance certificate lane is excluded separately.
  termite_treatment: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  // nothing is sprayed on these stops — a trace would be a claim the
  // visit cannot support (rodent-trapping ruling, owner 2026-08-02,
  // generalized)
  termite_bait_station: { eligible: false, reason: 'bait_station_lane' },
  rodent_bait_station: { eligible: false, reason: 'bait_station_lane' },
  rodent_trapping: { eligible: false, reason: 'trap_lane' },
  wildlife_trapping: { eligible: false, reason: 'trap_lane' },
  rodent_exclusion: { eligible: false, reason: 'exclusion_lane' },
  rodent_sanitation: { eligible: false, reason: 'sanitation_lane' },
  rodent_inspection: { eligible: false, reason: 'inspection_lane' },
  pest_inspection: { eligible: false, reason: 'inspection_lane' },
  termite_inspection: { eligible: false, reason: 'inspection_lane' },
  wdo_inspection: { eligible: false, reason: 'inspection_lane' },
  bed_bug: { eligible: false, reason: 'interior_only_lane' },
  palm_injection: { eligible: false, reason: 'injection_lane' },
  pre_treatment_termite_certificate: { eligible: false, reason: 'compliance_project_lane' },
};

// Catalog keys (generic lanes have no findingsType). Mirrors the
// completion-lane registry's family groupings.
const SERVICE_KEY_RULES = {
  // recurring + one-time pest: exterior spray is the product
  pest_general_bimonthly: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  pest_general_monthly: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  pest_general_quarterly: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  pest_general_semiannual: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  pest_re_service: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  one_time_pest_control: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  pest_initial_cleanout: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  // Broadcast bait + mound drench priced by LAWN square footage (codex P1
  // r6) — the treated geometry is the yard, not the building perimeter.
  // overridesSnapshot (codex P1 r8): visits completed before the pest
  // un-type migration carry a generic one_time_pest_treatment snapshot
  // whose 'spray' variant would repaint the saved lawn trace as a
  // building perimeter — this key's geometry is more specific than that
  // retired generic pointer.
  fire_ant: {
    eligible: true, variant: 'outline', captionKey: 'lawnCoverage', overridesSnapshot: true,
  },
  tick_control: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  // Individual-nest removal with localized residual on eaves/soffits —
  // never a property-perimeter application (codex P1 r6).
  bee_wasp_removal: { eligible: false, reason: 'localized_treatment_lane' },
  mud_dauber_removal: { eligible: false, reason: 'localized_treatment_lane' },
  // mosquito programs
  mosquito_monthly: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  mosquito_seasonal: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  // Billing construct, not a visit (zero duration, booking disabled) —
  // WaveGuard's actual stops book as the mosquito programs above (codex
  // P2 r4).
  waveguard_membership: { eligible: false, reason: 'billing_rider' },
  // lawn programs — coverage outline/highlight, not a spray-mist replay
  lawn_care_6week: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_care_monthly: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_care_quarterly: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_care_recurring: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_fertilization: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_tree_shrub_combo: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  // liquid termite keys (typed — listed for callers that only have the key)
  termite_liquid: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  termite_trenching: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  termite_pretreatment: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  // Localized foam/drill/wood application by catalog definition — not a
  // perimeter treatment, so a satellite perimeter trace would be a false
  // claim (codex P1 r5). The r4 precedence makes this ineligible KEY beat
  // the eligible termite_treatment findings type it shares.
  termite_spot_treatment: { eligible: false, reason: 'localized_treatment_lane' },
  // Pest-PRIMARY bundle (codex P1 r1): the combined recurring visit sprays
  // the general-pest perimeter and services the bait stations as a
  // COMPANION — the spray application is real, so the trace is too. The
  // station map coexists on the same report; a pure bait stop routes
  // through the termite_bait_station typed pointer above instead.
  pest_termite_bait_quarterly: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  // RETIRED key, 3 historical completed visits deliberately left intact
  // (codex P2 r6): the visit was a perimeter pest treatment with rodent
  // bait as a companion, so its permanent reports keep their legitimate
  // spray maps.
  pest_rodent_quarterly: { eligible: true, variant: 'spray', captionKey: 'sprayPerimeter' },
  // Legacy station keys repointed to termite_bait_station by the typed
  // bait-station cutover — reports completed BEFORE it retain the old
  // eligible termite_treatment snapshot, and only an explicit ineligible
  // KEY rule overrides that stale pointer (codex P1 r8).
  termite_installation_setup: { eligible: false, reason: 'bait_station_lane' },
  termite_cartridge_replacement: { eligible: false, reason: 'bait_station_lane' },
  // never lanes
  bed_bug_treatment: { eligible: false, reason: 'interior_only_lane' },
  termite_slab_pretreat: { eligible: false, reason: 'compliance_project_lane' },
  wdo_inspection: { eligible: false, reason: 'inspection_lane' },
  lawn_inspection: { eligible: false, reason: 'inspection_lane' },
  palm_treatment: { eligible: false, reason: 'injection_lane' },
  general_appointment: { eligible: false, reason: 'appointment_lane' },
  waveguard_initial_setup: { eligible: false, reason: 'appointment_lane' },
  termite_renewal: { eligible: false, reason: 'billing_rider' },
  termite_bond_1yr: { eligible: false, reason: 'billing_rider' },
  termite_bond_5yr: { eligible: false, reason: 'billing_rider' },
  termite_bond_10yr: { eligible: false, reason: 'billing_rider' },
};

// Every alternation fully grouped so EACH token is word-bounded (codex
// P1 r5): ungrouped, only the first token got the leading boundary and
// "Warranty Renewal" matched the embedded "ant".
const INELIGIBLE_NAME_RES = [
  [/\bbed\s*bugs?\b/i, 'interior_only_lane'],
  [/\b(?:rodents?|trap(?:ping|s)?)\b/i, 'trap_lane'],
  [/\binspections?\b/i, 'inspection_lane'],
  [/\bwdo\b/i, 'inspection_lane'],
];
const ELIGIBLE_NAME_RES = [
  [/\b(?:lawn|turf|fertiliz\w*)\b/i, { variant: 'outline', captionKey: 'lawnCoverage' }],
  // Ranked ABOVE the bait check below: combined names like "Quarterly
  // Pest + Termite Bait Station" are pest-PRIMARY bundles — the spray is
  // real (codex P1 r1). A pure "Termite Bait" name matches neither of
  // these and falls to the bait rule.
  [/\b(?:pest|mosquito|spray|trees?|shrubs?|fleas?|ticks?|roach(?:es)?|ants?|wasps?|bees?)\b/i, { variant: 'spray', captionKey: 'sprayPerimeter' }],
];
const TRAILING_INELIGIBLE_NAME_RES = [
  [/\bbait\b/i, 'bait_station_lane'],
];

function verdict(rule, source) {
  if (rule.eligible) {
    return {
      eligible: true,
      variant: rule.variant,
      captionKey: rule.captionKey,
      reason: `eligible_${source}`,
    };
  }
  return { eligible: false, variant: null, captionKey: null, reason: rule.reason };
}

// The recorded-exterior-work test for requiresExteriorChip rules: the
// frozen snapshot's treatment chips (array or CSV string — String() joins
// arrays on commas).
function recordedExteriorWork(typedValues) {
  // The two chip fields the conditional lanes actually use: palmetto and
  // flea record in `treatment_completed`, the active cockroach schema in
  // `work_completed` (codex P1 r5). `Lawn treatment` is flea's yard
  // application — exterior work by definition.
  const recorded = `${String(typedValues?.treatment_completed || '')} ${String(typedValues?.work_completed || '')}`;
  return /exterior|perimeter|\blawn\b/i.test(recorded);
}

// Applied-work test for requiresAppliedWork rules: any recorded treatment
// chip that a satellite AREA TRACE can honestly depict, across the three
// chip fields the typed schemas use. Excluded: the inspection labels;
// "Source reduction" (emptying water / flipping containers — real work,
// no application; codex P1 r7); and "Larvicide applied" (localized
// application to water-holding areas — an application, but not one a
// perimeter or area trace can substantiate; codex P1 r9).
const NON_APPLIED_CHIP_RE = /^(?:inspection (?:only|completed)|source reduction|larvicide applied)$/i;
function recordedAppliedWork(typedValues) {
  const recorded = ['treatment_completed', 'treatments_completed', 'work_completed']
    .map((key) => String(typedValues?.[key] ?? ''))
    .join(',');
  return recorded
    .split(',')
    .map((chip) => chip.trim())
    .filter(Boolean)
    .some((chip) => !NON_APPLIED_CHIP_RE.test(chip));
}

/**
 * Pure resolver. Precedence: INELIGIBLE verdicts win in either direction —
 * a frozen snapshot's findingsType may WIDEN suppression over a spray key
 * (the trap-lane snapshot-authority rule), and an explicitly ineligible
 * key overrides a stale eligible snapshot (codex P1 r4: a lawn_inspection
 * completed during that key's brief typed era must not keep a treatment
 * trace). Among eligible rules the findingsType wins (it carries the
 * variant). Then display-name regex (last resort, admin-editable labels) →
 * ineligible 'unclassified_service'.
 *
 * `typedValues` (the frozen snapshot's findings values) resolves the
 * conditional roach-family rules: absent (capture side) → eligible;
 * present without recorded exterior work → ineligible.
 */
function resolveTraceEligibility({
  serviceKey = null, findingsType = null, displayName = '', typedValues = undefined,
} = {}) {
  const applyConditions = (rule, source) => {
    if (rule.eligible && rule.requiresExteriorChip
      && typedValues !== undefined && !recordedExteriorWork(typedValues)) {
      return {
        eligible: false, variant: null, captionKey: null, reason: 'no_exterior_work_recorded',
      };
    }
    if (rule.eligible && rule.requiresAppliedWork
      && typedValues !== undefined && !recordedAppliedWork(typedValues)) {
      return {
        eligible: false, variant: null, captionKey: null, reason: 'no_treatment_recorded',
      };
    }
    return verdict(rule, source);
  };
  const findingsRule = findingsType ? FINDINGS_TYPE_RULES[findingsType] : null;
  const keyRule = serviceKey ? SERVICE_KEY_RULES[serviceKey] : null;
  if (findingsRule && !findingsRule.eligible) return verdict(findingsRule, 'findings_type');
  if (keyRule && !keyRule.eligible) return verdict(keyRule, 'service_key');
  // Among ELIGIBLE rules the findingsType normally wins (it carries the
  // conditional semantics) — except keys marked overridesSnapshot, whose
  // geometry is more specific than a retired generic pointer (codex P1
  // r8: pre-untype fire_ant snapshots say one_time_pest_treatment).
  if (keyRule && keyRule.eligible && keyRule.overridesSnapshot) {
    return applyConditions(keyRule, 'service_key');
  }
  if (findingsRule) return applyConditions(findingsRule, 'findings_type');
  if (keyRule) return applyConditions(keyRule, 'service_key');
  // A SUPPLIED stable identity that missed both registries fails CLOSED —
  // label fallback is reserved for legacy rows with no stable identity at
  // all. Falling through here would let an admin-added key become
  // eligible because its editable label contains "pest", which is the
  // exact accident this module exists to end (codex P1 r1).
  if (serviceKey || findingsType) {
    return { eligible: false, variant: null, captionKey: null, reason: 'unclassified_service' };
  }
  const name = String(displayName || '');
  for (const [re, reason] of INELIGIBLE_NAME_RES) {
    if (re.test(name)) return { eligible: false, variant: null, captionKey: null, reason };
  }
  for (const [re, rule] of ELIGIBLE_NAME_RES) {
    if (re.test(name)) return verdict({ eligible: true, ...rule }, 'display_name');
  }
  for (const [re, reason] of TRAILING_INELIGIBLE_NAME_RES) {
    if (re.test(name)) return { eligible: false, variant: null, captionKey: null, reason };
  }
  return { eligible: false, variant: null, captionKey: null, reason: 'unclassified_service' };
}

function traceEligibilityGateOn() {
  return process.env.GATE_TRACE_ELIGIBILITY === 'true';
}

/**
 * Capture-side block payload for the tech write routes (403), or null.
 * Gate-off keeps today's behavior; resolver errors FAIL OPEN — capture is
 * an internal tool and the render-side suppression is the customer-facing
 * guarantee, so a profile hiccup must not block a legitimate spray trace
 * in the field.
 */
async function traceCaptureBlockPayload(scheduledService, knex) {
  if (!traceEligibilityGateOn()) return null;
  let eligibility;
  try {
    const { resolveCompletionProfileForScheduledService } = require('../service-completion-profiles');
    const profile = await resolveCompletionProfileForScheduledService(scheduledService, knex);
    eligibility = resolveTraceEligibility({
      serviceKey: profile?.serviceKey || null,
      findingsType: profile?.findingsType || null,
      displayName: scheduledService?.service_type || '',
    });
  } catch {
    return null;
  }
  if (eligibility.eligible) return null;
  return {
    status: 403,
    payload: {
      error: 'Treatment-zone tracing does not apply to this service — nothing is sprayed on this visit type.',
      code: 'trace_ineligible_service',
      reason: eligibility.reason,
    },
  };
}

/**
 * Async render-verdict for callers that hold only a service_records-like
 * row ({ scheduled_service_id, service_type, service_data }): assembles
 * the same inputs the report payload build uses — the frozen snapshot's
 * findingsType is the authority, the live profile widens, display names
 * are last — and returns { suppressed, eligibility }. `suppressed` is
 * ALWAYS false while the gate is off, and `eligibility` is null then so
 * cache-key callers emit nothing pre-flip. Fail-soft: assembly errors
 * degrade to the label-only verdict, never throw. ONE assembly for the
 * exterior-zone resolver and the PDF signature — a second copy of this
 * input gathering is how the bed-bug and trap lanes came to disagree
 * across surfaces.
 */
async function resolveTraceRenderVerdict(record, knex) {
  if (!traceEligibilityGateOn()) {
    return { suppressed: false, eligibility: null };
  }
  let serviceKey = null;
  let findingsType = null;
  // null (not undefined) when no snapshot exists: at RENDER time a
  // conditional lane with no recorded evidence fails closed — only the
  // capture side (which never passes typedValues) stays permissive.
  let typedValues = null;
  let names = String(record?.service_type || '');
  try {
    const serviceData = typeof record?.service_data === 'string'
      ? JSON.parse(record.service_data || '{}')
      : (record?.service_data || {});
    findingsType = serviceData?.typedReportSnapshot?.type || null;
    typedValues = serviceData?.typedReportSnapshot?.values ?? null;
  } catch { /* names + profile still stand */ }
  try {
    if (record?.scheduled_service_id && knex) {
      const sched = await knex('scheduled_services')
        .where({ id: record.scheduled_service_id })
        .first('id', 'service_id', 'service_type');
      if (sched?.service_type) names += ` ${sched.service_type}`;
      const { resolveCompletionProfileForScheduledService } = require('../service-completion-profiles');
      const profile = await resolveCompletionProfileForScheduledService(
        sched || { id: record.scheduled_service_id },
        knex,
      );
      serviceKey = profile?.serviceKey || null;
      findingsType = findingsType || profile?.findingsType || null;
    }
  } catch { /* label fallback stands, same as the render path */ }
  const eligibility = resolveTraceEligibility({
    serviceKey, findingsType, displayName: names, typedValues,
  });
  return { suppressed: !eligibility.eligible, eligibility };
}

module.exports = {
  resolveTraceEligibility,
  resolveTraceRenderVerdict,
  traceEligibilityGateOn,
  traceCaptureBlockPayload,
  _test: { FINDINGS_TYPE_RULES, SERVICE_KEY_RULES },
};
