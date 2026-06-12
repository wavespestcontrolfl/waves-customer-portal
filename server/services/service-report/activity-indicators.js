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

// activity_signs chips that assert live/current termite evidence — shared by
// the zero-state headline guard and cross-field validation so the two can
// never drift apart. 'Previous feeding evidence' and conducive-condition
// chips are deliberately absent: they don't contradict "None observed".
const TERMITE_LIVE_ACTIVITY_SIGNS = ['Live termites in station', 'Mud tubing in station', 'Bait feeding'];

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
  // Inspections set the program's baseline score (tech-set, like the rest
  // of the rodent family). Sanitation deliberately has NO indicator —
  // contamination is a cleanup measure, and pushing it onto rodent_activity
  // would corrupt the program trend.
  rodent_inspection: {
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
    // Owner spec §5 vocabulary (Suspected sits between cleared and Light —
    // evidence suggests fleas but none were confirmed today).
    derive: {
      field: 'evidence_level',
      scores: {
        'None observed': 0,
        Suspected: 1,
        Light: 2,
        Moderate: 3,
        Heavy: 4,
      },
    },
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
  // Knockdown programs share the cockroach indicator so the 10–14 day
  // follow-up visit trends against the initial knockdown. 'Light' scores 1
  // to line up with the generic cockroach type's 'Low' on the shared scale.
  german_roach_knockdown: {
    indicatorKey: 'roach_activity',
    label: 'Roach Activity',
    pestNoun: 'Roach',
    derive: {
      field: 'activity_level',
      scores: {
        'None observed': 0,
        Light: 1,
        Moderate: 3,
        Heavy: 4,
        Severe: 5,
      },
    },
  },
  palmetto_roach_knockdown: {
    indicatorKey: 'roach_activity',
    label: 'Roach Activity',
    pestNoun: 'Roach',
    derive: {
      field: 'activity_level',
      scores: {
        'None observed': 0,
        Light: 1,
        Moderate: 3,
        Heavy: 4,
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
  plant_groups: 'What we serviced',
  landscape_condition: 'Overall landscape condition',
  observed_conditions: 'What we observed',
  treatments_completed: 'What we applied',
  palm_nutrient_stress: 'Palm nutrient health',
  spear_leaf_condition: 'Spear leaf condition',
  canopy_density: 'Canopy density',
  palm_trunk_concern: 'Palm trunk check',
  ganoderma_conk_observed: 'Ganoderma check',
  injection_recommended: 'Palm injection',
  pest_pressure: 'Pest pressure',
  deficiency_symptoms: 'Nutrient deficiency signs',
  new_growth_present: 'New growth',
  pruning_issue_observed: 'Pruning check',
  irrigation_issue_observed: 'Irrigation check',
  bed_weed_pressure: 'Bed weed pressure',
  pre_emergent_applied: 'Pre-emergent bed treatment',
  mulch_depth_concern: 'Mulch check',
  weed_breakthrough_areas: 'Weed breakthrough areas',
  exclusion_areas: 'Areas we worked',
  entry_points_addressed: 'Entry points addressed',
  exclusion_work_completed: 'Repairs completed',
  exclusion_materials: 'Materials used',
  remaining_concerns: 'Remaining concerns',
  exclusion_followup_needed: 'Exclusion follow-up',
  sanitation_areas: 'Areas we serviced',
  contamination_level: 'Contamination level',
  evidence_cleaned: 'What we removed & treated',
  sanitation_work_completed: 'Work completed today',
  sanitation_limitations: 'Service limitations',
  additional_cleanup_needed: 'Additional cleanup',
  interior_concern: 'Interior concern',
  exterior_pressure: 'Exterior pressure',
  photos_taken: 'Photos taken',
  recommended_service: 'Recommended service',
  urgency: 'Urgency',
  activity_areas: 'Where activity was noted',
  contributing_conditions: 'Contributing conditions',
  primary_harborage: 'Where activity was concentrated',
  live_roaches_observed: 'Live roaches',
  droppings_egg_cases: 'Droppings / egg cases',
  sanitation_issue: 'Sanitation',
  moisture_leak_issue: 'Moisture / leaks',
  monitors_placed: 'Monitoring',
  followup_required: 'Follow-up',
  followup_window: 'Follow-up window',
  roach_type: 'What we found',
  interior_activity: 'Interior activity',
  exterior_harborage: 'Exterior harborage',
  moisture_issue: 'Moisture conditions',
  entry_points_observed: 'Entry points',
  followup_needed: 'Follow-up',
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
    Rat: 'Rats',
    Mouse: 'Mice',
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
    Suspected: 'Activity suspected — not confirmed today',
    Light: 'Light activity',
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
  // Tree & Shrub Yes/No selects read as findings, not raw booleans —
  // "Ganoderma check: Yes" would alarm without explaining, and "No" is the
  // reassurance customers actually want from a palm visit. Absence wording
  // stays observational ("observed today"), per the banned-copy rules.
  palm_nutrient_stress: {
    Yes: 'Nutrient stress signs present — addressed in today’s treatment plan',
    No: 'No nutrient stress signs observed today',
  },
  palm_trunk_concern: {
    Yes: 'A trunk concern was noted — see recommendations',
    No: 'No trunk concerns observed today',
  },
  ganoderma_conk_observed: {
    Yes: 'A possible Ganoderma conk was observed — an arborist evaluation is recommended',
    No: 'No visible Ganoderma conks observed today',
  },
  injection_recommended: {
    Yes: 'A palm injection is recommended',
    No: 'No injection needed at this time',
  },
  new_growth_present: {
    Yes: 'New growth present',
    No: 'No new growth observed yet',
  },
  pruning_issue_observed: {
    Yes: 'A pruning issue was observed — see recommendations',
    No: 'No pruning issues observed today',
  },
  irrigation_issue_observed: {
    Yes: 'An irrigation issue was observed — see recommendations',
    No: 'No irrigation issues observed today',
  },
  pre_emergent_applied: {
    Yes: 'Pre-emergent was applied to the beds today',
    No: 'No pre-emergent applied this visit',
  },
  mulch_depth_concern: {
    Yes: 'Mulch depth needs attention — see recommendations',
    No: 'Mulch depth looks good',
  },
  // Rodent family Yes/No selects render as findings sentences, never raw
  // booleans. Absence wording stays observational; "office review" stays
  // internal — the customer hears "we will follow up on next steps".
  contamination_level: {
    Light: 'Light contamination',
    Moderate: 'Moderate contamination',
    Heavy: 'Heavy contamination',
    'Severe — office review needed': 'Severe contamination — we will follow up with next steps',
  },
  activity_found: {
    Yes: 'Rodent activity was found during the inspection',
    No: 'No current rodent activity was observed',
  },
  interior_concern: {
    Yes: 'Interior activity is a concern',
    No: 'No interior concern at this time',
  },
  exterior_pressure: {
    Yes: 'Exterior rodent pressure is present',
    No: 'No notable exterior pressure observed today',
  },
  photos_taken: {
    Yes: 'Photos were taken during the inspection',
    No: 'No photos taken this visit',
  },
  exclusion_followup_needed: {
    Yes: 'A return visit for additional exclusion work is needed',
    No: 'No additional exclusion work is needed right now',
  },
  additional_cleanup_needed: {
    Yes: 'An additional cleanup visit is recommended',
    No: 'No additional cleanup needed',
  },
  // Knockdown Yes/No selects read as findings sentences, not raw booleans.
  // Absence wording stays observational ("observed today") per the
  // banned-copy rules — never absolute claims.
  live_roaches_observed: {
    Yes: 'Live roaches were observed today',
    No: 'No live roaches observed today',
  },
  droppings_egg_cases: {
    Yes: 'Droppings or egg cases were present',
    No: 'No droppings or egg cases observed today',
  },
  sanitation_issue: {
    Yes: 'Sanitation improvements will help — see the guidance below',
    No: 'No sanitation concerns noted today',
  },
  moisture_leak_issue: {
    Yes: 'A moisture or leak issue was noted — correcting it will help',
    No: 'No moisture issues noted today',
  },
  monitors_placed: {
    Yes: 'Monitoring stations are in place',
    No: 'No monitors placed this visit',
  },
  followup_required: {
    Yes: 'A follow-up visit is required',
    No: 'No follow-up visit required',
  },
  interior_activity: {
    Yes: 'Activity was present indoors',
    No: 'No interior activity observed today',
  },
  exterior_harborage: {
    Yes: 'Exterior harborage areas were identified',
    No: 'No exterior harborage identified today',
  },
  moisture_issue: {
    Yes: 'Moisture conditions are contributing to activity',
    No: 'No moisture issues noted today',
  },
  entry_points_observed: {
    Yes: 'Possible entry points were observed',
    No: 'No obvious entry points observed today',
  },
  followup_needed: {
    Yes: 'A follow-up visit is recommended',
    No: 'No follow-up needed',
  },
  roach_type: {
    Palmetto: 'Palmetto bugs (large outdoor roaches)',
    American: 'American cockroaches (palmetto bugs)',
    'Smoky brown': 'Smoky brown cockroaches',
    'Unknown large roach': 'Large roach species not yet confirmed',
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
  // Owner spec §5: flea cooperation must be unmistakable — the aftercare
  // chips are part of the required core. activity_areas is conditionally
  // required in validateTypedFindings (any evidence level except 'None
  // observed') — a truthful cleared visit has no activity area to name.
  flea: ['evidence_level', 'treatment_completed', 'customer_prep'],
  rodent_trapping: ['species'],
  // Owner spec §1/§2/§4 mark the full checklists required — all fast taps.
  // Exceeds the ≤4 budget by owner instruction. Inspection adds conditional
  // requirements (evidence + suspected type when activity was found) in
  // validateTypedFindings.
  rodent_exclusion: [
    'exclusion_areas', 'entry_points_addressed', 'exclusion_work_completed',
    'exclusion_materials', 'remaining_concerns',
  ],
  rodent_sanitation: [
    'sanitation_areas', 'contamination_level', 'evidence_cleaned',
    'sanitation_work_completed', 'sanitation_limitations',
  ],
  rodent_inspection: [
    'areas_inspected', 'activity_found', 'interior_concern', 'exterior_pressure',
    'recommended_service', 'urgency',
  ],
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
  // Owner spec §6 lists six enforcement fields — five live here (incl. the
  // recommendation chips), the sixth is the required next-step selection
  // (REQUIRED_NEXT_STEP_TYPES). Exceeds the ≤4 budget by owner instruction
  // ("same enforcement, inside the new checklist model").
  tree_shrub: ['plant_groups', 'landscape_condition', 'observed_conditions', 'treatments_completed', 'customer_recommendations'],
  // Owner spec §8 marks the full knockdown checklists required — all fast
  // taps (Y/N selects + chips). Exceeds the ≤4 budget by owner instruction;
  // followup_window (followup_required = Yes) and palmetto activity_locations
  // (activity_level ≠ 'None observed') are conditionally required in
  // validateTypedFindings instead.
  german_roach_knockdown: [
    'activity_level', 'rooms_treated', 'primary_harborage', 'live_roaches_observed',
    'droppings_egg_cases', 'sanitation_issue', 'moisture_leak_issue', 'prep_status',
    'treatment_completed', 'monitors_placed', 'followup_required',
  ],
  palmetto_roach_knockdown: [
    'roach_type', 'activity_level', 'interior_activity',
    'exterior_harborage', 'moisture_issue', 'entry_points_observed',
    'treatment_completed', 'customer_recommendations', 'followup_needed',
  ],
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
  'Continue Tree & Shrub program': 'We will continue your Tree & Shrub care program.',
  'Monitor plant response': 'We will monitor plant response over the next visits.',
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
  'Return for additional exclusion': 'We will return to complete additional exclusion work.',
  'Customer repair needed': 'A repair by your contractor is needed to fully close the noted access point.',
  'No follow-up needed': 'No follow-up visit is needed right now.',
  'Complete exclusion': 'Completing the exclusion repairs is the key next step.',
  'Replace contaminated insulation': 'Replacing the contaminated insulation is recommended.',
  'Reduce clutter': 'Reducing clutter in the noted areas will help.',
  'Store food / pet food sealed': 'Store food and pet food in sealed containers.',
  'Monitor odor': 'Monitor the noted odor and let us know if it persists.',
  'Additional sanitation recommended': 'An additional sanitation visit is recommended.',
};

const MAX_NEXT_STEP_CHIPS = 4;

// Types whose completion must select at least one next-step chip (owner
// spec: every report ends with a clear next action). Enforced in the typed
// /complete path; served to clients in the schema slice so the panel can
// mark the section required.
const REQUIRED_NEXT_STEP_TYPES = new Set([
  'rodent_trapping', 'mosquito_event', 'palm_injection', 'one_time_lawn_treatment',
  'pest_inspection', 'cockroach', 'wildlife_trapping', 'bed_bug',
  'termite_bait_station', 'rodent_bait_station', 'tree_shrub',
  'rodent_exclusion', 'rodent_sanitation', 'rodent_inspection', 'flea',
  'german_roach_knockdown', 'palmetto_roach_knockdown',
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
  // Owner spec §1 follow-up list — exclusion reports end with the repair
  // story's next action, not generic trapping steps.
  rodent_exclusion: [
    'Continue trapping', 'Monitor for new activity', 'Return for additional exclusion',
    'Sanitation recommended', 'Customer repair needed', 'No follow-up needed',
  ],
  // Owner spec §2 recommendation list.
  rodent_sanitation: [
    'Continue trapping', 'Complete exclusion', 'Replace contaminated insulation',
    'Reduce clutter', 'Store food / pet food sealed', 'Monitor odor',
    'Additional sanitation recommended', 'No follow-up needed',
  ],
  // Owner spec §4 — diagnostic and sales-supportive.
  rodent_inspection: [
    'Treatment recommended', 'Estimate to follow', 'Follow-up recommended',
    'Monitor activity', 'Exclusion recommended', 'Sanitation recommended', 'No action needed',
  ],
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
  // Owner template §6: "continue program / monitor / injection recommended /
  // follow-up needed".
  tree_shrub: [
    'Continue Tree & Shrub program', 'Monitor plant response', 'Recheck next visit',
    'Injection recommended', 'Arborist review recommended', 'Follow-up recommended',
    'Customer action needed', 'No action needed',
  ],
  german_roach_knockdown: [
    'Follow-up in 10–14 days', 'No store-bought sprays', 'Keep treated areas undisturbed',
    'Sanitation recommended', 'Reduce moisture', 'Monitor activity', 'Follow-up recommended',
  ],
  palmetto_roach_knockdown: [
    'Monitor activity', 'Seal entry gaps', 'Reduce moisture', 'Sanitation recommended',
    'Exclusion recommended', 'Follow-up recommended', 'No action needed',
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

  // Cross-field consistency (termite stations): the gauge derives from
  // termite_activity ALONE, so "None observed" alongside positive evidence
  // would persist a zero score into the shared termite trend while the
  // findings list right below shows feeding (Codex P2). Reject the
  // contradiction at entry — the tech resolves it on the form. The
  // evidence-aware zero-state headline in buildTodaysResult stays as
  // defense-in-depth for drafts and previously stored values.
  if (type === 'termite_bait_station') {
    const liveSigns = String(values.activity_signs || '')
      .split(',').map((s) => s.trim())
      .filter((s) => TERMITE_LIVE_ACTIVITY_SIGNS.includes(s));
    const activeStations = Number(values.stations_with_activity);
    const consumption = String(values.bait_consumption || '');
    const evidence = [];
    if (liveSigns.length) evidence.push(liveSigns.join(', '));
    if (Number.isInteger(activeStations) && activeStations > 0) evidence.push('stations with termite activity');
    if (String(values.active_station_location || '').trim()) evidence.push('an active station location');
    if (consumption !== '' && consumption !== 'None — bait intact') evidence.push(`bait consumption "${consumption}"`);
    if (String(values.termite_activity || '') === 'None observed' && evidence.length) {
      errors.push(`Termite activity "None observed" contradicts the recorded evidence (${evidence.join('; ')}) — update the activity selection or remove the evidence`);
    }
    // Live termites are by definition active — "Previous feeding noted"
    // (score 1) would understate them on the trend the same way.
    if (liveSigns.includes('Live termites in station')
      && values.termite_activity
      && String(values.termite_activity) !== 'Active termites present') {
      errors.push('"Live termites in station" requires termite activity "Active termites present"');
    }
  }

  // Cross-field consistency (Tree & Shrub): the report tells one coherent
  // plant-health story — a "no major issues" claim can't sit beside recorded
  // issues, "Inspection only" can't sit beside applied treatments, and the
  // palm module core is required whenever palms were among the serviced
  // groups (owner spec §6: "use when palms are present").
  if (type === 'tree_shrub') {
    const observed = String(values.observed_conditions || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const issueChips = observed.filter((c) => c !== 'No major issues observed' && c !== 'Healthy / new growth');
    const heavyPressure = ['pest_pressure', 'disease_pressure', 'deficiency_symptoms', 'bed_weed_pressure']
      .some((key) => ['Moderate', 'Heavy'].includes(String(values[key] || '')));
    // EVERY issue-flavored Yes toggle contradicts the no-issues claim, not
    // just the two palm flags (Codex P2 round 2) — "no major issues" next
    // to "A pruning issue was observed" is incoherent.
    const issueToggles = [
      'ganoderma_conk_observed', 'palm_trunk_concern', 'palm_nutrient_stress',
      'pruning_issue_observed', 'irrigation_issue_observed', 'mulch_depth_concern',
    ].some((key) => String(values[key] || '') === 'Yes');
    if (observed.includes('No major issues observed') && (issueChips.length || heavyPressure || issueToggles)) {
      errors.push('"No major issues observed" contradicts the recorded issues — remove it or the conflicting findings');
    }
    const treatments = String(values.treatments_completed || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (treatments.includes('Inspection only') && treatments.length > 1) {
      errors.push('"Inspection only" cannot be combined with applied treatments');
    }
    // pre_emergent_applied is an APPLICATION field — it can't ride an
    // inspection-only visit either (Codex P2 round 2).
    if (treatments.includes('Inspection only') && String(values.pre_emergent_applied) === 'Yes') {
      errors.push('"Inspection only" contradicts "Pre-emergent applied" — record the treatment or clear the bed module field');
    }
    const groups = String(values.plant_groups || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    // Palm-module findings without Palms in the service scope would put
    // palm claims on a report whose scope contradicts them (Codex P2) —
    // the tech either serviced palms (add the group) or didn't (clear the
    // fields).
    const palmModuleFilled = [
      'palms_serviced', 'palm_condition', 'palm_nutrient_stress', 'spear_leaf_condition',
      'canopy_density', 'palm_trunk_concern', 'ganoderma_conk_observed', 'injection_recommended',
    ].filter((key) => values[key] != null && String(values[key]).trim() !== '');
    if (palmModuleFilled.length && groups.length && !groups.includes('Palms')) {
      errors.push('Palm module findings were recorded but Palms is not among the serviced plant groups — add Palms or clear the palm fields');
    }
    if (enforceRequired && groups.includes('Palms')) {
      for (const key of ['palm_condition', 'ganoderma_conk_observed']) {
        const value = values[key];
        if (value == null || String(value).trim() === '') missing.push(key);
      }
    }
  }

  // Cross-field consistency (rodent family, owner spec §§1–4): "none" chips
  // can't ride with the findings they negate, and an inspection that found
  // activity must say what the evidence was and what's suspected.
  if (type === 'rodent_exclusion' || type === 'rodent_trapping') {
    const concerns = String(values.remaining_concerns || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (concerns.includes('No remaining concerns observed') && concerns.length > 1) {
      errors.push('"No remaining concerns observed" cannot be combined with other remaining concerns');
    }
  }
  if (type === 'rodent_sanitation' || type === 'rodent_trapping') {
    const limitations = String(values.sanitation_limitations || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (limitations.includes('No limitations') && limitations.length > 1) {
      errors.push('"No limitations" cannot be combined with other limitations');
    }
  }
  if (type === 'rodent_inspection' && enforceRequired && String(values.activity_found) === 'Yes') {
    // Evidence with activity_found "No" stays legal — old droppings with no
    // current activity is a real outcome; only the positive case requires
    // the supporting detail.
    for (const key of ['evidence_observed', 'species']) {
      const value = values[key];
      if (value == null || String(value).trim() === '') missing.push(key);
    }
  }
  // German knockdown: the follow-up window is only meaningful (and only
  // required) once a follow-up is actually required — owner spec §8B,
  // "10–14 days preferred".
  if (type === 'german_roach_knockdown' && enforceRequired
    && String(values.followup_required) === 'Yes'
    && (values.followup_window == null || String(values.followup_window).trim() === '')) {
    missing.push('followup_window');
  }
  // "Inspection only" treatment can't ride with applied treatments (owner
  // spec §5 — the report tells one coherent story), and activity areas are
  // required exactly when there was activity to locate: a 'None observed'
  // visit has no truthful area to name, so recorded areas beside it are a
  // contradiction, not optional detail — the snapshot would render "Where
  // activity was noted" under a no-active-signs headline (Codex P2 ×2).
  if (type === 'flea') {
    const treatments = String(values.treatment_completed || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (treatments.includes('Inspection only') && treatments.length > 1) {
      errors.push('"Inspection only" cannot be combined with applied treatments');
    }
    const evidence = String(values.evidence_level || '');
    const areas = String(values.activity_areas ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (evidence === 'None observed' && areas.length) {
      errors.push('Activity areas cannot be recorded with evidence level "None observed" — update the evidence level or clear the areas');
    }
    if (enforceRequired && evidence && evidence !== 'None observed' && !areas.length) {
      missing.push('activity_areas');
    }
  }

  // Knockdown zero states must not contradict the recorded evidence — the
  // gauge derives 0 from 'None observed' alone, so live evidence beside it
  // would persist a zero score under findings that say otherwise (same
  // guard as termite stations; Codex P2 round 3).
  if (type === 'german_roach_knockdown' && String(values.activity_level) === 'None observed') {
    const evidence = [];
    if (String(values.live_roaches_observed) === 'Yes') evidence.push('live roaches observed');
    if (String(values.droppings_egg_cases) === 'Yes') evidence.push('droppings / egg cases observed');
    if (evidence.length) {
      errors.push(`Activity level "None observed" contradicts the recorded evidence (${evidence.join('; ')}) — update the activity level or the evidence fields`);
    }
  }
  if (type === 'palmetto_roach_knockdown' && String(values.activity_level) === 'None observed'
    && String(values.interior_activity) === 'Yes') {
    errors.push('Activity level "None observed" contradicts "Interior activity: Yes" — update the activity level or the interior activity field');
  }
  // Cleared palmetto visits have no truthful activity location to name —
  // the field is required exactly when there was activity to locate, and
  // recorded locations beside "None observed" would render a zero-score
  // report that still says where activity was noted (Codex P2 round 5).
  if (type === 'palmetto_roach_knockdown') {
    const locations = String(values.activity_locations ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (String(values.activity_level) === 'None observed' && locations.length) {
      errors.push('Activity locations cannot be recorded with activity level "None observed" — update the activity level or clear the locations');
    }
    if (enforceRequired && String(values.activity_level || '').trim()
      && String(values.activity_level) !== 'None observed' && !locations.length) {
      missing.push('activity_locations');
    }
  }

  if (enforceRequired) {
    // chips store a comma-joined selection — a value like "," has no real
    // selections but a plain trim check would accept it (Codex P2). A
    // required chips field needs at least one non-empty part.
    const fieldTypeByKey = new Map(fields.map((f) => [f.key, f.type]));
    for (const key of REQUIRED_FINDINGS_FIELDS[type] || []) {
      const value = values[key];
      const isEmpty = fieldTypeByKey.get(key) === 'chips'
        ? String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean).length === 0
        : (value == null || String(value).trim() === '');
      if (isEmpty) missing.push(key);
    }
  }

  return { ok: errors.length === 0 && missing.length === 0, errors, missing };
}

function validateNextStepChips(chips, projectType = null, values = null) {
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
  // "No action needed" beside confirmed/suspected flea activity contradicts
  // the report's mandatory aftercare story — the chip sentence ("No further
  // action is needed right now.") would land verbatim next to body copy
  // saying home-care steps make the biggest difference (Codex P2). The chip
  // stays available for truthful 'None observed' cleared visits.
  if (values && projectType === 'flea'
    && normalized.includes('No action needed')
    && String(values.evidence_level || '').trim()
    && String(values.evidence_level) !== 'None observed') {
    return { ok: false, error: `Next-step chip "No action needed" contradicts the recorded flea evidence level (${String(values.evidence_level)}) — remove the chip or update the evidence level` };
  }
  // Knockdown follow-up chips must agree with the structured follow-up
  // answer — the chip text lands verbatim in Today's Result, so a chip
  // recommending a follow-up beside findings that say "No" (or a chip
  // naming a window the tech didn't select) contradicts the report body
  // and the suppressed/redated CTA (Codex P2 round 5).
  if (values && projectType === 'german_roach_knockdown') {
    const followupRequired = String(values.followup_required || '');
    const window = String(values.followup_window || '');
    for (const chip of normalized) {
      const recommendsFollowup = chip === 'Follow-up recommended' || chip === 'Follow-up in 10–14 days';
      if (followupRequired === 'No' && recommendsFollowup) {
        return { ok: false, error: `Next-step chip "${chip}" contradicts "Follow-up required: No" — update the follow-up answer or remove the chip` };
      }
      if (chip === 'Follow-up in 10–14 days' && window && window !== '10–14 days') {
        return { ok: false, error: `Next-step chip "Follow-up in 10–14 days" contradicts the selected follow-up window (${window}) — match the window or use "Follow-up recommended"` };
      }
    }
  }
  if (values && projectType === 'palmetto_roach_knockdown'
    && String(values.followup_needed || '') === 'No'
    && normalized.includes('Follow-up recommended')) {
    return { ok: false, error: 'Next-step chip "Follow-up recommended" contradicts "Follow-up needed: No" — update the follow-up answer or remove the chip' };
  }
  return { ok: true, chips: normalized };
}

// Final-score vs findings consistency at the CLEARED boundary (Codex P2).
// Within the active range a technician override is legal and the headline
// follows the final score; crossing the 0 boundary is different — a pinned
// nonzero score beside cleared evidence (or a pinned 0 beside positive
// evidence) makes the headline say the opposite of the findings card, and
// the areas/chip checks key off the select. Per-type map so other gauge
// types can add their cleared-select boundary.
const SCORE_CLEARED_SELECT = {
  flea: { field: 'evidence_level', cleared: 'None observed' },
  german_roach_knockdown: { field: 'activity_level', cleared: 'None observed' },
  palmetto_roach_knockdown: { field: 'activity_level', cleared: 'None observed' },
};

function validateActivityScoreConsistency(type, values = {}, score = null) {
  if (score == null) return { ok: true };
  const rule = SCORE_CLEARED_SELECT[type];
  if (!rule) return { ok: true };
  const selected = String(values?.[rule.field] ?? '').trim();
  if (!selected) return { ok: true };
  if (selected === rule.cleared && score > 0) {
    return { ok: false, error: `Activity score ${score} contradicts "${rule.cleared}" — set the score to 0 or update the recorded level` };
  }
  if (selected !== rule.cleared && score === 0) {
    return { ok: false, error: `Activity score 0 contradicts the recorded level (${selected}) — select "${rule.cleared}" or use a nonzero score` };
  }
  return { ok: true };
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

// Combo-key module sentences (owner spec §3): when a rodent_trapping_*
// combo visit recorded exclusion or sanitation module work, the narrative
// covers it after the trap sentence. Returns '' when no module was filled
// (pure trap checks, wildlife — the module keys don't exist on wildlife).
function rodentComboModuleSentences(values = {}) {
  const parts = [];
  const points = String(values.entry_points_addressed || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((p) => (p === 'Other' ? null : p.toLowerCase())).filter(Boolean);
  if (points.length) {
    const materials = String(values.exclusion_materials || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((m) => (m === 'Other' ? null : m.toLowerCase())).filter(Boolean);
    parts.push(`We also completed exclusion work at the ${joinPhrases(points)}${materials.length ? ` using ${joinPhrases(materials)}` : ''}.`);
  }
  const cleanedAreas = String(values.sanitation_areas || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((a) => (a === 'Other' ? null : a.toLowerCase())).filter(Boolean);
  if (cleanedAreas.length) {
    const level = String(values.contamination_level || '').split('—')[0].trim().toLowerCase();
    parts.push(`We also completed ${level ? `${level} ` : ''}sanitation cleanup in the ${joinPhrases(cleanedAreas)}.`);
  }
  return parts.join(' ');
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
  tree_shrub: {
    field: 'treatments_completed',
    phrases: {
      Fertilizer: 'applied ornamental fertilizer',
      'Palm fertilizer': 'applied palm fertilizer',
      Micronutrients: 'applied micronutrients',
      'Insect treatment': 'treated affected plants for insect activity',
      'Disease / fungicide treatment': 'applied a disease treatment',
      'Horticultural oil': 'applied horticultural oil',
      'Soil drench': 'completed a soil drench application',
      'Foliar treatment': 'completed a foliar treatment',
      'Pre-emergent bed treatment': 'applied pre-emergent to the beds',
      'Weed spot treatment': 'spot-treated bed weeds',
      'Soil amendment / acidifier': 'applied a soil amendment',
      'Inspection only': 'completed a full landscape inspection',
    },
  },
  rodent_exclusion: {
    field: 'exclusion_work_completed',
    phrases: {
      'Sealed entry point': 'sealed the noted entry points',
      'Installed hardware cloth / mesh': 'installed rodent-resistant mesh',
      'Installed sealant / foam / backer': 'installed sealant with mesh backing',
      'Repaired screen / vent': 'repaired the damaged screen and vent areas',
      'Installed door sweep / seal': 'installed door sweeps and seals',
      'Reinforced opening': 'reinforced the vulnerable opening',
      'Temporary seal': 'placed a temporary seal',
      'Permanent exclusion repair': 'completed permanent exclusion repairs',
      'Inspection only': 'completed an exclusion inspection',
    },
  },
  rodent_sanitation: {
    field: 'sanitation_work_completed',
    phrases: {
      'Removed droppings': 'removed droppings',
      'Removed nesting material': 'removed nesting material',
      'Removed dead rodent': 'removed the rodent remains',
      'HEPA vacuum / controlled cleanup': 'completed a HEPA-controlled cleanup',
      'Disinfected / sanitized affected areas': 'disinfected and sanitized the affected areas',
      'Deodorized affected areas': 'deodorized the service areas',
      'Bagged / disposed contaminated debris': 'bagged and disposed of contaminated debris',
      'Insulation removal recommended': 'flagged contaminated insulation for removal',
      'Limited cleanup due to access': 'completed a limited cleanup where access allowed',
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
  flea: {
    field: 'treatment_completed',
    phrases: {
      'Exterior flea treatment': 'completed a targeted exterior flea treatment',
      'Interior flea treatment': 'treated the interior flea activity areas',
      'Growth regulator': 'applied an insect growth regulator',
      'Crack / crevice treatment': 'treated cracks and crevices',
      'Lawn treatment': 'treated the lawn',
      'Pet resting area treatment': 'treated the pet resting areas',
      'Inspection only': 'completed a flea inspection',
      'Limited treatment': 'completed a limited treatment where access allowed',
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
  german_roach_knockdown: {
    field: 'treatment_completed',
    phrases: {
      'Gel bait': 'placed targeted gel bait',
      'Insect growth regulator': 'applied an insect growth regulator',
      'Crack & crevice treatment': 'treated cracks and crevices',
      'Dust application': 'applied dust to voids',
      'Vacuum / flush-out': 'completed a vacuum and flush-out',
      'Monitors / glue boards': 'placed monitors',
      'Appliance-area treatment': 'treated the appliance areas',
      'Cabinet hinge treatment': 'treated the cabinet hinge areas',
      'Plumbing penetration treatment': 'treated the plumbing penetrations',
    },
  },
  palmetto_roach_knockdown: {
    field: 'treatment_completed',
    phrases: {
      'Interior crack & crevice': 'treated interior cracks and crevices',
      'Exterior perimeter treatment': 'treated exterior perimeter harborage areas',
      'Garage treatment': 'treated the garage edges',
      'Attic / void treatment': 'treated attic and void areas',
      'Drain / moisture area treatment': 'treated drain and moisture areas',
      'Bait placement': 'placed targeted bait',
      'Dust application': 'applied dust to voids',
      'Glue boards placed': 'placed glue boards',
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
  // Combo trapping visits (owner spec §3) append the exclusion/sanitation
  // module work to the trap sentence so the narrative covers the whole stop.
  const trapSentence = isTrappingType
    && [trapActivitySentence(values), rodentComboModuleSentences(values)].filter(Boolean).join(' ');
  const whatWeDid = trapSentence
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
  // The zero score derives from consumption / the activity select ALONE, so
  // a "nothing observed" headline must also be consistent with the evidence
  // chips — otherwise the headline contradicts the findings list right
  // below it (hook P1). When evidence exists, the headline says so.
  if (isBaitStationType && activity && activity.score === 0
    && !(visitSequence > 1 && activity.trendWord)) {
    if (projectType === 'termite_bait_station') {
      // EVERY positive field contradicts the zero claim, not just the live
      // signs (hook P1 round 2): stations-with-activity count, an active
      // station location, or any feeding-level consumption.
      const liveSigns = String(values.activity_signs || '')
        .split(',').map((s) => s.trim())
        .some((s) => TERMITE_LIVE_ACTIVITY_SIGNS.includes(s));
      const activeStations = Number(values.stations_with_activity);
      const consumption = String(values.bait_consumption || '');
      const contradictsZero = liveSigns
        || (Number.isInteger(activeStations) && activeStations > 0)
        || String(values.active_station_location || '').trim().length > 0
        || (consumption !== '' && consumption !== 'None — bait intact');
      return {
        headline: contradictsZero
          ? 'Termite activity signs were observed in the bait stations today — see the details below.'
          : 'No termite activity was observed in the accessible bait stations today.',
        body: `${whatWeDid} ${nextStep}`,
        nextStep,
      };
    }
    // Rodent: evidence chips or a named highest-activity location both
    // contradict a "no evidence" claim.
    const rodentEvidence = String(values.evidence_observed || '').trim().length > 0
      || String(values.highest_activity_location || '').trim().length > 0;
    return {
      headline: rodentEvidence
        ? 'No bait consumption was observed today, but rodent evidence was noted nearby.'
        : 'No bait consumption or visible rodent evidence was observed today.',
      body: `${whatWeDid} ${nextStep}`,
      nextStep,
    };
  }

  // Tree & Shrub has no pest gauge — the owner template (§6) leads with the
  // overall landscape condition and tells the plant-health story: scope,
  // treatments, palm notes (Ganoderma reassurance/flag), next step.
  if (projectType === 'tree_shrub' && values.landscape_condition) {
    const condition = String(values.landscape_condition);
    const conditionHeadlines = {
      Excellent: 'Overall landscape condition is excellent.',
      Good: 'Overall landscape condition is good.',
      Fair: 'Overall landscape condition is fair.',
      Poor: 'Overall landscape condition is poor — see the recommendations below.',
      Declining: 'Overall landscape condition is declining — see the recommendations below.',
      Recovering: 'Overall landscape condition is recovering.',
    };
    const headline = conditionHeadlines[condition];
    if (headline) {
      const groups = String(values.plant_groups || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
        .filter((g) => g !== 'Other')
        .map((g) => g.toLowerCase());
      const scopeSentence = groups.length
        ? `Completed Tree & Shrub service for the ${joinPhrases(groups)}.`
        : 'Completed your Tree & Shrub service today.';
      // Ganoderma is the question palm owners actually have — say the answer
      // plainly, but ONLY when palms were actually serviced (Codex P2: a
      // shrub/bed-only visit with stray palm-module values must not claim
      // palm findings the visit scope contradicts). The "No" sentence
      // couples trunk decay only when the trunk check also came back clean.
      let palmNote = '';
      if (groups.includes('palms')) {
        if (String(values.ganoderma_conk_observed) === 'Yes') {
          palmNote = ' A possible Ganoderma conk was observed on a palm — an arborist evaluation is recommended.';
        } else if (String(values.ganoderma_conk_observed) === 'No') {
          palmNote = String(values.palm_trunk_concern) === 'No'
            ? ' No visible Ganoderma conks or trunk decay were observed on the palms today.'
            : ' No visible Ganoderma conks were observed on the palms today.';
        }
      }
      return {
        headline,
        body: `${scopeSentence} ${whatWeDid}${palmNote} ${nextStep}`.replace(/\s+/g, ' ').trim(),
        nextStep,
      };
    }
  }

  // Rodent exclusion (owner spec §1) — a repair story: areas, entry points,
  // repairs/materials, remaining concerns. Headline carries the owner's
  // approved phrasing ("reduce rodent access and help prevent re-entry" —
  // never "rodent-proof"). Trend headlines still win on later visits.
  if (projectType === 'rodent_exclusion' && values.exclusion_work_completed
    && !(visitSequence > 1 && activity && activity.trendWord)) {
    const lowerChips = (key) => String(values[key] || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((c) => (c === 'Other' ? null : c.toLowerCase())).filter(Boolean);
    const areas = lowerChips('exclusion_areas');
    const points = lowerChips('entry_points_addressed');
    const materials = lowerChips('exclusion_materials');
    const concerns = String(values.remaining_concerns || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const realConcerns = concerns.filter((c) => c !== 'No remaining concerns observed');
    const sentences = [
      areas.length
        ? `Completed rodent exclusion work today around the ${joinPhrases(areas)}.`
        : 'Completed rodent exclusion work today.',
      points.length ? `Entry points addressed included the ${joinPhrases(points)}.` : null,
      whatWeDid,
      materials.length ? `Materials used included ${joinPhrases(materials)}.` : null,
      realConcerns.length
        ? `Remaining concerns: ${joinPhrases(realConcerns.map((c) => c.toLowerCase()))}.`
        : 'No remaining concerns were observed today.',
      nextStep,
    ].filter(Boolean);
    return {
      headline: 'Exclusion repairs were completed to reduce rodent access and help prevent re-entry.',
      body: sentences.join(' ').replace(/\s+/g, ' ').trim(),
      nextStep,
    };
  }

  // Rodent sanitation (owner spec §2) — a health/safety cleanup story with
  // before/after clarity: areas, contamination level, what was removed,
  // what limited the cleanup.
  if (projectType === 'rodent_sanitation' && values.contamination_level) {
    const lowerChips = (key) => String(values[key] || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((c) => (c === 'Other' ? null : c.toLowerCase())).filter(Boolean);
    const areas = lowerChips('sanitation_areas');
    const evidence = lowerChips('evidence_cleaned');
    const limitations = String(values.sanitation_limitations || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .filter((c) => c !== 'No limitations');
    const level = String(values.contamination_level).split('—')[0].trim().toLowerCase();
    const sentences = [
      areas.length
        ? `Completed rodent sanitation service in the ${joinPhrases(areas)}.`
        : 'Completed your rodent sanitation service today.',
      `Contamination level was ${level}.`,
      evidence.length ? `We removed and treated ${joinPhrases(evidence)}.` : null,
      whatWeDid,
      limitations.length
        ? `Some areas had limitations: ${joinPhrases(limitations.map((c) => c.toLowerCase()))}.`
        : 'No limitations were encountered during the cleanup.',
      String(values.contamination_level).startsWith('Severe')
        ? 'Because of the contamination level, our office will follow up with you on next steps.'
        : null,
      nextStep,
    ].filter(Boolean);
    return {
      headline: `${level.charAt(0).toUpperCase()}${level.slice(1)} rodent contamination was cleaned and sanitized today.`,
      body: sentences.join(' ').replace(/\s+/g, ' ').trim(),
      nextStep,
    };
  }

  // Rodent inspection (owner spec §4) — diagnostic and sales-supportive:
  // what was checked, whether activity was found, the recommended service
  // and its urgency.
  if (projectType === 'rodent_inspection' && values.activity_found
    && !(visitSequence > 1 && activity && activity.trendWord)) {
    const areas = String(values.areas_inspected || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((a) => (a === 'Other' ? null : a.toLowerCase())).filter(Boolean);
    const found = String(values.activity_found) === 'Yes';
    const service = String(values.recommended_service || '');
    const urgency = String(values.urgency || '');
    const sentences = [
      areas.length
        ? `We inspected the ${joinPhrases(areas)}.`
        : 'We completed a rodent inspection of the property today.',
      values.entry_points_found
        ? `Possible entry points were noted: ${String(values.entry_points_found).trim().replace(/\.$/, '')}.`
        : null,
      service && service !== 'No service needed at this time'
        ? `Based on today's findings, we recommend ${service.charAt(0).toLowerCase()}${service.slice(1)}${urgency === 'High' ? ' — scheduling soon is recommended' : ''}.`
        : 'No service is needed at this time based on today’s findings.',
      nextStep,
    ].filter(Boolean);
    return {
      headline: found
        ? 'Rodent activity was found during today’s inspection.'
        : 'No current rodent activity was observed during today’s inspection.',
      body: sentences.join(' ').replace(/\s+/g, ' ').trim(),
      nextStep,
    };
  }

  // Flea reports (owner spec §5) carry the cooperation line in EVERY body —
  // treatment alone underperforms when vacuuming, pets, and yard care are
  // ignored. Trend headlines win on later visits; the level wording follows
  // the FINAL gauge score so a tech-pinned score never diverges.
  if (projectType === 'flea' && values.evidence_level) {
    const score = activity && Number.isInteger(activity.score) ? activity.score : null;
    const select = String(values.evidence_level);
    const cleared = score != null ? score === 0 : select === 'None observed';
    // "Suspected" wording comes from the SELECT only — a tech pinning the
    // gauge to 1 on a confirmed Moderate finding must read as "very low",
    // never as "no live activity was confirmed" (Codex P2). A Suspected
    // selection the tech re-scored away from 1 follows the score word.
    const suspected = !cleared && select === 'Suspected' && (score == null || score === 1);
    let headline;
    if (visitSequence > 1 && activity && activity.trendWord) {
      headline = activity.trend === 'stable'
        ? 'Flea activity is about the same as our last visit.'
        : `Flea activity has ${activity.trend === 'worsening' ? 'increased' : 'decreased'} since our last visit.`;
    } else if (cleared) {
      headline = 'No active signs of flea activity observed today.';
    } else if (suspected) {
      headline = 'Flea activity is suspected — no live activity was confirmed today.';
    } else {
      const levelWord = score != null
        ? String(SCORE_LEVEL_WORDS[score] || '').replace(' activity', '').toLowerCase()
        : select.toLowerCase();
      headline = `Flea activity was ${levelWord} today.`;
    }
    const areas = String(values.activity_areas || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((a) => (a === 'Other' ? null : a.toLowerCase())).filter(Boolean);
    const intro = areas.length
      ? `Completed your flea service with attention to the ${joinPhrases(areas)}.`
      : 'Completed your flea service today.';
    return {
      headline,
      body: `${intro} ${whatWeDid} Flea control works best when treatment and home care happen together — the aftercare steps below make the biggest difference.${nextStep ? ` ${nextStep}` : ''}`.replace(/\s+/g, ' ').trim(),
      nextStep,
    };
  }

  // Knockdown reports (owner spec §8) carry deterministic expectation-setting
  // language in EVERY report body — German cooperation guidance (bait
  // programs fail without it — owner critical warning) and the palmetto
  // flush disclosure survive trend visits and cleared states alike (Codex
  // P2 round 1). Headline precedence: trend > cleared > level, with the
  // level wording driven by the FINAL gauge score so a tech-pinned score
  // can never diverge from the headline.
  const isKnockdownType = projectType === 'german_roach_knockdown' || projectType === 'palmetto_roach_knockdown';
  if (isKnockdownType && values.activity_level) {
    const isGerman = projectType === 'german_roach_knockdown';
    const noun = isGerman ? 'German cockroach' : 'large-roach';
    const score = activity && Number.isInteger(activity.score) ? activity.score : null;
    const levelWord = score != null
      ? String(SCORE_LEVEL_WORDS[score] || '').replace(' activity', '').toLowerCase()
      : String(values.activity_level).toLowerCase();
    const cleared = score != null ? score === 0 : levelWord === 'none observed';
    let headline;
    if (visitSequence > 1 && activity && activity.trendWord) {
      // Mirror the generic trend shapes (stable needs its own sentence).
      headline = activity.trend === 'stable'
        ? 'Roach activity is about the same as our last visit.'
        : `Roach activity has ${activity.trend === 'worsening' ? 'increased' : 'decreased'} since our last visit.`;
    } else if (cleared) {
      headline = `No live ${noun} activity was observed today.`;
    } else {
      headline = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} activity was ${levelWord} today.`;
    }
    const initial = visitSequence > 1 ? '' : 'initial ';
    const rooms = isGerman ? String(values.rooms_treated || '').trim().replace(/\.$/, '') : '';
    const intro = isGerman
      ? (rooms
        ? `Completed your ${initial}German cockroach knockdown service in the ${rooms.charAt(0).toLowerCase()}${rooms.slice(1)}.`
        : `Completed your ${initial}German cockroach knockdown service.`)
      : `Completed your ${initial}large-roach knockdown service.`;
    const disclosure = isGerman
      ? ' Please avoid over-the-counter sprays, clean food debris behind and under appliances, and keep bait placements undisturbed so the bait can do its job.'
      : ' Moisture and exterior entry points can contribute to large-roach activity. Some activity may be seen temporarily as roaches are flushed from hiding areas.';
    const window = String(values.followup_window || '10–14 days');
    const followup = isGerman && String(values.followup_required) === 'Yes'
      ? (window === 'As needed'
        ? ' A follow-up visit is recommended — we will help you get it scheduled.'
        : ` Follow-up service is recommended in ${window}.`)
      : '';
    return {
      headline,
      body: `${intro} ${whatWeDid}${disclosure}${followup} ${nextStep}`.replace(/\s+/g, ' ').trim(),
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
    // internal compliance fields (e.g. pollinator status, IRAC/FRAC) stay in
    // the stored values for audit but never render on the customer report.
    if (field.internal) continue;
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
// Combo-key module sections (owner spec §3): one registry type serves the
// rodent_trapping_* combo keys, and a module section is only SERVED to the
// completion form when the service key actually includes that work — a pure
// trap check never sees the exclusion/sanitation modules. Validation stays
// permissive (module values are always legal registry fields), and callers
// that don't know the service key (AI draft labeling) get the full list.
const TYPE_MODULE_SECTIONS = {
  rodent_trapping: {
    'Exclusion module': /exclusion/,
    'Sanitation module': /sanitation/,
  },
};

function findingsSchemaForType(projectType, { serviceKey = null } = {}) {
  const config = PROJECT_TYPES[projectType];
  if (!config) return null;
  const indicator = ACTIVITY_INDICATORS[projectType] || null;
  const moduleRules = TYPE_MODULE_SECTIONS[projectType] || null;
  return {
    type: projectType,
    label: config.label,
    schemaVersion: SCHEMA_VERSION,
    copyMapVersion: COPY_MAP_VERSION,
    fields: (config.findingsFields || [])
      .filter((f) => {
        const rule = moduleRules && f.section ? moduleRules[f.section] : null;
        if (!rule) return true;
        if (!serviceKey) return true;
        return rule.test(String(serviceKey));
      })
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        section: f.section || null,
        options: f.options || null,
        placeholder: f.placeholder || null,
        required: (REQUIRED_FINDINGS_FIELDS[projectType] || []).includes(f.key),
        // Conditional requirement ({ field, value }): required exactly when
        // the named sibling field holds a non-empty value other than
        // `value`. Served so the client pre-submit gate mirrors the server
        // enforcement instead of discovering it as a post-submit 422
        // (Codex P2).
        requiredUnless: f.requiredUnless || null,
        // internal fields are tech-facing compliance entries — validated and
        // stored, but excluded from the customer-facing snapshot findings.
        internal: !!f.internal,
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
  // supportable from a station check. Catches any same-sentence phrasing of
  // "no … termites … on/at the property" ("No termites were found on the
  // property", "no termite activity at your home"), not just the adjacent
  // shape. The tempered gaps refuse to cross "station(s)" so legitimately
  // scoped copy ("no feeding in the stations on your property") stays legal.
  /\bno\b(?:(?!\bstations?\b)[^.!?]){0,40}?\btermites?\b(?:(?!\bstations?\b)[^.!?]){0,80}?\b(?:on|at|in|around|across|throughout)\s+(?:the\s+|this\s+|your\s+)?(?:property|home|house|premises|structure)\b/i,
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
  validateActivityScoreConsistency,
  nextStepRequiredForType,
  trendWordForScores,
  trendDirection,
  buildTodaysResult,
  buildTypedReportSnapshot,
  findingsSchemaForType,
};
