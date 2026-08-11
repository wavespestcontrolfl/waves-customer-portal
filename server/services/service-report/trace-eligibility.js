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
  // T&S is chip-matched, not merely applied-work (codex P1 r11):
  // fertilizer, micronutrients, soil drench, and soil amendment are real
  // work a spray trace cannot honestly depict — only the foliar/area
  // application chips substantiate the map.
  tree_shrub: {
    eligible: true,
    variant: 'spray',
    captionKey: 'sprayPerimeter',
    requiresChipMatch: /^(?:insect treatment|disease \/ fungicide treatment|horticultural oil|foliar treatment|pre-emergent bed treatment)$/i,
  },
  // Mosquito treats the YARD — turf plus the landscape/bedding areas where
  // mosquitoes harbor — not a building barrier (owner 2026-08-11: same
  // overlay as lawn, bedding areas included). Outline geometry, captured by
  // the yard workflow (capture_mode 'yard': boundary trace, no turf-only
  // highlight mask — the mask would exclude the beds the treatment covers).
  mosquito_event: {
    eligible: true, variant: 'outline', captionKey: 'yardCoverage', requiresAppliedWork: true,
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
  // The shared termite form allows spot/bait/cartridge/wood methods
  // beside the two perimeter ones, so RENDER requires a recorded
  // perimeter method — a wood-treatment completion must not publish a
  // sprayed perimeter (codex P1 r10). Capture stays permissive until the
  // method is recorded.
  termite_treatment: {
    eligible: true, variant: 'spray', captionKey: 'sprayPerimeter', requiresPerimeterMethod: true,
  },
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
  // Callback for breakthrough pressure — an interior-only re-service
  // (kitchen/bath breakthrough) must not publish a perimeter map, so the
  // RENDER verdict requires recorded exterior area/action evidence from
  // the generic completion (codex P1 r13). Capture stays permissive.
  // overridesSnapshot (codex P1 r19): pre-untype callbacks retain an
  // eligible one_time_pest_treatment snapshot that would bypass the
  // evidence condition — the callback key's conditional rule wins.
  pest_re_service: {
    eligible: true,
    variant: 'spray',
    captionKey: 'sprayPerimeter',
    requiresExteriorAreas: true,
    overridesSnapshot: true,
  },
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
  // Yard, fence line, and wooded edges — granular broadcast plus
  // perimeter spray, so the treated geometry is the property area (codex
  // P1 r10). overridesSnapshot for the same reason as fire_ant: pre-untype
  // reports carry the generic one_time_pest_treatment 'spray' pointer.
  tick_control: {
    eligible: true, variant: 'outline', captionKey: 'lawnCoverage', overridesSnapshot: true,
  },
  // Individual-nest removal with localized residual on eaves/soffits —
  // never a property-perimeter application (codex P1 r6).
  bee_wasp_removal: { eligible: false, reason: 'localized_treatment_lane' },
  mud_dauber_removal: { eligible: false, reason: 'localized_treatment_lane' },
  // mosquito programs — yard geometry (turf + landscape beds), same outline
  // overlay as lawn (owner 2026-08-11; see the mosquito_event rule above)
  mosquito_monthly: { eligible: true, variant: 'outline', captionKey: 'yardCoverage' },
  mosquito_seasonal: { eligible: true, variant: 'outline', captionKey: 'yardCoverage' },
  // Billing construct, not a visit (zero duration, booking disabled) —
  // WaveGuard's actual stops book as the mosquito programs above (codex
  // P2 r4).
  waveguard_membership: { eligible: false, reason: 'billing_rider' },
  // Estimate-gap batch (20260808080000). The three mechanical lawn
  // add-ons apply no treatment — a spray/coverage trace would imply
  // application work that never happened (compliance: never suggest
  // treatment where none occurred). Bora-Care treats individual wood
  // members/attic surfaces, not a perimeter or lawn. The guarantee is a
  // payment-only billing rider.
  dethatching: { eligible: false, reason: 'mechanical_lawn_lane' },
  plugging: { eligible: false, reason: 'mechanical_lawn_lane' },
  top_dressing: { eligible: false, reason: 'mechanical_lawn_lane' },
  bora_care: { eligible: false, reason: 'localized_treatment_lane' },
  rodent_guarantee: { eligible: false, reason: 'billing_rider' },
  // Reactivation batch (20260809000000): German roach work is interior
  // gel/IGR treatment — no exterior perimeter or lawn trace.
  german_roach: { eligible: false, reason: 'interior_only_lane' },
  german_roach_initial: { eligible: false, reason: 'interior_only_lane' },
  // lawn programs — coverage outline/highlight, not a spray-mist replay
  lawn_care_6week: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_care_monthly: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_care_quarterly: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_care_recurring: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_fertilization: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  lawn_tree_shrub_combo: { eligible: true, variant: 'outline', captionKey: 'lawnCoverage' },
  // Drill-and-foam (catalog identity shipped in #3306). Foam goes into wall
  // voids and block cells — a point application with no line and no area, so
  // neither the spray band nor the lawn outline can depict it honestly. It
  // gets the 'photo' variant: treated points marked on a PHOTO of the area
  // actually treated (see service-report/photo-marks.js).
  //
  // overridesSnapshot is required, not decorative: foam completes as the
  // typed `termite_treatment` findings type, which it SHARES with liquid
  // perimeter and trenching, and typed lanes are evaluated first. Without the
  // override a foam visit would inherit that lane's 'spray' variant. This is
  // the same precedence fire_ant and tick_control already rely on — the
  // catalog key's geometry is more specific than a shared typed pointer.
  //
  // The shared lane's requiresPerimeterMethod condition still suppresses a
  // SPRAY map on these visits; this rule decides what they may publish
  // instead, and nothing renders unless GATE_PHOTO_MARKS is on.
  foam_drill: {
    eligible: true, variant: 'photo', captionKey: 'foamPoints', overridesSnapshot: true,
  },
  foam_recurring: {
    eligible: true, variant: 'photo', captionKey: 'foamPoints', overridesSnapshot: true,
  },
  // liquid termite keys (typed — listed for callers that only have the key)
  // pointerRequired (codex P2 r27): these keys' spray verdicts are only
  // valid WITH their termite_treatment pointer — its perimeter-method
  // condition is the narrowing. At RENDER (typedValues supplied, even
  // null) a missing pointer fails closed; capture stays permissive.
  termite_liquid: {
    eligible: true, variant: 'spray', captionKey: 'sprayPerimeter', pointerRequired: true,
  },
  termite_trenching: {
    eligible: true, variant: 'spray', captionKey: 'sprayPerimeter', pointerRequired: true,
  },
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
  // Stinging-insect visits are localized nest work, same as their stable
  // bee_wasp_removal/mud_dauber keys (codex P2 r26) — the generic spray
  // token list treated identity-less bee/wasp labels as perimeter-spray
  // eligible.
  [/\b(?:bees?|wasps?|hornets?|yellow\s*jackets?|mud\s*daubers?)\b/i, 'localized_treatment_lane'],
];
const ELIGIBLE_NAME_RES = [
  [/\b(?:lawn|turf|fertiliz\w*)\b/i, { variant: 'outline', captionKey: 'lawnCoverage' }],
  // Yard-geometry families FIRST (codex P2 r13): identity-less fire-ant/
  // tick/flea rows must resolve the same outline geometry their stable
  // rules define, not the generic spray token below.
  [/\b(?:fire\s*ants?|ticks?|fleas?)\b/i, { variant: 'outline', captionKey: 'lawnCoverage' }],
  // Mosquito is yard geometry (owner 2026-08-11) — ranked above the generic
  // spray token so identity-less mosquito rows resolve the same outline
  // their stable keys define.
  [/\bmosquito(?:es)?\b/i, { variant: 'outline', captionKey: 'yardCoverage' }],
  // Ranked ABOVE the bait check below: combined names like "Quarterly
  // Pest + Termite Bait Station" are pest-PRIMARY bundles — the spray is
  // real (codex P1 r1). A pure "Termite Bait" name matches neither of
  // these and falls to the bait rule.
  [/\b(?:pest|spray|trees?|shrubs?|roach(?:es)?|ants?)\b/i, { variant: 'spray', captionKey: 'sprayPerimeter' }],
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
function allRecordedChips(typedValues) {
  return ['treatment_completed', 'treatments_completed', 'work_completed']
    .map((key) => String(typedValues?.[key] ?? ''))
    .join(',')
    .split(',')
    .map((chip) => chip.trim())
    .filter(Boolean);
}

function recordedAppliedWork(typedValues) {
  return allRecordedChips(typedValues).some((chip) => !NON_APPLIED_CHIP_RE.test(chip));
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
  renderAreas = undefined,
} = {}) {
  const applyConditions = (rule, source) => {
    if (rule.eligible && rule.requiresExteriorChip
      && typedValues !== undefined && !recordedExteriorWork(typedValues)) {
      return {
        eligible: false, variant: null, captionKey: null, reason: 'no_exterior_work_recorded',
      };
    }
    // Generic-lane exterior evidence (codex P1 r13): render suppresses
    // when areas/actions WERE recorded and none are exterior. EMPTY
    // evidence passes (codex P2 r17): the lightweight recap flow records
    // no areas at all, and on a no-evidence completion the captured
    // trace itself is the tech's assertion of exterior work — only a
    // recorded-interior completion contradicts it. Capture stays
    // permissive (renderAreas undefined).
    if (rule.eligible && rule.requiresExteriorAreas
      && renderAreas !== undefined
      && String(renderAreas || '').trim() !== ''
      && !/exterior|perimeter|yard|lawn|foundation|eaves|soffit|outside|garage door|fence/i.test(String(renderAreas || ''))) {
      return {
        eligible: false, variant: null, captionKey: null, reason: 'no_exterior_area_recorded',
      };
    }
    // Chip-matched lanes (codex P1 r11): at render, at least one recorded
    // chip must be one the trace can honestly depict.
    if (rule.eligible && rule.requiresChipMatch
      && typedValues !== undefined
      && !allRecordedChips(typedValues).some((chip) => rule.requiresChipMatch.test(chip))) {
      return {
        eligible: false, variant: null, captionKey: null, reason: 'no_traceable_treatment_recorded',
      };
    }
    // Termite form: only the two perimeter methods substantiate a
    // perimeter trace (codex P1 r10).
    if (rule.eligible && rule.requiresPerimeterMethod
      && typedValues !== undefined
      && !/^(?:liquid perimeter|trenching)$/i.test(String(typedValues?.treatment_method || '').trim())) {
      return {
        eligible: false, variant: null, captionKey: null, reason: 'no_perimeter_method_recorded',
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
  // An unresolved SENTINEL identity — a linked lookup that failed, or a
  // supplied catalog id that couldn't resolve — fails closed ahead of
  // EVERYTHING, including an eligible stale snapshot (codex P2 r23): the
  // row we could not identify is exactly the row whose key would have
  // overridden that snapshot (a pest_re_service callback still carrying
  // one_time_pest_treatment must not republish its map because the
  // lookup hiccuped).
  if (typeof serviceKey === 'string' && serviceKey.startsWith('unresolved:')) {
    return {
      eligible: false, variant: null, captionKey: null, reason: 'unclassified_service',
    };
  }
  const findingsRule = findingsType ? FINDINGS_TYPE_RULES[findingsType] : null;
  const keyRule = serviceKey ? SERVICE_KEY_RULES[serviceKey] : null;
  if (findingsRule && !findingsRule.eligible) return verdict(findingsRule, 'findings_type');
  if (keyRule && !keyRule.eligible) return verdict(keyRule, 'service_key');
  // A supplied typed pointer that misses the registry fails closed even
  // when the KEY alone would be eligible (codex P2 r23): a typoed or
  // newly-added project_type must not publish a trace through its
  // generic pest/lawn key until the registry learns the new type's
  // semantics — the pointer, when present, IS the visit's identity.
  if (findingsType && !findingsRule) {
    return {
      eligible: false, variant: null, captionKey: null, reason: 'unclassified_service',
    };
  }
  // A pointer-REQUIRED key with no resolved pointer fails closed at
  // render (codex P2 r27, the primary-path mirror of the add-ons'
  // unresolved:pointer rule): termite_liquid without termite_treatment
  // would skip the perimeter-method evidence check. typedValues
  // undefined = capture side, which stays permissive.
  if (keyRule && keyRule.eligible && keyRule.pointerRequired
    && !findingsRule && typedValues !== undefined) {
    return {
      eligible: false, variant: null, captionKey: null, reason: 'unclassified_service',
    };
  }
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

// A key whose eligible verdict is only valid WITH its typed pointer
// (codex P2 r27/r28) — completion freezers must not stamp such a key
// pointer-less, or the permanent record fails the render check forever.
function pointerRequiredForKey(serviceKey) {
  return Boolean(serviceKey && SERVICE_KEY_RULES[serviceKey]?.pointerRequired);
}

// A primary identity freeze is only safe when the frozen key resolves
// the same way regardless of later profile changes (codex P2 r28/r29):
// a resolved pointer always does; a self-classifying rules key without
// pointerRequired does; a TYPED key (no rules entry) or pointer-required
// key frozen WITHOUT its pointer would pin the wrong verdict forever
// (permanently unclassified / permanently unconditional). A null key
// freezes name-only semantics and is safe.
function primaryIdentityFreezable({ serviceKey = null, findingsType = null } = {}) {
  if (!serviceKey || findingsType) return true;
  const rule = SERVICE_KEY_RULES[serviceKey];
  if (!rule) return false;
  return !rule.pointerRequired;
}

function traceEligibilityGateOn() {
  return process.env.GATE_TRACE_ELIGIBILITY === 'true';
}

/**
 * The `{ traceEligible, traceVariant }` pair the schedule/dispatch feeds hand
 * to the field UI, where traceEligible means "offer the SATELLITE tracer".
 *
 * A 'photo' lane is eligible for a marked-photo card and never for the tracer,
 * so it must report traceEligible:false — otherwise the tech is shown a
 * workflow whose save the capture block then rejects with trace_photo_lane, a
 * dead end discoverable only by doing the work twice (codex P2).
 *
 * Gate-aware on purpose: with GATE_TRACE_ELIGIBILITY off, ONLY a photo lane
 * may suppress the button. Every other lane keeps pre-gate behavior, so
 * turning on marks cannot start hiding tracers across unrelated services.
 */
function traceFeedFields(verdict, addonVerdicts = []) {
  // Order-independent, like capture and render (codex P1 r6): a mixed visit
  // whose foam line precedes its trenching line must still be offered the
  // tracer, and combineLineVerdicts would have answered 'photo' purely
  // because of insertion order.
  const { satellite, photo } = resolveLaneCapabilities(
    verdict || { eligible: false },
    addonVerdicts,
  );
  // Only a PHOTO-ONLY visit hides the tracer. A satellite line alongside the
  // foam keeps the button — the tech traces the trenching and marks the foam.
  if (photo && !satellite) return { traceEligible: false, traceVariant: 'photo', traceCaptionKey: null };
  // With the eligibility gate off, every non-photo lane keeps pre-gate
  // behavior: enabling marks must not start publishing variants (or hiding
  // tracers) across unrelated services.
  if (!traceEligibilityGateOn() || !verdict) {
    return { traceEligible: true, traceVariant: null, traceCaptionKey: null };
  }
  // traceCaptionKey rides alongside the variant (codex P2 on #3354): two
  // outline lanes capture DIFFERENT geometry — lawn (turf boundary,
  // highlight mask) vs yard (turf + beds, mosquito) — and the client must
  // not reconstruct that from the primary's display name: an ineligible
  // primary rescued by a mosquito ADD-ON would open lawn mode and save a
  // lawn-only claim for a yard treatment. The winning satellite line's
  // captionKey is the discriminator ('yardCoverage' → yard workflow).
  if (satellite) {
    return {
      traceEligible: true,
      traceVariant: satellite.variant,
      traceCaptionKey: satellite.captionKey || null,
    };
  }
  return {
    traceEligible: verdict.eligible,
    traceVariant: verdict.eligible ? verdict.variant : null,
    traceCaptionKey: verdict.eligible ? verdict.captionKey || null : null,
  };
}

/**
 * Capture-side block payload for the tech write routes (403), or null.
 * Gate-off keeps today's behavior; resolver errors FAIL OPEN — capture is
 * an internal tool and the render-side suppression is the customer-facing
 * guarantee, so a profile hiccup must not block a legitimate spray trace
 * in the field.
 */
async function traceCaptureBlockPayload(scheduledService, knex, { captureMode = undefined } = {}) {
  // Two independent gates reach this helper (codex P1). The eligibility gate
  // governs the full registry; GATE_PHOTO_MARKS governs only the photo-lane
  // block below. The rollout allows the photo gate to go on FIRST, and under
  // that ordering an eligibility-gated early return would let a foam visit
  // save a satellite trace — so the photo block must stand on its own gate.
  const { photoMarksGateOn } = require('./photo-marks');
  const photoGateOn = photoMarksGateOn();
  if (!traceEligibilityGateOn() && !photoGateOn) return null;
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
  // The posted capture mode must agree with the FINAL combined verdict's
  // geometry (codex P2 r19, extended to the add-on rescue path in r20):
  // the render path trusts capture_mode for its presentation. Absent mode
  // (legacy clients) passes.
  const modeMismatchBlock = (variant) => {
    if (captureMode === undefined || captureMode === null || captureMode === '') return null;
    // 'yard' is the mosquito outline capture (owner 2026-08-11) — an area
    // claim like the lawn modes, so it satisfies an 'outline' verdict.
    const lawnMode = captureMode === 'lawn' || captureMode === 'lawn_highlight' || captureMode === 'yard';
    const wantsLawn = variant === 'outline';
    if (lawnMode === wantsLawn) return null;
    return {
      status: 400,
      payload: {
        error: wantsLawn
          ? 'This service maps the treated area — use the lawn outline workflow, not the perimeter tracer.'
          : 'This service maps the treated perimeter — use the perimeter tracer, not the lawn outline workflow.',
        code: 'trace_capture_mode_mismatch',
        reason: variant,
      },
    };
  };
  // The 'photo' variant is eligible for a treated-point map but NOT for the
  // satellite tracer — foam has no perimeter and no area to trace. Without
  // this branch modeMismatchBlock would read 'photo' as "not lawn" and wave a
  // perimeter trace through, which is exactly the false exterior claim the
  // registry exists to prevent.
  const photoLaneBlock = (variant) => (variant === 'photo' ? {
    status: 403,
    payload: {
      error: 'This service is mapped by marking the treated points on a photo, not by tracing the property.',
      code: 'trace_photo_lane',
      reason: variant,
    },
  } : null);
  // Capabilities are resolved INDEPENDENTLY of line order (codex P1 r6).
  // combineLineVerdicts returns the primary, or the FIRST eligible add-on, so
  // a mixed visit whose foam line happens to sit before its trenching line
  // produced trace_photo_lane and blocked a trace the trenching line
  // legitimately earns — the mirror of the render-side drop fixed in r5.
  let capabilities;
  try {
    capabilities = resolveLaneCapabilities(
      eligibility,
      await resolveAddonVerdicts(scheduledService?.id, knex),
    );
  } catch {
    // Fail-open on lookup errors, same posture as the rest of this helper:
    // capture is the internal surface, render is the customer-facing guard.
    return null;
  }

  // A satellite-capable line wins: the visit may trace, and the posted mode
  // must match THAT line's geometry. The photo card rides alongside.
  if (capabilities.satellite) {
    // ...but geometry validation is the WIDER REGISTRY's rule, so it waits for
    // the registry's own gate (codex P1 r10). Running it under GATE_PHOTO_MARKS
    // alone broke capture for typed lawn visits in exactly the rollout order
    // this feature ships in (marks first, eligibility later): with the
    // eligibility gate off traceFeedFields reports traceVariant:null, and
    // SchedulePage then falls back to `isLawn`, which isTypedFindings forces
    // FALSE for aeration/fungicide/insect-control. The modal posts 'perimeter',
    // the registry says 'outline', and the save died on
    // trace_capture_mode_mismatch — a 400 that could not happen before the
    // marks gate was flipped. The feed (traceFeedFields) and render
    // (resolveTraceRenderVerdict) surfaces already hold this line; capture was
    // the one that leaked.
    if (!traceEligibilityGateOn()) return null;
    return modeMismatchBlock(capabilities.satellite.variant);
  }
  // Photo-only: nothing on this visit supports a trace. This block is what the
  // marks gate legitimately introduces, so it stands on the photo gate alone.
  if (capabilities.photo) return photoLaneBlock('photo');

  // Photo gate on, eligibility gate off: nothing else is in force, so every
  // non-photo verdict keeps pre-gate behavior — turning on marks cannot
  // silently activate the wider registry.
  if (!traceEligibilityGateOn()) return null;

  return {
    status: 403,
    payload: {
      error: 'Treatment-zone tracing does not apply to this service — nothing is sprayed on this visit type.',
      code: 'trace_ineligible_service',
      reason: eligibility.reason,
    },
  };
}

// Multi-line appointments (codex P2 r11): a grouped visit with an
// ineligible primary can still perform a spray-capable ADD-ON line (a
// termite-bait primary with a pest-control add-on sprays the perimeter),
// so the appointment traces when any line supports it. The primary's
// verdict wins whenever it is eligible (it carries the typed conditional
// semantics); otherwise the first eligible add-on supplies the variant.
// Add-ons are generic catalog lines — key or display name, no typed
// values — and the report-data belt lanes (bed bug, rodent trapping)
// still hard-suppress regardless, the conservative direction.
function combineLineVerdicts(primaryVerdict, addonVerdicts = []) {
  if (primaryVerdict.eligible) return primaryVerdict;
  const rescued = addonVerdicts.find((v) => v && v.eligible);
  return rescued || primaryVerdict;
}

/**
 * The two capabilities a visit can hold at once, resolved INDEPENDENTLY of
 * line order (codex P1 r6).
 *
 * combineLineVerdicts answers "which single verdict represents this visit",
 * which is the wrong question once a visit can be both a satellite lane and a
 * photo lane: it returns the primary, or the FIRST eligible add-on, so whether
 * a mixed trenching+foam visit read as 'spray' or 'photo' depended on the
 * order the lines happened to be inserted. That order-dependence produced a
 * false block in one direction (a 403 on a visit that legitimately traces) and
 * a silent drop in the other (a saved trace omitted from the report).
 *
 * Callers ask for the capability they actually need:
 *   satellite → may this visit trace, and with which geometry
 *   photo     → may this visit publish a marked-photo card
 */
function resolveLaneCapabilities(primaryVerdict, addonVerdicts = []) {
  const lines = [primaryVerdict, ...(Array.isArray(addonVerdicts) ? addonVerdicts : [])]
    .filter(Boolean);
  return {
    photo: lines.find((v) => v.eligible && v.variant === 'photo') || null,
    satellite: lines.find((v) => v.eligible && v.variant !== 'photo') || null,
  };
}

// Resolve the add-on lines' verdicts for a scheduled service: catalog key
// when the services row resolves, display name otherwise. Fail-soft — an
// addon lookup error contributes nothing (the primary verdict stands).
// Verdicts for a list of add-on line identities ({ serviceId,
// serviceName }) — shared by the live-row path (capture, legacy records)
// and the completion-frozen path (render, codex P2 r14).
async function addonVerdictsFromLines(lines, knex, { renderSide = false } = {}) {
  const addons = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      service_id: line?.serviceId ?? line?.service_id ?? null,
      service_name: line?.serviceName ?? line?.service_name ?? null,
      // Completion-FROZEN identity (codex P2 r21): lines stamped with
      // their key + findings pointer at completion never re-resolve the
      // mutable catalog/profile rows — a later repoint or deactivation
      // cannot change a permanent report's verdict.
      frozen: (typeof line?.serviceKey === 'string' && line.serviceKey)
        ? { key: line.serviceKey, pointer: line?.findingsType || null }
        : null,
    }))
    .filter((line) => line.service_id || line.service_name || line.frozen);
  if (!addons.length || !knex) return [];
  const catalogIds = [...new Set(addons.filter((a) => !a.frozen).map((a) => a.service_id).filter(Boolean))];
  let keyById = new Map();
  let catalogLookupFailed = false;
  if (catalogIds.length) {
    try {
      const rows = await knex('services')
        .whereIn('id', catalogIds)
        .select('id', 'service_key');
      keyById = new Map(rows.map((r) => [r.id, r.service_key]));
    } catch { catalogLookupFailed = true; }
  }
  // Typed add-on keys (flea_tick, lawn_aeration…) are deliberately
  // absent from SERVICE_KEY_RULES — their identity is the typed
  // pointer, so resolve the completion profile per key (codex P2 r12).
  // This lookup's failure PROPAGATES (codex P2 r21, same reasoning as
  // the row-list query): swallowing it strips a typed add-on's only
  // findings pointer, and the capture path's documented fail-open must
  // see the failure instead of 403ing the rescued visit. Render callers
  // wrap with their own fail-closed catch.
  let pointerByKey = new Map();
  // EVERY key loads its pointer (codex P1 r25, reverting the r24
  // per-key scoping): a SERVICE_KEY_RULES entry does not make a key
  // pointer-independent — termite_liquid/termite_trenching route to the
  // termite_treatment findings rule, whose perimeter-method condition
  // NARROWS the render verdict, so skipping the pointer let a spot/bait
  // completion publish a perimeter trace its evidence doesn't support.
  // The lookup's failure therefore propagates for the whole batch (the
  // r21 policy): capture fail-opens, render fails closed via its
  // caller's catch — the conservative direction on every surface.
  const keys = [...new Set([...keyById.values()].filter(Boolean))];
  if (keys.length) {
    const profiles = await knex('service_completion_profiles')
      .whereIn('service_key', keys)
      .where({ active: true })
      .select('service_key', 'project_type');
    pointerByKey = new Map(profiles.map((r) => [r.service_key, r.project_type]));
  }
  return addons.map((addon) => {
      if (addon.frozen) {
        // serviceKey rides the verdict (codex P1 r3): a photo-lane add-on
        // supplies the mark vocabulary, and the tech route only has the
        // PRIMARY profile's key to work from otherwise.
        return {
          ...resolveTraceEligibility({
            serviceKey: addon.frozen.key,
            findingsType: addon.frozen.pointer,
            displayName: addon.service_name || '',
            ...(renderSide ? { typedValues: null } : {}),
          }),
          serviceKey: addon.frozen.key,
        };
      }
      // A SUPPLIED catalog id that cannot be resolved — transient lookup
      // failure, or the row no longer exists — must not fall to the
      // editable display name and broaden eligibility (codex P2 r18).
      // Passing the unresolvable id as a key reuses the fail-closed
      // supplied-identity rule: unclassified_service, never name-rescued.
      // Genuinely unlinked legacy lines (no id at all) keep name fallback.
      const key = addon.service_id
        ? (catalogLookupFailed
          ? `unresolved:${addon.service_id}`
          : (keyById.get(addon.service_id) || `unresolved:${addon.service_id}`))
        : null;
      return {
        ...resolveTraceEligibility({
        serviceKey: key,
        // A successful pointer query that returned NO row for a resolved
        // key is a cutover/deactivation, not "untyped" (codex P2 r26):
        // at RENDER the unknown-pointer sentinel fails it closed (the
        // r23 rule) instead of falling to the unconditional key rule —
        // termite_liquid must not skip its perimeter-method check while
        // its profile is dark. A row present with a null project_type is
        // genuinely untyped and keeps the key rule; capture stays
        // permissive.
        findingsType: key && pointerByKey.has(key)
          ? (pointerByKey.get(key) || null)
          : (key && renderSide ? 'unresolved:pointer' : null),
        displayName: addon.service_name || '',
        // RENDER-side rescue by a conditional typed add-on requires its
        // recorded evidence — which lives in a companion snapshot this
        // resolver does not read — so conditional add-ons stay ineligible
        // at render (typedValues null fails their conditions closed) and
        // permissive at capture (codex P1 r13).
        ...(renderSide ? { typedValues: null } : {}),
        }),
        // Same reason as the frozen branch: a photo-lane add-on carries the
        // key its mark vocabulary is drawn from (codex P1 r3).
        serviceKey: key,
      };
  });
}

// Completion-time add-on line snapshot (codex P2 r21): each line
// freezes its booking-time service_key_snapshot (catalog key fallback)
// and the findings pointer ACTIVE at completion, so a later profile
// repoint or deactivation — routine during typed cutovers — cannot
// change a permanent report's eligibility or geometry. Frozen fields
// are stamped only when BOTH halves resolved: a half-frozen line (key
// without its pointer lookup) would fail typed add-ons closed forever
// instead of falling back to live resolution. Throws propagate to the
// caller's fail-soft catch (the completion is never blocked on this).
async function frozenAddonLinesForCompletion(scheduledServiceId, trx) {
  const rows = await trx('scheduled_service_addons')
    .where({ scheduled_service_id: scheduledServiceId })
    // id tiebreaker: same-transaction lines share created_at (codex P2 r24)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select('service_id', 'service_name', 'service_key_snapshot');
  const missingIds = [...new Set(rows
    .filter((r) => !r.service_key_snapshot && r.service_id)
    .map((r) => r.service_id))];
  let keyById = new Map();
  if (missingIds.length) {
    try {
      const catalog = await trx('services').whereIn('id', missingIds).select('id', 'service_key');
      keyById = new Map(catalog.map((r) => [r.id, r.service_key]));
    } catch { /* only the rows that NEEDED the catalog stay live */ }
  }
  const keys = [...new Set(rows
    .map((r) => r.service_key_snapshot || keyById.get(r.service_id))
    .filter(Boolean))];
  let pointerByKey = new Map();
  if (keys.length) {
    try {
      const profiles = await trx('service_completion_profiles')
        .whereIn('service_key', keys)
        .where({ active: true })
        .select('service_key', 'project_type');
      pointerByKey = new Map(profiles.map((r) => [r.service_key, r.project_type]));
    } catch { /* typed rows stay live; rules-covered keys freeze on their own */ }
  }
  return rows.map((row) => {
    const key = row.service_key_snapshot || keyById.get(row.service_id) || null;
    // Freeze ONLY when the key's profile row was actually found (codex
    // P2 r22 + r26): a null-pointer freeze during a cutover/deactivation
    // would pin the line to the WRONG verdict forever — permanently
    // unclassified for a typed key, or permanently unconditional for a
    // rules-covered typed lane (termite_liquid frozen without its
    // termite_treatment pointer would skip the perimeter-method check
    // even after the profile is restored). A found row with a null
    // project_type is genuinely untyped and freezes {key, null}. The
    // decision stays PER ROW (codex P2 r23): a failed lookup leaves only
    // its dependent rows live.
    const freezable = key && pointerByKey.has(key);
    return {
      serviceId: row.service_id || null,
      serviceName: row.service_name || null,
      ...(freezable
        ? { serviceKey: key, findingsType: pointerByKey.get(key) || null }
        : {}),
    };
  });
}

// Live schedule rows — the CAPTURE-side truth (pre-completion) and the
// legacy fallback for records completed before add-on identities were
// frozen with the completion.
async function resolveAddonVerdicts(scheduledServiceId, knex, { renderSide = false } = {}) {
  if (!scheduledServiceId || !knex) return [];
  // Row-list errors PROPAGATE (codex P2 r20): the capture path's
  // documented fail-open depends on seeing the failure — swallowing it as
  // an empty list turned a transient outage into a misleading 403 for a
  // legitimately rescued visit. Render callers wrap with their own
  // fail-closed catch.
  const rows = await knex('scheduled_service_addons')
    .where({ scheduled_service_id: scheduledServiceId })
    // Same deterministic order the capture feeds use — the first
    // eligible add-on supplies the variant, so the report/PDF/re-entry
    // pick must match the one the mapper keyed off (codex P2 r13). The
    // id tiebreaker makes the order stable for lines inserted in one
    // transaction, whose created_at is the SAME timestamp (codex P2
    // r24) — without it a spray+outline pair could pick different
    // variants across feed, save, freeze, and PDF lookup.
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select('service_id', 'service_name');
  return addonVerdictsFromLines(rows, knex, { renderSide });
}

// The generic completion's recorded areas/actions, joined for the
// requiresExteriorAreas render check: areas_serviced (JSON array or raw)
// plus structured_notes.areasTreated. Fail-soft — unparseable fields
// contribute their raw string.
function renderAreasFromRecord(record) {
  const parts = [];
  try {
    const areas = typeof record?.areas_serviced === 'string'
      ? JSON.parse(record.areas_serviced)
      : record?.areas_serviced;
    if (Array.isArray(areas)) parts.push(...areas.map(String));
    else if (areas) parts.push(String(areas));
  } catch { parts.push(String(record?.areas_serviced || '')); }
  try {
    const structured = typeof record?.structured_notes === 'string'
      ? JSON.parse(record.structured_notes || '{}')
      : (record?.structured_notes || {});
    const treated = structured?.areasTreated;
    if (Array.isArray(treated)) parts.push(...treated.map(String));
    else if (treated) parts.push(String(treated));
    // Scoped protocol actions are the completion's authoritative record
    // of WHERE treatment was applied — area chips are optional, so an
    // exterior action alone must count as exterior evidence (codex P2
    // r14). Only applied treatments contribute their scope.
    const scopes = structured?.protocolActionScopesCompleted;
    if (Array.isArray(scopes)) {
      parts.push(...scopes
        .filter((entry) => entry && entry.treatmentApplied === true && entry.scope)
        .map((entry) => String(entry.scope)));
    }
  } catch { /* nothing more to add */ }
  return parts.filter(Boolean).join(', ');
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
  // Engages under EITHER gate (codex P1 r6). This verdict governs the
  // SATELLITE artifact and the exterior re-entry scope that rides on it, and
  // independent callers (reentry.js → resolveTracedExteriorZone, dynamic
  // context, email delivery) trust it. An eligible 'photo' verdict returning
  // suppressed:false therefore let a point-localized foam treatment publish an
  // exterior ready-at target on those surfaces, bypassing the local fix in the
  // report payload.
  const { photoMarksGateOn: renderPhotoMarksGateOn } = require('./photo-marks');
  const marksGateOn = renderPhotoMarksGateOn();
  if (!traceEligibilityGateOn() && !marksGateOn) {
    return { suppressed: false, eligibility: null };
  }
  let serviceKey = null;
  let findingsType = null;
  // null (not undefined) when no snapshot exists: at RENDER time a
  // conditional lane with no recorded evidence fails closed — only the
  // capture side (which never passes typedValues) stays permissive.
  let typedValues = null;
  let names = String(record?.service_type || '');
  // undefined = legacy record (no completion-time freeze) → resolve the
  // live profile below; present (even null) = the identity that was
  // actually completed wins over later schedule edits (codex P2 r15).
  let frozenPrimaryKey;
  try {
    const serviceData = typeof record?.service_data === 'string'
      ? JSON.parse(record.service_data || '{}')
      : (record?.service_data || {});
    findingsType = serviceData?.typedReportSnapshot?.type || null;
    typedValues = serviceData?.typedReportSnapshot?.values ?? null;
    if (serviceData && Object.prototype.hasOwnProperty.call(serviceData, 'completedServiceKey')) {
      frozenPrimaryKey = serviceData.completedServiceKey || null;
      if (serviceData.completedServiceName) names += ` ${serviceData.completedServiceName}`;
    }
  } catch { /* names + profile still stand */ }
  if (frozenPrimaryKey !== undefined) {
    serviceKey = frozenPrimaryKey;
  } else {
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
    } catch {
      // A LINKED row whose lookup threw must not fall to the editable
      // display name (codex P2 r21, twin of the buildReportV1Data
      // sentinel): every independent caller of this shared resolver —
      // re-entry, PDF signature, completion SMS — fails closed the same
      // way. The throw can only originate inside the linkage branch, so
      // unlinked legacy rows still reach name fallback.
      serviceKey = 'unresolved:linked_service';
    }
  }
  let eligibility = resolveTraceEligibility({
    serviceKey, findingsType, displayName: names, typedValues,
    renderAreas: renderAreasFromRecord(record),
  });
  // Hoisted so the capability resolution below can see them. Also resolved
  // when the primary IS eligible but is a PHOTO lane (codex P1 r6): the
  // question "does any line support a satellite trace" cannot be answered
  // from a foam primary alone. An eligible satellite primary still short-
  // circuits, so this adds no lookup to the common path.
  let addonVerdicts = [];
  if (!eligibility.eligible || eligibility.variant === 'photo') {
    // Add-on identities FROZEN with the completion win over the mutable
    // schedule rows (codex P2 r14): a spray add-on added after completion
    // must not republish a suppressed trace, and one removed must not
    // hide a legitimately completed map. Legacy records (no frozen field)
    // fall back to the live rows — the pre-freeze behavior.
    let frozenLines = null;
    try {
      const serviceData = typeof record?.service_data === 'string'
        ? JSON.parse(record.service_data || '{}')
        : (record?.service_data || {});
      if (Array.isArray(serviceData?.completedAddonLines)) {
        frozenLines = serviceData.completedAddonLines;
      }
    } catch { /* live-row fallback */ }
    try {
      addonVerdicts = frozenLines !== null
        ? await addonVerdictsFromLines(frozenLines, knex, { renderSide: true })
        : await resolveAddonVerdicts(record?.scheduled_service_id, knex, { renderSide: true });
    } catch { /* render fails closed: the primary verdict stands */ }
    if (!eligibility.eligible) eligibility = combineLineVerdicts(eligibility, addonVerdicts);
  }
  const renderCapabilities = resolveLaneCapabilities(eligibility, addonVerdicts);
  if (!traceEligibilityGateOn()) {
    // Marks gate only: suppress a PHOTO-ONLY visit and nothing else, so
    // enabling marks cannot start suppressing unrelated lanes. A visit that
    // also holds a satellite line keeps its trace and its exterior scope.
    const photoOnly = Boolean(renderCapabilities.photo) && !renderCapabilities.satellite;
    return {
      suppressed: photoOnly,
      eligibility: photoOnly ? renderCapabilities.photo : null,
    };
  }
  // Satellite capability is what this verdict answers. Reporting the
  // satellite line (rather than whichever line combineLineVerdicts happened
  // to pick first) also keeps the geometry callers read order-independent.
  return {
    suppressed: !renderCapabilities.satellite,
    eligibility: renderCapabilities.satellite || eligibility,
  };
}

module.exports = {
  resolveTraceEligibility,
  resolveTraceRenderVerdict,
  combineLineVerdicts,
  resolveAddonVerdicts,
  addonVerdictsFromLines,
  frozenAddonLinesForCompletion,
  renderAreasFromRecord,
  pointerRequiredForKey,
  primaryIdentityFreezable,
  traceEligibilityGateOn,
  traceFeedFields,
  traceCaptureBlockPayload,
  _test: { FINDINGS_TYPE_RULES, SERVICE_KEY_RULES },
};
