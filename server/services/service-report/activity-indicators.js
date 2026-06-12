/**
 * Activity indicators + typed-findings snapshot builder for specialty
 * service completions (the 13 project types routed through the standard
 * Service Report V1 pipeline).
 *
 * Single source of truth for:
 *   - which project types get an activity gauge and under which label
 *   - findings-select → 0-5 score derivation (prefill; tech always wins)
 *   - score → customer wording (never show a raw number)
 *   - technician field labels → customer-facing report labels/values
 *   - typed-findings validation (required flags, unknown keys, score shape)
 *   - the persisted `typedReportSnapshot` (service_data) including the
 *     generated Today's Result copy — reports render from this snapshot
 *     forever; never recompute customer copy from live templates.
 *
 * Contract: docs/design/specialty-service-completion-contract.md
 */

const { PROJECT_TYPES, isValidProjectType } = require('../project-types');

// v2: rodent_trapping sectioned checklist fields (chips/count types,
// owner spec 2026-06-12). Snapshots are immutable — v1 snapshots keep
// rendering with their persisted labels.
const SCHEMA_VERSION = 2;
const COPY_MAP_VERSION = 2;
const SUMMARY_TEMPLATE_VERSION = 2;

// Customer wording per score. Never expose the numeric score in customer
// copy; banned-words rule (no "clear"/"eliminated"/"no infestation") applies.
const SCORE_LEVEL_WORDS = {
  0: 'No active signs observed today',
  1: 'Very low activity',
  2: 'Low activity',
  3: 'Moderate activity',
  4: 'High activity',
  5: 'Severe activity',
};

const TECH_SCORE_LABELS = {
  0: 'None',
  1: 'Very low',
  2: 'Low',
  3: 'Moderate',
  4: 'High',
  5: 'Severe',
};

// Shared 4-level select derivation (registry option string → score).
const LEVEL_SELECT_SCORES = {
  'None observed': 0,
  Low: 1,
  Moderate: 3,
  Heavy: 4,
  Severe: 5,
};

/**
 * Per-project-type indicator config.
 *   indicatorKey  — service_activity_scores key; shared across related types
 *                   so trends accrue per program (rodent trap + exclusion,
 *                   termite inspection + treatment).
 *   label         — customer-facing gauge label.
 *   pestNoun      — noun for Today's Result copy ("Cockroach activity was…").
 *   derive        — { field, scores } findings-select prefill, or null
 *                   (tech-set only).
 * Types without an entry get no gauge (one-shot treatments + inspections
 * per the contract).
 */
const ACTIVITY_INDICATORS = {
  rodent_trapping: {
    indicatorKey: 'rodent_activity',
    label: 'Rodent Activity',
    pestNoun: 'Rodent',
    derive: null,
  },
  rodent_exclusion: {
    indicatorKey: 'rodent_activity',
    label: 'Rodent Activity',
    pestNoun: 'Rodent',
    derive: null,
  },
  wildlife_trapping: {
    indicatorKey: 'wildlife_activity',
    label: 'Wildlife Activity',
    pestNoun: 'Wildlife',
    derive: null,
  },
  bed_bug: {
    indicatorKey: 'bed_bug_activity',
    label: 'Bed Bug Activity',
    pestNoun: 'Bed bug',
    derive: {
      field: 'evidence_level',
      scores: {
        'No active signs observed': 0,
        'Low (few bugs)': 1,
        Moderate: 3,
        Heavy: 4,
        'Severe infestation': 5,
      },
    },
  },
  cockroach: {
    indicatorKey: 'roach_activity',
    label: 'Roach Activity',
    pestNoun: 'Cockroach',
    derive: { field: 'activity_level', scores: LEVEL_SELECT_SCORES },
  },
  flea: {
    indicatorKey: 'flea_activity',
    label: 'Flea Activity',
    pestNoun: 'Flea',
    derive: { field: 'evidence_level', scores: LEVEL_SELECT_SCORES },
  },
  termite_inspection: {
    indicatorKey: 'termite_activity',
    label: 'Termite Activity',
    pestNoun: 'Termite',
    derive: {
      field: 'activity_status',
      scores: {
        'No activity': 0,
        'Old / inactive damage': 1,
        'Active infestation': 4,
      },
    },
  },
  termite_treatment: {
    indicatorKey: 'termite_activity',
    label: 'Termite Activity',
    pestNoun: 'Termite',
    derive: null,
  },
  // Station monitoring shares the termite program's indicator so quarterly
  // checks extend the same trend line as inspections/treatments.
  termite_bait_station: {
    indicatorKey: 'termite_activity',
    label: 'Termite Activity',
    pestNoun: 'Termite',
    derive: {
      field: 'termite_activity',
      scores: {
        'None observed': 0,
        'Previous feeding noted': 1,
        'Active termites present': 4,
      },
    },
  },
  // Exterior pressure is a DIFFERENT signal than interior trapping — own
  // indicator key so station trends never mix with trap-capture trends.
  // pestNoun 'Bait station' keeps headlines honest: "Bait station activity
  // was moderate today", never wording that implies interior infestation.
  rodent_bait_station: {
    indicatorKey: 'rodent_bait_activity',
    label: 'Bait Station Activity',
    pestNoun: 'Bait station',
    // Title-case noun for the progress-visit report label ("Rodent Bait
    // Station Program — Progress Visit"); pestNoun stays sentence-shaped
    // for headlines ("Bait station activity was moderate today").
    programNoun: 'Rodent Bait Station',
    derive: {
      field: 'bait_consumption',
      scores: {
        None: 0,
        Light: 2,
        Moderate: 3,
        Heavy: 4,
        Empty: 5,
      },
    },
  },
};

// Technician registry label → customer report label. Fields not listed fall
// back to a humanized registry label (flagged in golden-fixture review).
const CUSTOMER_FIELD_LABELS = {
  activity_level: 'Activity observed',
  evidence_level: 'Activity observed',
  severity: 'Activity observed',
  activity_status: 'Activity observed',
  activity_found: 'Activity observed',
  areas_inspected: 'Areas we checked',
  inspection_scope: 'Areas we checked',
  areas_treated: 'Areas we treated',
  treatment_areas: 'Areas we treated',
  rooms_treated: 'Areas we treated',
  harborage_locations: 'Where activity was concentrated',
  conducive_conditions: 'Conditions to address',
  treatment_performed: 'What we did',
  treatment_method: 'Treatment method',
  products_used: 'Products applied',
  bait_or_products_used: 'Products applied',
  prep_for_customer: 'What you can do',
  customer_instructions: 'What you can do',
  followup_plan: 'Next steps',
  daily_check_plan: 'Next steps',
  entry_points_found: 'Entry points we found',
  entry_points_observed: 'Entry points we found',
  traps_set: 'Traps in place',
  species: 'What we found',
  target_animal: 'What we found',
  target_pest: 'What we found',
  termite_type: 'What we found',
  target_termite: 'Target organism',
  pests_identified: 'What we found',
  sanitation_or_damage_notes: 'Damage & conditions noted',
  property_damage: 'Damage & conditions noted',
  infestation_extent: 'Extent of activity',
  treatment_recommendation: 'Recommended treatment',
  recommendation: 'Recommended next step',
  exclusion_completed: 'Sealing work completed',
  exclusion_pending: 'Sealing work still scheduled',
  standing_water_sources: 'Mosquito breeding sources found',
  condition_found: 'What we observed',
  turf_type: 'Lawn type',
  irrigation_or_cultural_notes: 'Watering & care notes',
  host_activity: 'Activity notes',
  event_context: 'Service context',
  weather_notes: 'Weather notes',
  palm_species: 'What we treated',
  palm_count: 'Palms treated',
  linear_feet_or_stations: 'Linear feet / stations',
  gallons_or_amount: 'Amount applied',
  evidence_observed: 'Evidence observed today',
  traps_checked: 'Traps checked',
  captures: 'Captures',
  trap_actions: 'Trap service performed',
  trap_activity_locations: 'Areas with trap activity',
  trap_quiet_locations: 'Areas with no trap activity',
  work_completed: 'Work completed today',
  sanitation_recommendations: 'Sanitation recommendations',
  exclusion_recommendation: 'Exclusion',
  exclusion_notes: 'Entry points to seal',
  customer_reported: 'What you told us',
  customer_discussed: 'What we discussed',
  total_stations: 'Stations on property',
  stations_checked: 'Stations checked',
  stations_inaccessible: 'Stations not accessible today',
  stations_with_activity: 'Stations with termite activity',
  station_actions: 'Station service performed',
  bait_consumption: 'Bait consumption',
  bait_replaced: 'Bait replaced',
  highest_activity_location: 'Highest activity at',
  bait_issues: 'Bait condition notes',
  bait_actions: 'Bait service performed',
  station_issues: 'Station condition notes',
  termite_activity: 'Termite activity',
  activity_signs: 'Activity signs observed',
  active_station_location: 'Active station location',
  activity_locations: 'Where activity was noted',
  treatment_completed: 'Treatment completed',
  treatment_zones: 'Areas we treated',
  standing_water: 'Standing water',
  breeding_sources: 'Breeding sources noted',
  source_reduction: 'Source reduction completed',
  sensitive_areas: 'Sensitive areas on site',
  sensitive_areas_avoided: 'Sensitive-area handling',
  weather_conditions: 'Weather at service time',
  customer_recommendations: 'What you can do',
  palms_serviced: 'Palms serviced',
  palm_condition: 'Overall palm condition',
  condition_observations: 'Canopy & growth observations',
  deficiency_signs: 'Nutrient observations',
  pest_disease_signs: 'Pest & disease check',
  lawn_condition: 'Lawn condition',
  turf_color: 'Turf color',
  weed_pressure: 'Weed pressure',
  insect_pressure: 'Insect pressure',
  disease_pressure: 'Disease pressure',
  turf_issues: 'Issues observed',
  irrigation_mowing: 'Irrigation & mowing notes',
  spot_treatment_areas: 'Spot-treated areas',
  inspection_type: 'Inspection type',
  findings_observed: 'What we observed',
  access_limitations: 'Inspection access notes',
  entry_points: 'Entry points we found',
  customer_prep: 'How you can help',
  prep_status: 'Prep status',
  rooms_treated: 'Rooms treated',
};

// Registry select value → customer wording, keyed per field family. Values
// not listed pass through verbatim.
const CUSTOMER_VALUE_LABELS = {
  // Owner wording rule: never claim a home is/will be "rodent-proof" —
  // exclusion copy stays "reduce rodent access" (also enforced by the
  // banned-copy list below).
  exclusion_recommendation: {
    'Not needed at this time': 'No exclusion work is needed at this time.',
    'Recommended after activity stops': 'Exclusion repairs are recommended to reduce rodent access once trapping activity stops.',
    'Quote provided — awaiting approval': 'An exclusion quote has been provided and is awaiting your approval.',
    'Approved — scheduling': 'Exclusion work is approved and will be scheduled.',
    'Completed previously': 'Exclusion repairs were completed previously.',
  },
  species: {
    German: 'German cockroaches',
    American: 'American cockroaches (palmetto bugs)',
    'Smoky brown': 'Smoky brown cockroaches',
    'Roof rat': 'Roof rats',
    'Norway rat': 'Norway rats',
    'House mouse': 'House mice',
    Mixed: 'Mixed species',
    Unknown: 'Species not yet confirmed',
  },
  activity_level: {
    'None observed': 'No active signs observed today',
    Low: 'Low activity',
    Light: 'Light activity',
    Moderate: 'Moderate activity',
    Heavy: 'High activity',
    Severe: 'Severe activity',
  },
  evidence_level: {
    'None observed': 'No active signs observed today',
    'No active signs observed': 'No active signs observed today',
    'Low (few bugs)': 'Low activity',
    Low: 'Low activity',
    Moderate: 'Moderate activity',
    Heavy: 'High activity',
    Severe: 'Severe activity',
    'Severe infestation': 'Severe activity',
  },
  severity: {
    'None observed': 'No active signs observed today',
    Low: 'Low activity',
    Moderate: 'Moderate activity',
    Heavy: 'High activity',
    Severe: 'Severe activity',
  },
  activity_status: {
    'No activity': 'No active signs observed today',
    'Old / inactive damage': 'Older, inactive damage only',
    'Active infestation': 'Active termite activity found',
  },
  treatment_method: {
    'Chemical only': 'Chemical treatment',
    'Heat only': 'Heat treatment',
    'Chemical + heat': 'Combined chemical and heat treatment',
    'Steam + chemical': 'Combined steam and chemical treatment',
  },
  standing_water: {
    Yes: 'Standing water was found — see the breeding sources noted below',
    No: 'No standing water was found today',
  },
  sensitive_areas_avoided: {
    Avoided: 'Sensitive areas were avoided during treatment',
    'Treated with care': 'Sensitive areas were treated with care',
    'None present': 'No sensitive areas were present',
  },
  // Owner wording rule: observation-scoped absence claims only — never
  // "no disease exists" style absolutes.
  deficiency_signs: {
    'None observed today': "No nutrient deficiency signs were observed at today's service",
  },
  pest_disease_signs: {
    'None observed today': "No visible pest or disease indicators were observed at today's service",
  },
  weed_pressure: {
    'None observed': 'No active weeds observed today',
  },
  insect_pressure: {
    'None observed': 'No signs observed today',
    Suspected: 'Suspected — we are monitoring',
    Confirmed: 'Confirmed today',
  },
  disease_pressure: {
    'None observed': 'No signs observed today',
    Suspected: 'Suspected — we are monitoring',
    Confirmed: 'Confirmed today',
  },
  findings_observed: {
    'No live activity observed': 'No live pest activity observed in accessible areas today',
  },
  prep_status: {
    Completed: 'Prep completed — thank you!',
    Partial: 'Prep partially completed — see the prep list below',
    'Not started': 'Prep not yet started — see the prep list below',
  },
  // Owner wording rules (bait stations): termite absence claims stay scoped
  // to the accessible stations inspected today — never "no termites on
  // property". Rodent consumption = EXTERIOR pressure, never an interior
  // infestation claim.
  termite_activity: {
    'None observed': 'No termite activity was observed in the accessible stations during today’s inspection',
    'Active termites present': 'Active termite feeding was observed — see the station details below',
    'Previous feeding noted': 'Previous feeding was noted — no live termite activity was observed today',
  },
  // Shared field key, type-distinct VALUES: rodent uses None/Light/…/Empty
  // (exterior-pressure wording), termite uses 'None — bait intact' /
  // '* feeding' (colony-feeding wording). Keep the value sets disjoint or
  // one type's copy will leak onto the other's reports.
  bait_consumption: {
    None: 'No bait consumption observed today',
    Light: 'Light consumption — indicates some exterior rodent activity',
    Moderate: 'Moderate consumption — indicates exterior rodent activity',
    Heavy: 'Heavy consumption — indicates strong exterior rodent pressure',
    Empty: 'Bait fully consumed — indicates strong exterior rodent pressure',
    'None — bait intact': 'Bait intact — no feeding observed',
    'Light feeding': 'Light termite feeding on the bait',
    'Moderate feeding': 'Moderate termite feeding on the bait',
    'Heavy feeding': 'Heavy termite feeding on the bait',
  },
  bait_replaced: {
    Yes: 'Bait was replaced today',
    No: 'No replacement needed',
  },
};

// Required service-specific fields per type (contract §4; budget ≤4 except
// the Tier-3 compliance type). Enforcement is keyed to the profile cutover
// state by the caller — the registry itself stays permissive.
const REQUIRED_FINDINGS_FIELDS = {
  pest_inspection: ['severity'],
  one_time_pest_treatment: ['activity_level'],
  mosquito_event: ['activity_level', 'standing_water'],
  palm_injection: ['palm_condition'],
  one_time_lawn_treatment: ['lawn_condition'],
  cockroach: ['species', 'activity_level'],
  flea: ['evidence_level'],
  rodent_trapping: ['species'],
  rodent_exclusion: ['species'],
  wildlife_trapping: ['target_animal'],
  bed_bug: ['evidence_level', 'treatment_method'],
  termite_inspection: ['termite_type', 'activity_status'],
  termite_treatment: [
    'target_termite',
    'treatment_method',
    'products_used',
    'linear_feet_or_stations',
    'gallons_or_amount',
  ],
  termite_bait_station: ['stations_checked', 'termite_activity', 'bait_consumption'],
  rodent_bait_station: ['stations_checked', 'bait_consumption'],
};

// Next-step chips per type (contract §7). Each chip maps to the
// deterministic next-step sentence used in Today's Result.
const NEXT_STEP_CHIPS = {
  'No action needed': 'No further action is needed right now.',
  'Monitor activity': 'Monitor for activity and contact us if anything returns.',
  'Sanitation recommended': 'Improving sanitation in the noted areas will help keep activity down.',
  'Reduce moisture': 'Reducing moisture in the noted areas will help keep activity down.',
  'Seal entry gaps': 'Sealing the noted entry gaps will help prevent re-entry.',
  'Remove cardboard/clutter': 'Removing cardboard and clutter will remove harborage for pests.',
  'Keep treated areas undisturbed': 'Please keep treated areas undisturbed so the treatment can work.',
  'Follow-up recommended': 'A follow-up visit is recommended — we will help you get it scheduled.',
  'Vacuum daily for 2 weeks': 'Vacuum daily for the next two weeks to remove emerging fleas.',
  'Wash pet bedding': 'Wash pet bedding on high heat.',
  'Coordinate vet flea control': 'Coordinate flea prevention for pets with your veterinarian.',
  'Stay off treated areas until dry': 'Stay off treated areas until they are fully dry.',
  'Trap check scheduled': 'We will return for the scheduled trap check.',
  'Seal entry points': 'Sealing the identified entry points is the key next step.',
  'Monitor for new activity': 'Monitor for new activity and let us know if anything changes.',
  'Exclusion work scheduled': 'The entry-point sealing work is scheduled.',
  'Continue trapping': 'Trapping will continue until activity is reduced.',
  'Await exclusion approval': 'Entry-point sealing will be scheduled once the exclusion quote is approved.',
  'Monitor after no activity': 'With no recent activity, we will continue monitoring before removing traps.',
  'Remove traps after inactivity': 'Traps will be removed once the inactivity period is confirmed.',
  'Continue mosquito program': 'We will continue your regular mosquito service.',
  'Recheck breeding areas next visit': 'We will recheck the noted breeding areas on the next visit.',
  'Monitor after rainfall': 'Monitor mosquito activity after rainfall and let us know what you see.',
  'Customer action — remove standing water': 'Removing the noted standing water will make a big difference before the next visit.',
  'Callback if activity persists': 'If activity stays high after the treatment window, contact us for a callback visit.',
  'Continue palm program': 'We will continue your palm care program.',
  'Monitor canopy response': 'We will monitor canopy response over the next visits.',
  'Injection recommended': 'A palm injection is recommended to address the noted deficiency.',
  'Arborist review recommended': 'An arborist evaluation is recommended for the noted concern.',
  'Removal evaluation recommended': 'A removal evaluation is recommended for the declining palm.',
  'Continue lawn program': 'We will continue your lawn care program.',
  'Recheck next visit': 'We will recheck the noted areas on the next visit.',
  'Add-on treatment recommended': 'An add-on treatment is recommended — we will help you get it scheduled.',
  'Irrigation correction needed': 'Correcting the noted irrigation issue will help the lawn recover.',
  'Callback if no improvement': 'If you do not see improvement, contact us for a callback visit.',
  'Treatment recommended': 'A treatment program is recommended — we will help you get it scheduled.',
  'Estimate to follow': 'We will follow up with an estimate for the recommended work.',
  'Exclusion recommended': 'Sealing work is recommended to reduce pest access.',
  'Follow-up in 10–14 days': 'A follow-up visit in 10–14 days is recommended to stay ahead of newly hatching activity.',
  'No store-bought sprays': 'Please avoid store-bought sprays — they interfere with the bait placements.',
  'Install one-way device': 'A one-way exit device will be installed so the animal can leave but not return.',
  'Exclusion after activity stops': 'Entry points will be sealed once activity has stopped.',
  'Attic sanitation recommended': 'Attic sanitation is recommended after removal is complete.',
  'Daily trap checks underway': 'Daily trap checks are underway as required.',
  'Avoid trap area': 'Please avoid the trap area so the trap can do its job.',
  'Secure trash/food sources': 'Securing trash and outdoor food sources will reduce wildlife pressure.',
  'Follow prep sheet': 'Please follow the prep sheet before the next visit.',
  'Wash/dry bedding on high heat': 'Wash and dry bedding on high heat.',
  '14-day follow-up scheduled': 'Your 14-day follow-up visit will confirm the treatment is working.',
  'Continue monitoring': 'Continue monitoring and contact us if activity returns.',
  'Dump standing water weekly': 'Dump standing water around the property weekly.',
  'Avoid treated foliage until dry': 'Avoid treated foliage until it is fully dry.',
  'Follow watering guidance': 'Follow the watering guidance in this report.',
  'Mow guidance provided': 'Follow the mowing guidance in this report.',
  'Re-check scheduled': 'We will re-check the treated areas on the scheduled visit.',
  'Retreatment scheduled': 'Retreatment is scheduled to keep protection current.',
  'Monitor fronds for change': 'Monitor the fronds for change and let us know what you see.',
  'Continue scheduled monitoring': 'We will continue your scheduled bait station monitoring.',
  'Recheck active station sooner': 'We will recheck the active station ahead of the normal monitoring interval.',
  'Replace damaged station': 'The damaged station will be replaced.',
  'Return when access available': 'We will check the inaccessible station once access is available.',
  'Moisture correction recommended': 'Correcting the noted moisture condition will reduce termite-conducive conditions near the structure.',
  'Continue bait station service': 'We will continue your scheduled bait station service.',
  'Recheck high-consumption station': 'We will recheck bait levels at the high-activity station on the next visit.',
  'Add station': 'An additional bait station is recommended for better coverage.',
  'Rodent inspection recommended': 'A full rodent inspection is recommended based on the activity observed.',
  'Customer action needed': 'Your help with the recommendations above will reduce activity before our next visit.',
};

const MAX_NEXT_STEP_CHIPS = 4;

// Types whose completion must select at least one next-step chip (owner
// spec: every report ends with a clear next action). Enforced in the typed
// /complete path; served to clients in the schema slice so the panel can
// mark the section required.
const REQUIRED_NEXT_STEP_TYPES = new Set([
  'rodent_trapping', 'mosquito_event', 'palm_injection', 'one_time_lawn_treatment',
  'pest_inspection', 'cockroach', 'wildlife_trapping', 'bed_bug',
  'termite_bait_station', 'rodent_bait_station',
]);

function nextStepRequiredForType(projectType) {
  return REQUIRED_NEXT_STEP_TYPES.has(projectType);
}

// Per-type chip allowlists (contract §7) — the global map alone would let a
// cockroach completion persist lawn/mosquito guidance into the immutable
// snapshot. Schema serving and validation both use the type's list.
const PEST_FAMILY_CHIPS = [
  'No action needed', 'Monitor activity', 'Sanitation recommended',
  'Reduce moisture', 'Seal entry gaps', 'Remove cardboard/clutter',
  'Keep treated areas undisturbed', 'Follow-up recommended',
];
const RODENT_FAMILY_CHIPS = [
  'No action needed', 'Trap check scheduled', 'Seal entry points',
  'Sanitation recommended', 'Monitor for new activity', 'Exclusion work scheduled',
  'Follow-up recommended',
];
// Trapping-specific next steps (owner spec, 2026-06-12): every trapping
// report ends with a clear next action — see REQUIRED_NEXT_STEP_TYPES.
const RODENT_TRAPPING_CHIPS = [
  'Continue trapping', 'Trap check scheduled', 'Await exclusion approval',
  'Exclusion work scheduled', 'Monitor after no activity',
  'Remove traps after inactivity', 'Seal entry points', 'Sanitation recommended',
];
const TYPE_NEXT_STEP_CHIPS = {
  pest_inspection: [
    'No action needed', 'Treatment recommended', 'Follow-up recommended',
    'Estimate to follow', 'Exclusion recommended', 'Monitor activity', 'Seal entry gaps',
  ],
  one_time_pest_treatment: PEST_FAMILY_CHIPS,
  cockroach: [...PEST_FAMILY_CHIPS, 'Follow-up in 10–14 days', 'No store-bought sprays'],
  flea: [
    'No action needed', 'Vacuum daily for 2 weeks', 'Wash pet bedding',
    'Coordinate vet flea control', 'Stay off treated areas until dry',
    'Follow-up recommended', 'Monitor activity',
  ],
  rodent_trapping: RODENT_TRAPPING_CHIPS,
  rodent_exclusion: RODENT_FAMILY_CHIPS,
  wildlife_trapping: [
    'Continue trapping', 'Daily trap checks underway', 'Install one-way device',
    'Exclusion after activity stops', 'Remove traps after inactivity',
    'Attic sanitation recommended', 'Avoid trap area', 'Secure trash/food sources',
    'Monitor for new activity', 'No action needed',
  ],
  bed_bug: [
    'Follow prep sheet', 'Wash/dry bedding on high heat',
    '14-day follow-up scheduled', 'Follow-up in 10–14 days', 'Continue monitoring',
  ],
  mosquito_event: [
    'Continue mosquito program', 'Recheck breeding areas next visit', 'Monitor after rainfall',
    'Customer action — remove standing water', 'Callback if activity persists',
    'Dump standing water weekly', 'Avoid treated foliage until dry', 'No action needed',
  ],
  one_time_lawn_treatment: [
    'Continue lawn program', 'Recheck next visit', 'Add-on treatment recommended',
    'Irrigation correction needed', 'Callback if no improvement',
    'Follow watering guidance', 'Mow guidance provided', 'No action needed',
  ],
  palm_injection: [
    'Continue palm program', 'Monitor canopy response', 'Injection recommended',
    'Arborist review recommended', 'Removal evaluation recommended',
    'Retreatment scheduled', 'Monitor fronds for change', 'No action needed',
  ],
  termite_inspection: ['No action needed', 'Monitor activity', 'Follow-up recommended'],
  termite_treatment: ['No action needed', 'Monitor activity', 'Follow-up recommended'],
  termite_bait_station: [
    'Continue scheduled monitoring', 'Recheck active station sooner', 'Replace damaged station',
    'Return when access available', 'Moisture correction recommended',
    'Follow-up recommended', 'No action needed',
  ],
  rodent_bait_station: [
    'Continue bait station service', 'Recheck high-consumption station', 'Add station',
    'Replace damaged station', 'Rodent inspection recommended', 'Exclusion recommended',
    'Customer action needed', 'Monitor activity',
  ],
};

function chipsForType(projectType) {
  return TYPE_NEXT_STEP_CHIPS[projectType] || [];
}

function getActivityIndicator(projectType) {
  return ACTIVITY_INDICATORS[projectType] || null;
}

function isTypedFindingsType(projectType) {
  return isValidProjectType(projectType);
}

function scoreLevelWord(score) {
  return SCORE_LEVEL_WORDS[score] ?? null;
}

/**
 * Findings-derived prefill score for a type, or null when the type has no
 * derivation (tech-set only) or the source field has no recognized value.
 */
function deriveActivityScore(projectType, values = {}) {
  const indicator = ACTIVITY_INDICATORS[projectType];
  if (!indicator || !indicator.derive) return null;
  const raw = values[indicator.derive.field];
  if (raw == null || raw === '') return null;
  const score = indicator.derive.scores[String(raw)];
  if (score == null) return null;
  return {
    score,
    field: indicator.derive.field,
    value: String(raw),
  };
}

function humanizeFieldKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function customerLabelForField(fieldKey, technicianLabel) {
  return CUSTOMER_FIELD_LABELS[fieldKey] || technicianLabel || humanizeFieldKey(fieldKey);
}

function customerLabelForValue(fieldKey, value) {
  const map = CUSTOMER_VALUE_LABELS[fieldKey];
  if (map && Object.prototype.hasOwnProperty.call(map, String(value))) {
    return map[String(value)];
  }
  return String(value);
}

/**
 * Validate a typed-findings submission against the registry.
 *
 * @param {object} opts
 * @param {string} opts.type            submitted structuredFindings.type
 * @param {object} opts.values          submitted field values
 * @param {string} opts.expectedType    profile.findingsType for the job
 * @param {boolean} opts.enforceRequired whether required-field gating applies
 *                                      (true once the type is cut over AND the
 *                                      client submitted typed findings)
 * @returns {{ ok: boolean, errors: string[], missing: string[] }}
 */
function validateTypedFindings({ type, values, expectedType, enforceRequired = false } = {}) {
  const errors = [];
  const missing = [];

  if (!type || !isValidProjectType(type)) {
    return { ok: false, errors: [`Unknown findings type: ${type}`], missing };
  }
  if (expectedType && type !== expectedType) {
    return {
      ok: false,
      errors: [`Findings type ${type} does not match this service's expected type ${expectedType}`],
      missing,
    };
  }
  if (values == null || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, errors: ['structuredFindings.values must be an object'], missing };
  }

  const fields = PROJECT_TYPES[type].findingsFields || [];
  const knownKeys = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(values)) {
    if (!knownKeys.has(key)) errors.push(`Unknown findings field: ${key}`);
  }
  for (const field of fields) {
    const value = values[field.key];
    if (value == null || value === '') continue;
    if (field.type === 'select' && Array.isArray(field.options) && field.options.length) {
      if (!field.options.includes(String(value))) {
        errors.push(`Invalid value for ${field.key}: ${value}`);
      }
    }
    // chips store a comma-joined selection (multi_select convention) —
    // every element must come from the field's options so an off-list
    // string can't reach the immutable customer-facing snapshot.
    if (field.type === 'chips' && Array.isArray(field.options) && field.options.length) {
      const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        if (!field.options.includes(part)) {
          errors.push(`Invalid value for ${field.key}: ${part}`);
        }
      }
    }
    if (field.type === 'count') {
      // Validate shape BEFORE coercion: Number(false) / Number([]) /
      // Number('  ') all coerce to 0 and would persist bogus counts into
      // the immutable snapshot (hook P1). Only integer numbers and
      // digit-only strings count.
      const str = typeof value === 'number'
        ? String(value)
        : (typeof value === 'string' ? value.trim() : null);
      if (str == null || !/^\d{1,4}$/.test(str)) {
        errors.push(`Invalid count for ${field.key}: ${value}`);
      }
    }
    if (typeof value === 'string' && value.length > 4000) {
      errors.push(`Value for ${field.key} exceeds 4000 characters`);
    }
  }

  if (enforceRequired) {
    for (const key of REQUIRED_FINDINGS_FIELDS[type] || []) {
      const value = values[key];
      if (value == null || String(value).trim() === '') missing.push(key);
    }
  }

  return { ok: errors.length === 0 && missing.length === 0, errors, missing };
}

function validateNextStepChips(chips, projectType = null) {
  if (chips == null) return { ok: true, chips: [] };
  if (!Array.isArray(chips)) return { ok: false, error: 'nextStepChips must be an array' };
  if (chips.length > MAX_NEXT_STEP_CHIPS) {
    return { ok: false, error: `At most ${MAX_NEXT_STEP_CHIPS} next-step chips allowed` };
  }
  const allowed = projectType ? chipsForType(projectType) : Object.keys(NEXT_STEP_CHIPS);
  const normalized = [];
  for (const chip of chips) {
    const key = String(chip || '').trim();
    if (!key) continue;
    if (!allowed.includes(key)) {
      return { ok: false, error: `Next-step chip not available for this service: ${key}` };
    }
    if (!normalized.includes(key)) normalized.push(key);
  }
  return { ok: true, chips: normalized };
}

function trendWordForScores(score, priorScore) {
  if (priorScore == null) return null;
  if (score < priorScore) return 'decreased since the last visit';
  if (score > priorScore) return 'increased since the last visit';
  return 'about the same as the last visit';
}

function trendDirection(score, priorScore) {
  if (priorScore == null) return null;
  if (score < priorScore) return 'improving';
  if (score > priorScore) return 'worsening';
  return 'stable';
}

function firstSentenceFrom(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const period = text.endsWith('.') ? '' : '.';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${period}`;
}

function nextStepSentence(chips = []) {
  const sentences = chips
    .map((chip) => NEXT_STEP_CHIPS[chip])
    .filter(Boolean);
  if (!sentences.length) return 'Contact us if you have any questions.';
  return sentences.join(' ');
}

function joinPhrases(parts) {
  if (!parts.length) return null;
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// Deterministic "what we did" sentence for trapping programs (rodent +
// wildlife), composed from the sectioned checklist (counts + action chips)
// instead of free text. Returns null when nothing trap-related was recorded
// so the generic fallback chain applies.
function trapActivitySentence(values = {}) {
  const parts = [];
  const checked = Number(values.traps_checked);
  if (Number.isInteger(checked) && checked > 0) {
    parts.push(`checked ${checked} trap${checked === 1 ? '' : 's'}`);
  }
  const capturesRaw = values.captures;
  const captures = Number(capturesRaw);
  if (Number.isInteger(captures) && captures > 0) {
    parts.push(`removed ${captures} capture${captures === 1 ? '' : 's'}`);
  } else if (capturesRaw != null && capturesRaw !== '' && captures === 0 && parts.length) {
    parts.push('found no new captures');
  }
  // Both trapping vocabularies: rodent ('Traps reset', 'New traps added')
  // and wildlife ('Trap installed', 'One-way door installed').
  const actions = String(values.trap_actions || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (actions.includes('trap installed')) parts.push('installed traps');
  if (actions.includes('new traps added')) parts.push('added new traps');
  if (actions.includes('traps reset')) parts.push('reset the traps');
  if (actions.includes('traps moved')) parts.push('repositioned traps');
  if (actions.includes('one-way door installed')) parts.push('installed a one-way exit device');
  if (actions.includes('bait/lure refreshed')) parts.push('refreshed the bait');
  if (actions.includes('trap removed')) parts.push('removed traps');
  const work = String(values.work_completed || '').toLowerCase();
  if (work.includes('exterior inspection completed')) parts.push('completed an exterior inspection');
  const joined = joinPhrases(parts);
  return joined ? `We ${joined} today.` : null;
}

// Work-chip → verb-phrase maps for the composed "what we did" sentence.
// Only selected chips with a phrase contribute; types without an entry (or
// with no selections) fall through to the generic fallback chain.
const WORK_PHRASE_FIELDS = {
  mosquito_event: {
    field: 'treatment_completed',
    phrases: {
      'Barrier treatment': 'completed a mosquito barrier treatment',
      'Adulticide treatment': 'treated for adult mosquitoes',
      'Larvicide applied': 'applied larvicide to water-holding areas',
      'Resting-site treatment': 'treated shaded resting areas',
      'Source reduction': 'completed source reduction',
      'Inspection only': 'completed a mosquito inspection',
    },
  },
  palm_injection: {
    field: 'work_completed',
    phrases: {
      'Palm fertilizer applied': 'applied palm fertilizer around the root zone',
      'Liquid micronutrient treatment': 'applied a liquid micronutrient treatment',
      'Soil drench': 'completed a soil drench',
      'Insect treatment': 'treated for insect activity',
      'Disease treatment': 'applied a disease treatment',
      'Palm injection completed': 'completed the palm injection',
      'Soil acidifier applied': 'applied a soil acidifier',
      'Canopy / crown inspection': 'inspected the canopy and crown areas',
    },
  },
  one_time_lawn_treatment: {
    field: 'work_completed',
    phrases: {
      'Fertilizer applied': 'applied fertilizer',
      'Weed control applied': 'applied weed control',
      'Insect control applied': 'applied insect control',
      'Disease control applied': 'applied disease control',
      'Iron / micronutrients applied': 'applied iron and micronutrients',
      'Biostimulant applied': 'applied a biostimulant',
      'Soil amendment applied': 'applied a soil amendment',
      'Wetting agent applied': 'applied a wetting agent',
      'Spot treatment completed': 'spot-treated the noted areas',
      'Inspection completed': 'completed a lawn inspection',
    },
  },
  cockroach: {
    field: 'work_completed',
    phrases: {
      'Bait placement': 'placed targeted bait',
      'Insect growth regulator': 'applied an insect growth regulator',
      'Crack & crevice treatment': 'treated cracks and crevices',
      'Dust application': 'applied dust to voids',
      'Flush-out treatment': 'completed a flush-out treatment',
      'Exterior perimeter treatment': 'treated the exterior perimeter',
      'Glue boards placed': 'placed glue boards',
      'Monitoring stations placed': 'placed monitoring stations',
      'Sanitation review completed': 'reviewed sanitation together',
    },
  },
  bed_bug: {
    field: 'work_completed',
    phrases: {
      'Crack & crevice treatment': 'treated cracks and crevices',
      'Mattress / box spring treatment': 'treated the mattress and box spring',
      'Bed frame treatment': 'treated the bed frame',
      'Baseboard treatment': 'treated the baseboards',
      'Furniture treatment': 'treated nearby furniture',
      'Dust application': 'applied dust to voids',
      'Steam treatment': 'completed a steam treatment',
      'Vacuuming completed': 'vacuumed harborage areas',
      'Encasement installed': 'installed mattress encasements',
      'Interceptors installed': 'placed interceptors under bed legs',
      'Adjacent rooms inspected': 'inspected adjacent rooms',
    },
  },
};

// Deterministic "what we did" sentence for bait station checks, composed
// from the station counts + service chips. Accessibility is part of what
// the customer needs to know (owner spec), so inaccessible stations get a
// sentence of their own. Returns null when no station count was recorded.
function baitStationSentence(projectType, values = {}) {
  const checked = Number(values.stations_checked);
  if (!Number.isInteger(checked) || checked <= 0) return null;
  const plural = checked === 1 ? '' : 's';
  const serviced = String(values.station_actions || values.bait_actions || '').trim().length > 0;
  let sentence = projectType === 'termite_bait_station'
    ? `We inspected ${checked} termite bait station${plural} around the exterior perimeter today.`
    : `We checked${serviced ? ' and serviced' : ''} ${checked} exterior rodent bait station${plural} today.`;
  const inaccessible = Number(values.stations_inaccessible);
  if (Number.isInteger(inaccessible) && inaccessible > 0) {
    sentence += ` ${inaccessible} station${inaccessible === 1 ? ' was' : 's were'} not accessible and will be checked when access is available.`;
  }
  return sentence;
}

function composedWorkSentence(projectType, values = {}) {
  // Inspection visits compose from the areas covered instead of work chips.
  if (projectType === 'pest_inspection') {
    const areas = String(values.areas_inspected || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((a) => (a === a.toUpperCase() ? a : a.charAt(0).toLowerCase() + a.slice(1)));
    if (!areas.length) return null;
    return `We inspected the ${joinPhrases(areas)}.`;
  }
  const config = WORK_PHRASE_FIELDS[projectType];
  if (!config) return null;
  const phrases = String(values[config.field] || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((chip) => config.phrases[chip])
    .filter(Boolean);
  const joined = joinPhrases(phrases);
  return joined ? `We ${joined} today.` : null;
}

/**
 * Deterministic Today's Result copy (contract §6). AI may later polish the
 * recommendations field, but this template output always exists and always
 * sends — AI is never in the critical path.
 */
function buildTodaysResult({
  projectType,
  reportTypeLabel,
  values = {},
  chips = [],
  activity = null,
  visitSequence = 1,
}) {
  const indicator = ACTIVITY_INDICATORS[projectType];
  // Sectioned-checklist types compose "what we did" from their selections
  // (trapping: counts + actions; others: work chips; inspections: areas).
  // The free-text keys stay in the fallback chain so pre-v2 drafts still
  // produce a sentence.
  const isTrappingType = projectType === 'rodent_trapping' || projectType === 'wildlife_trapping';
  const isBaitStationType = projectType === 'termite_bait_station' || projectType === 'rodent_bait_station';
  const whatWeDid = (isTrappingType && trapActivitySentence(values))
    || (isBaitStationType && baitStationSentence(projectType, values))
    || composedWorkSentence(projectType, values)
    || firstSentenceFrom(
      values.treatment_performed || values.exclusion_completed || values.areas_treated || values.traps_set,
      'We completed the scheduled service.'
    );
  const nextStep = nextStepSentence(chips);

  // Bait station zero states use the owner's required scoped wording —
  // accessible-stations-only for termite, consumption+evidence for rodent —
  // in place of the generic "No active signs of X activity" line. Trend
  // headlines on later visits still come from the generic indicator block.
  if (isBaitStationType && activity && activity.score === 0
    && !(visitSequence > 1 && activity.trendWord)) {
    return {
      headline: projectType === 'termite_bait_station'
        ? 'No termite activity was observed in the accessible bait stations today.'
        : 'No bait consumption or visible rodent evidence was observed today.',
      body: `${whatWeDid} ${nextStep}`,
      nextStep,
    };
  }

  // Mosquito has no 0-5 gauge (not a trend type) but the owner template
  // leads with the observed level: "Mosquito activity was light today."
  if (projectType === 'mosquito_event' && values.activity_level) {
    const level = String(values.activity_level);
    if (level === 'None observed') {
      return {
        headline: 'No active signs of mosquito activity observed today.',
        body: `${whatWeDid} Continue monitoring and contact us if activity returns.`,
        nextStep,
      };
    }
    if (['Light', 'Moderate', 'Heavy'].includes(level)) {
      return {
        headline: `Mosquito activity was ${level.toLowerCase()} today.`,
        body: `${whatWeDid} ${nextStep}`,
        nextStep,
      };
    }
  }

  // Bed bug zero state uses fixed, approved copy (contract §6).
  if (projectType === 'bed_bug' && activity && activity.score === 0) {
    return {
      headline: "No active signs observed during today's service.",
      body: `${whatWeDid} Continue monitoring and contact us if activity returns.`,
      nextStep,
    };
  }

  if (indicator && activity && activity.score != null) {
    const noun = indicator.pestNoun;
    if (visitSequence > 1 && activity.trendWord) {
      // Stable needs its own sentence shape — "has about the same as the
      // last visit since our last visit" is not English (Codex P2).
      const headline = activity.trend === 'stable'
        ? `${noun} activity is about the same as our last visit.`
        : `${noun} activity has ${activity.trend === 'worsening' ? 'increased' : 'decreased'} since our last visit.`;
      return {
        headline,
        body: `${whatWeDid} ${nextStep}`,
        nextStep,
      };
    }
    if (activity.score === 0) {
      return {
        headline: `No active signs of ${noun.toLowerCase()} activity observed today.`,
        body: `${whatWeDid} Continue monitoring and contact us if activity returns.`,
        nextStep,
      };
    }
    const levelWord = SCORE_LEVEL_WORDS[activity.score] || 'activity';
    return {
      headline: `${noun} activity was ${levelWord.replace(' activity', '').toLowerCase()} today.`,
      body: `${whatWeDid} ${nextStep}`,
      nextStep,
    };
  }

  // Non-gauge types (one-shot treatments + pest inspection).
  const zeroSeverity = ['None observed', 'No activity'].includes(
    String(values.severity || values.activity_level || '')
  );
  if (zeroSeverity) {
    return {
      headline: 'No active signs of pest activity observed today.',
      body: `${whatWeDid} Continue monitoring and contact us if activity returns.`,
      nextStep,
    };
  }
  return {
    // The label suffix reads awkwardly in a headline ("Palm Injection
    // Summary completed today") — the approved golden-fixture style is
    // "Palm Injection Treatment completed today."
    headline: `${reportTypeLabel.replace(/ Summary$/, '')} completed today.`,
    body: `${whatWeDid} ${nextStep}`,
    nextStep,
  };
}

/**
 * Build the persisted typedReportSnapshot. The report renders from this
 * forever — every customer-facing label/value is resolved HERE, at
 * completion time, and versioned.
 *
 * Zero-state rule: only null/undefined/'' are skipped when building items.
 * 0, false, and "none"-class select values are results and are included.
 */
function buildTypedReportSnapshot({
  projectType,
  values = {},
  nextStepChips = [],
  serviceKey = null,
  serviceLabel = null,
  visitSequence = 1,
  activity = null,
  photoSummary = null,
}) {
  const config = PROJECT_TYPES[projectType];
  if (!config) return null;

  const reportTypeLabel = serviceLabel
    ? `${serviceLabel} Summary`
    : `${config.label} Summary`;
  const resolvedReportTypeLabel = visitSequence > 1 && ACTIVITY_INDICATORS[projectType]
    ? `${ACTIVITY_INDICATORS[projectType].programNoun || ACTIVITY_INDICATORS[projectType].pestNoun} Program — Progress Visit`
    : reportTypeLabel;

  const items = [];
  for (const field of config.findingsFields || []) {
    const value = values[field.key];
    if (value == null || value === '') continue;
    // chips persist a comma-joined selection — map each element through
    // the copy map individually so per-chip customer wording applies.
    const customerValueLabel = field.type === 'chips'
      ? String(value).split(',').map((s) => s.trim()).filter(Boolean)
        .map((part) => customerLabelForValue(field.key, part)).join(', ')
      : customerLabelForValue(field.key, value);
    items.push({
      fieldKey: field.key,
      technicianLabel: field.label,
      customerLabel: customerLabelForField(field.key, field.label),
      value,
      customerValueLabel,
    });
  }

  const todaysResult = buildTodaysResult({
    projectType,
    reportTypeLabel: resolvedReportTypeLabel,
    values,
    chips: nextStepChips,
    activity,
    visitSequence,
  });

  return {
    type: projectType,
    typeLabel: config.label,
    schemaVersion: SCHEMA_VERSION,
    copyMapVersion: COPY_MAP_VERSION,
    summaryTemplateVersion: SUMMARY_TEMPLATE_VERSION,
    serviceKey,
    serviceLabel,
    reportTypeLabel: resolvedReportTypeLabel,
    visitSequence,
    values,
    nextStepChips,
    todaysResult,
    // Customer-facing photo summary (AI-drafted, tech-reviewed, banned-copy
    // validated in the complete path) — renders atop the report's Field
    // Photos section.
    photoSummary: photoSummary ? String(photoSummary).slice(0, 600) : null,
    findings: items,
    activity: activity
      ? {
        indicatorKey: activity.indicatorKey,
        label: activity.label,
        score: activity.score,
        levelWord: SCORE_LEVEL_WORDS[activity.score] ?? null,
        source: activity.source,
        derivedFrom: activity.derivedFrom || null,
        trend: activity.trend || null,
        trendWord: activity.trendWord || null,
      }
      : null,
  };
}

/**
 * Findings-schema slice served to completion clients (embedded in the
 * dispatch jobs payload so mobile completion never blocks on a registry
 * fetch).
 */
function findingsSchemaForType(projectType) {
  const config = PROJECT_TYPES[projectType];
  if (!config) return null;
  const indicator = ACTIVITY_INDICATORS[projectType] || null;
  return {
    type: projectType,
    label: config.label,
    schemaVersion: SCHEMA_VERSION,
    copyMapVersion: COPY_MAP_VERSION,
    fields: (config.findingsFields || []).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      section: f.section || null,
      options: f.options || null,
      placeholder: f.placeholder || null,
      required: (REQUIRED_FINDINGS_FIELDS[projectType] || []).includes(f.key),
    })),
    photoCategories: config.photoCategories || [],
    requiredFields: REQUIRED_FINDINGS_FIELDS[projectType] || [],
    nextStepChips: chipsForType(projectType),
    nextStepRequired: nextStepRequiredForType(projectType),
    activity: indicator
      ? {
        indicatorKey: indicator.indicatorKey,
        label: indicator.label,
        deriveField: indicator.derive?.field || null,
        deriveScores: indicator.derive?.scores || null,
        techScoreLabels: TECH_SCORE_LABELS,
      }
      : null,
  };
}

// Customer-copy claims the business never makes (contract §6/§9): absence
// wording must stay observational ("no active signs observed today"), never
// absolute or promissory. Used to validate AI-drafted recommendations before
// they can reach a customer-facing report. "clear" is banned as a STATE
// claim ("areas are clear", "clear of pests", "activity cleared") but the
// imperative verb stays allowed — "please clear food debris" is legitimate
// sanitation advice.
const BANNED_CUSTOMER_COPY = [
  /\beliminated\b/i,
  /\beradicated\b/i,
  /\bexterminated\b/i,
  /\bguarantee[ds]?\b/i,
  /\bno infestation\b/i,
  /\bpest[- ]free\b/i,
  /\b(?:is|are|was|were|now|all|looks?|stays?|remains?)\s+clear\b/i,
  /\bclear of (?:pests?|insects?|roach(?:es)?|ants?|termites?|bed ?bugs?|rodents?|mice|rats?|wildlife|fleas?|mosquito(?:es)?|activity|infestations?|evidence|signs)\b/i,
  /\bcleared\b/i,
  /\bresolved\b/i,
  /\bgone\b/i,
  // Owner rule: never claim a home is or will be made "-proof" against
  // anything — exclusion copy says "reduce access".
  /\b(?:rodent|wildlife|pest|bug|mosquito|critter|animal)[\s-]?proof/i,
  // Owner rule (bait stations): absence claims are scoped to the accessible
  // stations inspected today — a property-wide "no termites" claim is never
  // supportable from a station check.
  /\bno termites? (?:on|at) (?:the |this |your )?(?:property|home|house)\b/i,
];

function findBannedCustomerCopy(text) {
  const str = String(text || '');
  return BANNED_CUSTOMER_COPY
    .map((rx) => str.match(rx)?.[0] || null)
    .filter(Boolean);
}

module.exports = {
  SCHEMA_VERSION,
  BANNED_CUSTOMER_COPY,
  findBannedCustomerCopy,
  COPY_MAP_VERSION,
  SUMMARY_TEMPLATE_VERSION,
  ACTIVITY_INDICATORS,
  REQUIRED_FINDINGS_FIELDS,
  NEXT_STEP_CHIPS,
  TYPE_NEXT_STEP_CHIPS,
  chipsForType,
  SCORE_LEVEL_WORDS,
  TECH_SCORE_LABELS,
  getActivityIndicator,
  isTypedFindingsType,
  scoreLevelWord,
  deriveActivityScore,
  customerLabelForField,
  customerLabelForValue,
  validateTypedFindings,
  validateNextStepChips,
  nextStepRequiredForType,
  trendWordForScores,
  trendDirection,
  buildTodaysResult,
  buildTypedReportSnapshot,
  findingsSchemaForType,
};
