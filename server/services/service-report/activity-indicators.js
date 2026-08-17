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

const {
  PROJECT_TYPES,
  isValidProjectType,
  TERMITE_LIQUID_DILUTION_METHODS,
  TERMITE_PERIMETER_METHODS,
} = require('../project-types');

// v2: rodent_trapping sectioned checklist fields (chips/count types,
// owner spec 2026-06-12). Snapshots are immutable — v1 snapshots keep
// rendering with their persisted labels.
const SCHEMA_VERSION = 2;
// Copy map v3: rodent trapping's count label is no longer a constant — on a
// declared trap-SETUP visit `traps_checked` persists as "Traps set" (owner
// 2026-08-02). A v2 snapshot can never carry that label, so the version is
// what tells fixtures and audits which generator produced a given row
// (codex P2 on #3159).
const COPY_MAP_VERSION = 3;
// Summary template v5: every gauge lane accepts the tech-reviewed AI report
// copy as the body (bodySource 'technician_report'), not just rodent
// trapping — cockroach, bed bug, the termite family, bait stations, and
// wildlife trapping included (owner 2026-08-11: the cockroach report
// "didn't render" the generated copy). The knockdown and one-time mosquito
// story branches swap their body the same way, keeping their mandated
// disclosure/follow-up sentences. Zero states, rodent exclusion/inspection,
// flea, and tree & shrub still keep template copy.
// v4 added rodent trapping + setup-visit wording; v3 added the generic
// non-gauge default composition.
// v6 (#3420): story lanes consume reviewed technician bodies, mandated
// lines append, and the contradiction rules choose between AI and
// deterministic copy — snapshots frozen by this generator must be
// distinguishable from v5's (codex r79).
const SUMMARY_TEMPLATE_VERSION = 6;

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
  // rooms_treated / entry_points_observed are defined once, later in this
  // map — earlier duplicates were dead (last-key-wins) and tripped
  // no-dupe-keys once this file was touched.
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
  // Termite Phase-3 compliance fields (owner signoff 2026-07-13):
  // FS 482.226 report content + FAC 5E-14 application detail.
  areas_not_inspected: 'Areas not inspected',
  inspection_notice_affixed: 'Inspection notice posted',
  percent_solution: 'Solution strength',
  epa_registration: 'EPA registration no.',
  posted_notice: 'Posted notice placed',
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
  // trap_visit_type is REQUIRED (codex P2 on #3159): left optional, a blank
  // selector showed the static "Traps checked" label on the form while the
  // server's visitSequence fallback froze "Traps set" into the report — the
  // tech entering a count under one meaning and the customer reading the
  // other. The closeout pre-selects it from the property's trap registry, so
  // requiring it costs a tap only when we genuinely cannot tell — which is
  // exactly the case that must not be guessed. The fallback survives for
  // snapshots that legitimately carry no value (pre-field completions).
  rodent_trapping: ['species', 'trap_visit_type'],
  // Owner spec §1/§2/§4 marked the full checklists required; the 2026-07-23
  // simplification (same lane as the T&S closeout) retired the duplicate /
  // label-only fields, so each list is back inside the ≤4 budget. Inspection
  // adds conditional requirements (evidence + suspected type when activity
  // was found) in validateTypedFindings.
  rodent_exclusion: [
    'entry_points_addressed', 'exclusion_work_completed',
    'exclusion_materials', 'remaining_concerns',
  ],
  rodent_sanitation: [
    'sanitation_areas', 'contamination_level',
    'sanitation_work_completed', 'sanitation_limitations',
  ],
  rodent_inspection: [
    'areas_inspected', 'activity_found', 'recommended_service', 'urgency',
  ],
  wildlife_trapping: ['target_animal'],
  // rooms_treated joined the required core 2026-07-23: with the generic
  // Areas-treated picker hidden on bed bug completions, it is the ONLY
  // location capture — a closeout without it would leave the report and
  // product records with no record of where the treatment occurred
  // (codex P2 on #2963).
  bed_bug: ['rooms_treated', 'evidence_level', 'treatment_method'],
  // FS 482.226 report content (Codex P1 on the Phase-3 fields): the two
  // compliance answers are required, not optional — a blank field is
  // silently skipped from the immutable customer report, which is exactly
  // the omission the statute forbids. "None" is a truthful
  // areas_not_inspected answer when everything visible was inspected.
  termite_inspection: [
    'termite_type', 'activity_status',
    'areas_not_inspected', 'inspection_notice_affixed',
  ],
  termite_treatment: [
    'target_termite',
    'treatment_method',
    'products_used',
    'linear_feet_or_stations',
    'gallons_or_amount',
    // FAC 5E-14 / FS 482.2265 (Codex P1): every product has an EPA reg.
    // no., and posted_notice carries its own 'Not applicable' option, so
    // both are always answerable. percent_solution is conditionally
    // required (liquid-dilution methods only) in validateTypedFindings —
    // "% solution" does not describe bait or cartridge work.
    'epa_registration',
    'posted_notice',
  ],
  termite_bait_station: ['stations_checked', 'termite_activity', 'bait_consumption'],
  rodent_bait_station: ['stations_checked', 'bait_consumption'],
  // Owner directive 2026-07-21 (closeout simplification): the tech types only
  // scope + condition; treatments derive from the products applied and
  // observed conditions come from the AI photo review, so neither is required
  // input anymore. The detail modules (palm/shrub/bed) are optional.
  tree_shrub: ['plant_groups', 'landscape_condition'],
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
// COMPANION-context extras: on combined visits (e.g. lawn + T&S) the server
// cannot derive T&S treatments from the ONE shared products list (no per-line
// attribution), so the companion form must collect them — required there,
// autoFilled/hidden on the primary form (codex P2, 2026-07-21).
const COMPANION_REQUIRED_FINDINGS_FIELDS = {
  tree_shrub: ['treatments_completed'],
};

function requiredFindingsFieldsFor(type, { companion = false } = {}) {
  const base = REQUIRED_FINDINGS_FIELDS[type] || [];
  const extra = companion ? (COMPANION_REQUIRED_FINDINGS_FIELDS[type] || []) : [];
  return extra.length ? [...base, ...extra] : base;
}

function validateTypedFindings({ type, values, expectedType, enforceRequired = false, companion = false } = {}) {
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
  // companionOnly fields are legal ONLY on companion submissions — a primary
  // submission carrying one (stale client / pre-cutover draft) fails as
  // unknown, keeping the 2026-07-23 primary cutover total.
  const knownKeys = new Set(
    fields.filter((f) => companion || !f.companionOnly).map((f) => f.key),
  );
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
    // chips and multi_select both store a comma-joined selection —
    // every element must come from the field's options so an off-list
    // string can't reach the immutable customer-facing snapshot.
    if ((field.type === 'chips' || field.type === 'multi_select') && Array.isArray(field.options) && field.options.length) {
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
    if (field.type === 'measurement') {
      // Numeric field without count's 4-digit ceiling (bed sqft runs to 5
      // digits). Free text must fail HERE, at entry — the calibration
      // reconcile parses these later and a dictated "about two thousand"
      // would otherwise vanish silently from the ledger. Digit grouping
      // commas/spaces are tolerated (dictation writes "2,400").
      const str = typeof value === 'number'
        ? String(value)
        : (typeof value === 'string' ? value.trim().replace(/[,\s]/g, '') : null);
      if (str == null || !/^\d{1,6}(\.\d+)?$/.test(str)) {
        errors.push(`Invalid measurement for ${field.key}: ${value}`);
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
  // issues, "Inspection only" can't sit beside applied treatments, and palm
  // findings need Palms in the service scope. On the PRIMARY path the
  // condition/detail fields no longer exist (owner 2026-07-23 — the AI photo
  // review carries condition detail), so these checks are value-driven and
  // effectively guard COMPANION sections, the one place the fields survive.
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
  // A declared trap SETUP cannot also have serviced traps that were not
  // there yet (codex P2 on #3159). The deterministic body already suppresses
  // these verbs on a setup, but trap_actions is a customer-facing finding
  // row, so the report still published "Traps set: 8" beside "Trap service
  // performed: Traps reset". Rejecting matches how every other rodent
  // cross-field contradiction is handled above — this is inconsistent DATA,
  // not a copy nicety, and the tech resolves it by correcting whichever
  // field is wrong.
  if (type === 'rodent_trapping' && String(values.trap_visit_type || '').trim() === 'Initial setup') {
    const followUpOnly = String(values.trap_actions || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .filter((action) => SETUP_INCOMPATIBLE_TRAP_ACTIONS.includes(action));
    if (followUpOnly.length) {
      errors.push(
        `Trap actions ${followUpOnly.map((a) => `"${a}"`).join(', ')} describe traps that were already out — `
        + 'either clear them or set this visit to "Follow-up check"'
      );
    }
    // A setup that placed no traps is not a setup (codex P2 on #3159).
    // Blank or 0 published "Traps set: 0" into the immutable report while
    // the body still promised "we return to check them". Count fields
    // legitimately accept 0 elsewhere (a re-check can find zero captures),
    // so this is a stage-specific floor rather than a schema change.
    const trapsPlaced = Number(values.traps_checked);
    if (!Number.isInteger(trapsPlaced) || trapsPlaced < 1) {
      errors.push('An initial setup must record how many traps were set — enter the count, or set this visit to "Follow-up check"');
    }
  }
  // rodent_sanitation publishes "contamination was cleaned and sanitized"
  // copy — with evidence_cleaned retired (2026-07-23), the work chips are
  // the only proof cleanup happened. A submission whose only work chip is
  // the recommendation entry records no performed cleanup, so the report
  // headline would overclaim (codex P2 r3 on #2963). Every other chip —
  // including the limited-access entry — describes work that was done.
  if (type === 'rodent_sanitation') {
    const work = String(values.sanitation_work_completed || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (work.length && work.every((c) => c === 'Insulation removal recommended')) {
      errors.push('"Insulation removal recommended" alone records no cleanup work — add the cleanup performed or clear the chip');
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
  // "10–14 days preferred". A stale window left behind after switching the
  // answer to "No" is a contradiction, not noise: the immutable snapshot
  // would render "No follow-up visit required" beside a follow-up window
  // (Codex P2 round 6). Same for a monitor treatment chip beside
  // "Monitors placed: No" — the report would claim both.
  if (type === 'german_roach_knockdown') {
    const window = String(values.followup_window ?? '').trim();
    if (enforceRequired && String(values.followup_required) === 'Yes' && !window) {
      missing.push('followup_window');
    }
    if (String(values.followup_required) === 'No' && window) {
      errors.push('A follow-up window cannot be recorded with "Follow-up required: No" — update the follow-up answer or clear the window');
    }
    const treatments = String(values.treatment_completed || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (treatments.includes('Monitors / glue boards') && String(values.monitors_placed) === 'No') {
      errors.push('"Monitors / glue boards" in the completed treatments contradicts "Monitors placed: No" — update the monitor answer or remove the treatment chip');
    }
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

  // Termite treatment: % solution is FAC 5E-14 application detail for
  // liquid-dilution work, so it is required exactly when the recorded
  // method is one — bait station and cartridge visits have no dilution to
  // report, and 'Other' is unknowable (Codex P1 on the Phase-3 fields).
  // The method lists are shared with the schema requiredUnless metadata
  // and the project send-readiness gate (project-types.js).
  if (type === 'termite_treatment') {
    const method = String(values.treatment_method || '');
    if (enforceRequired && TERMITE_LIQUID_DILUTION_METHODS.includes(method)
      && String(values.percent_solution ?? '').trim() === '') {
      missing.push('percent_solution');
    }
    // FS 482.2265: perimeter/exterior applications carry the posted-notice
    // duty, so 'Not applicable'/'No' beside a perimeter method is a
    // contradiction the immutable report must not record (Codex P2 r2).
    // Gated on enforceRequired: a mid-visit draft may truthfully hold the
    // pre-posting state; the completion cannot.
    const postedNotice = String(values.posted_notice || '');
    if (enforceRequired && TERMITE_PERIMETER_METHODS.includes(method)
      && postedNotice && postedNotice !== 'Yes') {
      errors.push(`Posted notice "${postedNotice}" contradicts the ${method} application — exterior/perimeter treatments require the posted notice: place it and select "Yes"`);
    }
  }
  // FS 482.226: the Phase-3 field exists so the report states the
  // inspection notice WAS affixed — 'No' is a blocking exception, not a
  // sendable answer (Codex P2 r2). Same enforceRequired gating as above:
  // affixing is in the tech's control at visit time, so completion demands
  // it done, while a draft may record the not-yet state.
  if (type === 'termite_inspection' && enforceRequired
    && String(values.inspection_notice_affixed || '') === 'No') {
    errors.push('The inspection notice must be affixed before the report can be completed — affix the notice and select "Yes"');
  }

  if (enforceRequired) {
    // chips store a comma-joined selection — a value like "," has no real
    // selections but a plain trim check would accept it (Codex P2). A
    // required chips field needs at least one non-empty part.
    const fieldTypeByKey = new Map(fields.map((f) => [f.key, f.type]));
    for (const key of requiredFindingsFieldsFor(type, { companion })) {
      const value = values[key];
      const isEmpty = ['chips', 'multi_select'].includes(fieldTypeByKey.get(key))
        ? String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean).length === 0
        : (value == null || String(value).trim() === '');
      if (isEmpty) missing.push(key);
    }
  }

  return { ok: errors.length === 0 && missing.length === 0, errors, missing };
}

function validateNextStepChips(chips, projectType = null, values = null, context = {}) {
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
  // Two-treatment package, first visit (context set by the completion
  // route): the included follow-up is owed regardless of findings, so "No
  // further action is needed right now." can never land in the immutable
  // report beside a completion response demanding the second visit (Codex
  // r3 on the 20260712300000 cutover). The chip stays available on the
  // included follow-up visit itself.
  if (context.packageFollowupPending && normalized.includes('No action needed')) {
    return { ok: false, error: 'Next-step chip "No action needed" contradicts this service\'s included follow-up visit — select a follow-up next step instead' };
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
  if (values && projectType === 'palmetto_roach_knockdown') {
    if (String(values.followup_needed || '') === 'No'
      && normalized.includes('Follow-up recommended')) {
      return { ok: false, error: 'Next-step chip "Follow-up recommended" contradicts "Follow-up needed: No" — update the follow-up answer or remove the chip' };
    }
    // "No action needed" stays available for cleared/no-follow-up visits but
    // contradicts recorded activity or a requested follow-up (Codex P2
    // round 6) — the chip sentence would deny the action the findings/CTA
    // call for.
    if (normalized.includes('No action needed')) {
      const level = String(values.activity_level || '').trim();
      if (level && level !== 'None observed') {
        return { ok: false, error: `Next-step chip "No action needed" contradicts the recorded activity level (${level}) — remove the chip or update the activity level` };
      }
      if (String(values.followup_needed || '') === 'Yes') {
        return { ok: false, error: 'Next-step chip "No action needed" contradicts "Follow-up needed: Yes" — remove the chip or update the follow-up answer' };
      }
    }
  }
  // The T&S simplification (owner directive 2026-07-21) made
  // customer_recommendations optional, but the 'Customer action needed'
  // sentence reads "Your help with the recommendations above" — beside an
  // empty recommendations field that copy dangles in the immutable report
  // (Codex P2 round 6). The chip requires a recorded recommendation.
  if (values && projectType === 'tree_shrub'
    && normalized.includes('Customer action needed')
    && !String(values.customer_recommendations || '').trim()) {
    return { ok: false, error: 'Next-step chip "Customer action needed" requires a recorded customer recommendation — add one or remove the chip' };
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
//
// `initialSetup` = the FIRST visit of a trapping program (owner 2026-08-02:
// "typically these are first time trappings" — the copy always read as a
// recurring re-check). On that visit the traps are being PUT OUT, so the
// count reads "set 8 traps" instead of "checked 8 traps", and the
// add/reset chips fold into that setup rather than restating it.
function trapActivitySentence(values = {}, { initialSetup = false } = {}) {
  const parts = [];
  const checked = Number(values.traps_checked);
  if (Number.isInteger(checked) && checked > 0) {
    parts.push(`${initialSetup ? 'set' : 'checked'} ${checked} trap${checked === 1 ? '' : 's'}`);
  }
  const capturesRaw = values.captures;
  const captures = Number(capturesRaw);
  if (Number.isInteger(captures) && captures > 0) {
    parts.push(`removed ${captures} capture${captures === 1 ? '' : 's'}`);
  } else if (
    capturesRaw != null && capturesRaw !== '' && captures === 0 && parts.length
    // Traps that went out today have had no chance to catch anything —
    // "found no new captures" on a setup visit reads as a failed check.
    && !initialSetup
  ) {
    parts.push('found no new captures');
  }
  // Both trapping vocabularies: rodent ('Traps reset', 'New traps added')
  // and wildlife ('Trap installed', 'One-way door installed').
  const actions = String(values.trap_actions || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const placedTraps = actions.includes('trap installed') || actions.includes('new traps added');
  if (initialSetup) {
    // The count sentence already says the traps were set — the placement
    // chips only speak when there was no count to carry them.
    if (placedTraps && !parts.length) parts.push('set the traps');
  } else {
    if (actions.includes('trap installed')) parts.push('installed traps');
    if (actions.includes('new traps added')) parts.push('added new traps');
  }
  if (actions.includes('traps reset') && !initialSetup) parts.push('reset the traps');
  if (actions.includes('traps moved')) parts.push('repositioned traps');
  if (actions.includes('one-way door installed')) parts.push('installed a one-way exit device');
  if (actions.includes('bait/lure refreshed')) parts.push('refreshed the bait');
  if (actions.includes('trap removed')) parts.push('removed traps');
  // 'Exterior inspection completed' lives on trap_actions since 2026-07-23
  // (rodent work_completed retired as a duplicate of the action chips); the
  // work_completed read stays for completions replayed from older payloads.
  if (actions.includes('exterior inspection completed')) parts.push('completed an exterior inspection');
  const work = String(values.work_completed || '').toLowerCase();
  if (work.includes('exterior inspection completed') && !actions.includes('exterior inspection completed')) parts.push('completed an exterior inspection');
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
 * Is this the rodent trapping visit where the traps GO OUT, rather than one
 * where they get re-checked? (owner 2026-08-02: the reports "always assume
 * it's a secondary trapping", and "it could be just the first time trapping,
 * but it also could be the second time".)
 *
 * ONLY the tech's explicit `trap_visit_type` selection says so. A trapping
 * visit is a setup or a re-check because of what happened on it, never
 * because of where it falls in a sequence — that was the owner's whole
 * point, and the counter is doubly wrong here because it spans the entire
 * rodent family (a first trapping after an inspection lands on visit 2).
 *
 * There is deliberately NO visitSequence fallback (codex P0 on #3159). An
 * earlier revision inferred setup from `visitSequence <= 1` whenever the
 * field was absent, which meant EVERY pre-change snapshot — none of which
 * carry the field — was reclassified as a setup at view time. The
 * narrative's live grounding would then have told an already-delivered
 * report that the traps were set today, contradicting the frozen
 * "checked/reset" copy persisted in that same snapshot. Existing rows must
 * keep rendering exactly as they were written (AGENTS.md: breaking existing
 * DB rows is P0). Absent the field, this is false and every legacy report
 * keeps its original re-check wording.
 *
 * Nothing is lost going forward: the field is REQUIRED on the rodent
 * trapping schema, so every new completion carries a declaration.
 *
 * Wildlife trapping is deliberately excluded: its checklist carries an
 * explicit 'Trap installed' chip that already reads right on visit 1.
 */
function isInitialRodentTrapSetup(projectType, _visitSequence, values = {}) {
  if (projectType !== 'rodent_trapping') return false;
  return String(values?.trap_visit_type || '').trim() === 'Initial setup';
}

// Wording that CONTRADICTS a declared trap setup. Lives here rather than in
// the narrative module because two independent lanes need the same test and
// the narrative already imports from this file (importing back would cycle):
//   1. the LLM Visit Summary  (rodent-report-narrative's fail-closed guards)
//   2. the tech's AI report body, which is free prose screened only for
//      banned copy — the draft prompt never receives trap_visit_type, and the
//      tech can flip the selector after generating, so a body saying "we
//      checked 8 traps and found no captures" could ride onto a declared
//      setup (codex P1 on #3159).
//
// Anchored to trap nouns so ordinary setup prose survives: "we checked the
// roofline for entry points" is a legitimate sentence on a setup visit. The
// re-verbs deliberately exclude a bare "set" — that is the wording a setup
// visit is SUPPOSED to use (codex P2 on #3159).
// Six rounds of pattern-list extension leaked in BOTH directions at once —
// missing "have been checked" while rejecting "we inspected the attic and set
// eight traps" (codex round 6). A blocklist of surface forms was the wrong
// shape, so this classifies by OBJECT BINDING instead: a re-check verb only
// contradicts a setup when the thing it acts on is a trap.
const TRAP_NOUNS = /^(?:traps?|devices?)$/i;
// Verbs that assert a trap was already in place. `set` and `place` are
// deliberately absent — they are the wording a setup is SUPPOSED to use.
// Inflections are spelled out rather than glued on with a generic suffix
// group: silent-e stems ("replace" → "replaced", not "replaceed") and
// doubling stems ("swap" → "swapped") do not survive that shortcut.
// The `re-` prefix is per-verb, not global. Bare `check`/`inspect` are
// already re-check claims, but bare `bait`/`fresh`/`position`/`set` are what
// a SETUP legitimately does — only their re- forms contradict one. Writing
// `set` as `re-?set` is what finally admits "re-set the traps" while still
// letting "set the traps" through.
const RECHECK_VERB = new RegExp('^(?:'
  + 're-?set(?:ting|s)?'
  + '|(?:re-?)?check(?:ed|ing|s)?'
  + '|(?:re-?)?inspect(?:ed|ing|s)?'
  // Plain synonyms of check/inspect (pre-push audit on 42406f3): a report
  // saying the traps were examined or tested presupposes traps to examine,
  // exactly as bare check/inspect do. Silent-e stem spelled out like
  // `replace` above.
  + '|(?:re-?)?examine[sd]?|(?:re-?)?examining'
  + '|(?:re-?)?test(?:ed|ing|s)?'
  + '|re-?bait(?:ed|ing|s)?'
  + '|re-?fresh(?:ed|ing|es)?'
  + '|re-?position(?:ed|ing|s)?'
  + '|replace[sd]?|replacing'
  + '|swap(?:ped|ping|s)?'
  + '|move[sd]?|moving'
  // Servicing a trap presupposes it was already out (codex P1) — a setup
  // places traps, it does not service them.
  + '|service[sd]?|servicing|services'
  + ')$', 'i');
// Per-verb `re-` prefixes, for the same reason RECHECK_VERB spells them out:
// a single leading `(?:re-?)?` in front of a literal `rebaited` cannot match
// the hyphenated "re-baited" (the prefix eats "re-", leaving "baited" to
// match nothing), while bare `baited` must stay legal because baiting is
// what a setup does. Found by the round-8 passive matrix, not by review.
const RECHECK_PARTICIPLE = new RegExp('^(?:'
  + 're-?set'
  + '|(?:re-?)?checked'
  + '|(?:re-?)?inspected'
  + '|(?:re-?)?examined'
  + '|(?:re-?)?tested'
  + '|re-?baited'
  + '|re-?freshed'
  + '|re-?positioned'
  + '|replaced|swapped|moved|serviced'
  + ')$', 'i');
// Where a verb's object phrase ENDS. Listing terminators rather than the
// allowed modifiers is the only version that survives real prose: an
// adjective allowlist can always be beaten by an unlisted one ("all
// mechanical traps", "the snap traps" — codex P1 round 7), whereas the set
// of words that start a NEW phrase is small and closed.
//
// Deliberately excluded: `of` (partitive — "two of the traps" is still one
// object phrase) and particles like `out`/`up` ("swapped out the old traps").
// `once` and `as` are subordinators exactly like the `after`/`when`/`while`
// already here, and their absence let the passive scan run out of the trap
// noun's phrase and bind a participle belonging to a different subject:
// "We set traps ONCE the crawlspace was checked" read as a trap re-check
// and discarded the body (pre-push audit P1). Note the neighbouring
// "…AFTER the crawlspace was checked" was always correct — the set was
// simply incomplete.
const OBJECT_PHRASE_END = /^(?:in|on|at|for|before|after|with|without|from|to|along|near|around|under|over|behind|beside|by|into|onto|across|through|during|against|where|which|that|when|while|once|as|who|whose|because|since|until|unless|though|although)$/i;
// (No PASSIVE_AUX constant: the passive scan no longer tests for an
// auxiliary at all — see passiveRecheckOnTrap. Enumerating auxiliaries was
// what made the reduced passive "8 traps checked today" invisible.)

function words(text) {
  return String(text).split(/[^A-Za-z0-9-]+/).filter(Boolean);
}

// True when a re-check VERB in this clause takes a trap as its object: read
// forward from the verb to the end of its object phrase and look for a trap
// noun anywhere inside. "inspected the attic" ends at the clause and never
// sees a trap; "inspected the exterior BEFORE placing the traps" ends at
// `before`; "checked all mechanical traps" reaches `traps` regardless of
// which adjectives sit in between.
// Returns EVERY object-bound hit, not the first: the caller exempts each
// hit individually, and returning only the first let a future-governed
// promise mask a completed claim later in the same clause — "We will
// check the traps next week that we inspected today" returned the exempt
// `check … traps` and never reached `inspected` (codex P1 r20).
function activeRecheckOnTrap(clause) {
  const toks = words(clause);
  const hits = [];
  for (let i = 0; i < toks.length; i += 1) {
    if (!RECHECK_VERB.test(toks[i])) continue;
    for (let j = i + 1; j < toks.length && !OBJECT_PHRASE_END.test(toks[j]); j += 1) {
      if (TRAP_NOUNS.test(toks[j])) {
        hits.push({ text: toks.slice(i, j + 1).join(' '), verbAt: i, toks });
        break;
      }
    }
  }
  return hits;
}

// "<trap noun> … <participle>" — the trap is what the participle happened
// to, in any number and any tense: "one trap was reset", "eight traps have
// been checked", "the devices had been inspected".
//
// The participle is SEARCHED FOR, not assumed to sit immediately after the
// auxiliary: reading only the first following token saw the adverb in "all
// traps were carefully inspected" / "the devices have been thoroughly
// checked" and passed them (codex P1 round 8). The active side already
// learned this lesson in round 7 — an allowlist of intervening words is
// always one unlisted adverb from failing — so the scan stops at the same
// closed OBJECT_PHRASE_END set instead of guessing which modifiers are legal.
//
// The AUXILIARY is not required at all (codex P1 round 10). Requiring one
// missed the reduced passive that field shorthand actually uses — "all 8
// traps checked today" — which the active scan cannot recover either,
// because there the trap noun PRECEDES its verb. Dropping the requirement
// subsumes both forms in one scan; `was`/`were`/`have been` simply become
// unremarkable tokens on the way to the participle.
//
// Setup verbs stay legal because RECHECK_PARTICIPLE excludes them: "8 traps
// set today" and "the traps were set before the attic was inspected" both
// pass (the latter stops at `before`, so the later `inspected` is never
// bound to the traps).
// Array-returning for the same reason as the active scan. A RELATIVE
// pronoun (that/which/who) does not end the reach the way the other
// subordinators do: its clause verb acts ON the head noun — "the traps
// that we inspected" is a trap re-check (codex P1 r20). Inside the
// relative clause only the CHECK family may bind (CHECK_VERB_PAST):
// action verbs there read as provenance ("the traps that were moved from
// the garage" is setup-compatible staging prose), and flagging them would
// discard reviewed copy — the bias this stack resolves against.
// `once`/`as`/`after` and the rest still terminate: their clause has its
// own subject, and binding across them was the round-15 regression.
// EVERY trap noun gets its own phrase scan — the first noun's phrase can
// end (at a preposition) before a later noun that carries the claim: "We
// placed traps near traps that we inspected today" found nothing when
// only the first `traps` was scanned (pre-push P1 on d0b30f2d5).
function passiveRecheckOnTrap(clause) {
  const toks = words(clause);
  const hits = [];
  for (let trapAt = 0; trapAt < toks.length; trapAt += 1) {
    if (!TRAP_NOUNS.test(toks[trapAt])) continue;
    let inRelative = false;
    for (let i = trapAt + 1; i < toks.length; i += 1) {
      if (/^(?:that|which|who)$/i.test(toks[i])) { inRelative = true; continue; }
      if (OBJECT_PHRASE_END.test(toks[i])) break;
      const isHit = inRelative
        ? RELATIVE_CHECK_VERB.test(toks[i])
        : RECHECK_PARTICIPLE.test(toks[i]);
      if (isHit) hits.push({ text: `${toks[trapAt]} … ${toks[i]}`, verbAt: i, toks });
    }
  }
  return hits;
}

// Clause split: sentence enders plus the coordinators that introduce a NEW
// verb phrase, so "we inspected the attic AND set eight traps" is judged as
// two clauses rather than one 40-character window.
//
// `and` is the one coordinator that has to be CONDITIONAL, because it does
// two different jobs. Splitting it unconditionally cut coordinated objects
// in half — "we checked the snap and glue traps" became "we checked the
// snap" (a verb with no trap) plus "glue traps today" (a trap with no verb),
// and neither half matched, so the claim published on a declared setup
// (codex P1 round 9). It only starts a new clause when a VERB follows it;
// joining an object's modifiers, it does not.
const CLAUSE_BREAK_RE = /[.!?;,]|\b(?:but|then|while|before|after|so)\b/i;
// Verbs a SETUP legitimately performs. Not re-check claims themselves — they
// exist only to recognize that a new predicate has started after `and`.
const PREDICATE_VERB = /^(?:set|sets|setting|place[sd]?|placing|install(?:ed|ing|s)?|add(?:ed|ing|s)?|bait(?:ed|ing|s)?|position(?:ed|ing|s)?|remove[sd]?|removing|seal(?:ed|ing|s)?|document(?:ed|ing|s)?|note[sd]?|noting|monitor(?:ed|ing|s)?|treat(?:ed|ing|s)?|found|left)$/i;
// Skipped when deciding what follows `and`, so "and carefully set …" is still
// recognized as a new predicate rather than read as an object modifier.
const ADVERBIAL = /ly$|^(?:also|again|now|today|just|already)$/i;
// A NEW SUBJECT after `and` also starts a clause: "the traps were set today
// and the attic was inspected" must not lend the attic's participle to the
// traps — the unsplit window let passiveRecheckOnTrap bind `inspected` to
// `traps` and silently discard legitimate setup copy (codex P2 round 13).
// Recognized as an auxiliary within a few tokens of the `and` with no verb
// before it: determiners and nouns are exactly the tokens the verb tests
// reject, so the auxiliary is the earliest reliable signal. Coordinated
// objects stay joined — "the snap and glue traps" has no auxiliary.
const CLAUSE_AUX = /^(?:was|were|is|are|has|have|had|will|would|can|could|should|may|might|must)$/i;
const NEW_SUBJECT_LOOKAHEAD = 4;
// A REPEATED SUBJECT before the predicate — "we inspected the attic and WE
// set eight traps" — blocked the verb test, and the new-subject scan broke
// on the lexical verb without splitting, so the attic's `inspected` bound
// to the later traps and valid copy was discarded (codex P2 round 14). A
// subject pronoun followed by a predicate is unambiguous, so it is simply
// skipped for the verb test. A determiner+noun subject with a lexical verb
// ("and the assistant set eight traps") deliberately stays joined: without
// a parser it is indistinguishable from a reduced participle modifying the
// object ("the snap and glue traps placed along the wall"), and the
// passive/auxiliary forms of such clauses are already split by CLAUSE_AUX.
const SUBJECT_PRONOUN = /^(?:we|i|they|she|he)$/i;

function splitOnPredicateAnd(piece) {
  const toks = words(piece);
  const out = [];
  let start = 0;
  for (let i = 0; i < toks.length; i += 1) {
    if (!/^and$/i.test(toks[i])) continue;
    let j = i + 1;
    while (j < toks.length && ADVERBIAL.test(toks[j])) j += 1;
    let sawPronoun = false;
    if (SUBJECT_PRONOUN.test(toks[j] || '')) {
      sawPronoun = true;
      j += 1;
      while (j < toks.length && ADVERBIAL.test(toks[j])) j += 1;
    }
    const next = toks[j];
    if (!next) continue;
    let splits = RECHECK_VERB.test(next) || PREDICATE_VERB.test(next);
    // An auxiliary after an explicit new SUBJECT is that subject's verb, so
    // it splits: "traps were checked and WE WILL return" must not let the
    // second clause's future marker excuse the first clause's claim.
    if (!splits && sawPronoun && CLAUSE_AUX.test(next)) splits = true;
    // A future predicate after `and` is its own clause: "We inspected the
    // attic AND WILL SET traps next visit" must not let the active scan run
    // out of the first predicate and bind `inspected` to the second one's
    // traps. `and` is deliberately not an object-phrase terminator (it joins
    // coordinated objects — "the snap and glue traps"), so the split is what
    // separates them. Uses the SAME regex as the governance test, so the two
    // cannot drift apart — the mistake an earlier version of this made with
    // a hand-rolled token list.
    if (!splits && FUTURE_GOVERNOR_RE.test(next)) splits = true;
    // Once a future marker has appeared, this `and` also starts a fresh
    // clause, so a claim standing behind a promise is still judged.
    if (!splits && FUTURE_INTENT_RE.test(toks.slice(start, i).join(' '))) splits = true;
    // With no pronoun, an auxiliary IMMEDIATELY after `and` is a
    // shared-subject verb phrase ("were set and were checked later") — that
    // window must stay joined so the participle still binds to its trap
    // subject. The new-subject scan starts one token later.
    if (!splits && !CLAUSE_AUX.test(next)) {
      for (let k = j + 1; k < Math.min(j + 1 + NEW_SUBJECT_LOOKAHEAD, toks.length); k += 1) {
        if (RECHECK_VERB.test(toks[k]) || PREDICATE_VERB.test(toks[k])) break;
        if (CLAUSE_AUX.test(toks[k])) { splits = true; break; }
      }
    }
    if (splits) {
      out.push(toks.slice(start, i).join(' '));
      start = i + 1;
    }
  }
  out.push(toks.slice(start).join(' '));
  return out;
}

function clauses(text) {
  return String(text || '')
    .split(CLAUSE_BREAK_RE)
    .flatMap((piece) => splitOnPredicateAnd(piece || ''))
    .map((c) => c.trim())
    .filter(Boolean);
}
// trap_actions values that presuppose traps were ALREADY on the property,
// so they contradict a declared setup. 'New traps added' and 'Exterior
// inspection completed' are legitimate on a setup and stay legal.
const SETUP_INCOMPATIBLE_TRAP_ACTIONS = [
  'Traps reset',
  'Traps moved',
  'Traps replaced',
  'Bait/lure refreshed',
  'Damaged or missing traps found',
];
// Hoisted above the setup guards because BOTH families use them: the
// count claims below and the noun-form re-check patterns that follow
// share one definition of "what ends a trap noun phrase" rather than
// keeping two that can drift.
// Animals terminate the phrase ONLY when they are not naming the trap.
// "rat traps", "mouse traps", and "rodent traps" are the ordinary compound
// names in this trade, and treating the animal as an absolute terminator
// meant "We checked 8 mouse traps today" extracted no claim at all — the
// most natural phrasing there is, silently unguarded (codex P1). The
// conditional keeps "2 rats near the traps" counting rats, not traps.
const TRAP_ANIMAL_NOUNS = '(?:rats?|mice|mouse|rodents?|animals?)';
// Unbounded modifier run before an ANIMAL noun, the TRAP_MODIFIER_RUN
// philosophy applied to animal phrases: a fixed {0,2} cap missed "We
// caught 2 large adult roof rats", so a corrected captures value never
// reconciled and the stale 2 survived (codex P1 r20; the negated and
// zero forms shared the cap). `of`/`the` stay ALLOWED, unlike the trap
// run — "caught 2 of the rats" claims the caught 2 — while clause
// connectors, prepositions, auxiliaries, and rival head nouns still
// terminate.
const ANIMAL_MODIFIER_RUN = '(?:\\s+(?!(?:and|or|nor|but|then|near|at|in|on|from|with|without|around|under|behind|were|was|are|is|have|has|had|been|will|would|traps?|devices?|stations?|captures?|catches)\\b)[a-z-]+)*?';
const TRAP_PHRASE_TERMINATORS = [
  // 1. rival head nouns + partitives/articles
  'captures?', 'catches',
  'droppings', 'burrows?', 'holes?', 'gaps?', 'marks?', 'signs?', 'samples?',
  'of', 'the', 'a', 'an', 'and', 'or', 'nor', 'but',
  // 2. prepositions
  'with', 'without', 'near', 'at', 'in', 'on', 'for', 'from', 'around',
  'along', 'inside', 'outside', 'behind', 'beneath', 'under', 'over', 'by',
  'to', 'between', 'through', 'beyond', 'across', 'past', 'into', 'onto',
  'above', 'below', 'beside', 'toward', 'towards', 'against', 'off',
  // 3. clause connectors, auxiliaries, and unambiguous predicate verbs
  'then', 'thus', 'plus', 'also', 'while', 'before', 'after', 'so',
  'because', 'which', 'that', 'where', 'when', 'though', 'although',
  'was', 'were', 'is', 'are', 'be', 'been', 'being', 'has', 'have', 'had',
  'will', 'would', 'did', 'do', 'does', 'can', 'could', 'should', 'may',
  'might', 'must',
  're-?checked', 're-?check', 're-?inspected', 're-?inspect', 'examined',
  'tested', 'serviced', 'completed', 'performed', 'documented', 'recorded',
  'observed', 'noted', 'counted', 'found', 'saw', 'removed', 'replaced',
  're-?set', 'swapped', 'moved',
];
const TRAP_MODIFIER_RUN = `(?:\\s+(?!${TRAP_ANIMAL_NOUNS}\\b(?!\\s+(?:traps?|devices?)\\b))(?!(?:${TRAP_PHRASE_TERMINATORS.join('|')})\\b)[a-z-]+)*?`;
// A bare number is a determiner here too, so "checked 6 of 8 traps" and "6
// of 8 traps were checked" route through the partitive rules — see
// CHECK_PREDICATE_* below for why that matters.
// An article may sit in FRONT of the M ("6 of the 8 traps"), which is at
// least as natural as the bare form. Without it here the partitive rules
// missed the phrase entirely, TRAP_COUNT_CLAIM_RE's own `of M` group
// (which requires the digits adjacent) also missed it, and the leftover
// tail "8 traps" matched as a bare roster claim — reconciling 8 against a
// correctly recorded 6 and discarding the copy. Word-form numbers
// normalize into the same shape, so "Six of the eight traps" went the same
// way. Self-audit finding, immediately after the fix it defeats.
const TRAP_PARTITIVE_DET = '(?:(?:the|our|these|those|all|its)(?:\\s+\\d+)?|\\d+)';
// A CHECK predicate bound to an `N of M` claim changes which number the
// claim is about. Without one, M is the roster ("6 of 8 traps were empty"
// says 8 exist). With one, N is the count that was checked ("6 of 8 traps
// were checked" says 6 were), and reconciling M against `traps_checked`
// flagged a contradiction on prose that was exactly right — discarding the
// technician's reviewed copy, the failure this whole stack exists to
// prevent. Found by self-audit after round 15, not by review: the round-14
// partitive rule reads "checked 8 of the traps" as 8 CHECKED, so the two
// readings of one construction had drifted apart.
// A coordinated second verb keeps the check predicate bound to its count:
// "We checked AND REBAITED 6 of 8 traps" is still a check claim about 6.
// The past-tense check verbs, defined ONCE for every count-governance
// regex that embeds them (the two anchored predicates here and both
// partitives below): when RECHECK_VERB gained examined/tested these four
// still said checked|inspected only, so "Due to activity, we examined 8
// traps" dropped its roster claim as a subset while "…we checked 8 traps"
// kept it (codex P1 r17). The set stays narrower than RECHECK_VERB by
// design — rebaited/moved/serviced/reset are setup-incompatible ACTIONS,
// not roster scans, and must not govern counts (r14).
const CHECK_VERB_PAST = '(?:re-?)?(?:checked|inspected|examined|tested)';
// Token form of the same set, for the passive scan's relative clauses
// ("the traps that we INSPECTED") — one source, see passiveRecheckOnTrap.
const RELATIVE_CHECK_VERB = new RegExp(`^${CHECK_VERB_PAST}$`, 'i');
// The optional `a total of` / `the count of` tail: ordinary wrappers
// between the check verb and its numeral. Without it "we checked a total
// of 8 traps" failed the anchor, and a cue elsewhere in the window then
// demoted the only roster claim — the stale count published (codex P1
// r18).
const CHECK_PREDICATE_LEAD_RE = new RegExp(
  `\\b${CHECK_VERB_PAST}(?:\\s+(?:and|or)\\s+[a-z-]+)*(?:\\s+(?:[a-z]+ly|all|both|just|now))*(?:\\s+(?:a|the)\\s+(?:total|count)\\s+of)?\\s*$`,
  'i',
);
const CHECK_PREDICATE_TRAIL_RE = new RegExp(
  `^(?:\\s+(?:were|was|have|has|had|been|all|both|now|already|just|since|then|also|[a-z]+ly))*\\s+${CHECK_VERB_PAST}\\b`,
  'i',
);
// Distributive ACTION predicates: a count they govern is the subset of
// traps the action touched, never the roster — the same r14 ruling that
// keeps set/reset out of the partitive rules, extended to bare counts.
// "We checked 8 traps and reset 2 traps" read the 2 as a rival total, and
// the deliberate more-than-one-claim bail then let the stale 8 publish
// (codex P1 r19). A sibling of RECHECK_VERB's action forms, NOT derived
// from it: that list also holds check/inspect/examine/test, which DO
// govern rosters. Same anchoring and inflection spelling as the check
// predicates above.
const ACTION_VERB_PAST = '(?:re-?set(?:ting|s)?|re-?bait(?:ed|ing|s)?|re-?fresh(?:ed|ing|es)?'
  + '|re-?position(?:ed|ing|s)?|replace[sd]?|replacing|swap(?:ped|ping|s)?'
  + '|move[sd]?|moving|service[sd]?|servicing)';
const ACTION_PREDICATE_LEAD_RE = new RegExp(
  `\\b${ACTION_VERB_PAST}(?:\\s+(?:[a-z]+ly|all|both|just|now))*(?:\\s+(?:a|the)\\s+(?:total|count)\\s+of)?\\s*$`,
  'i',
);
const ACTION_PREDICATE_TRAIL_RE = new RegExp(
  '^(?:\\s+(?:were|was|have|has|had|been|all|both|now|already|just|since|then|also|[a-z]+ly))*'
  + '\\s+(?:re-?set|re-?baited|re-?freshed|re-?positioned|replaced|swapped|moved|serviced)\\b',
  'i',
);

const SETUP_EMPTY_CAPTURE_RES = [
  /\bno\s+(?:new\s+)?captures?\b/i,
  /\bcaptures?\s+(?:were|was)\s+not\s+recorded\b/i,
  /\b(?:traps?|devices?)\s+(?:were|was)\s+empty\b/i,
  // Numeric and word-form zero say the same thing without the word "no":
  // "0 captures were recorded", "There were zero captures", "caught 0
  // rats". The count guard cannot reject these — a structured captures of
  // 0 makes a zero CLAIM arithmetically accurate — but on a setup the
  // traps just went out, so any zero-capture reading still implies a check
  // that never happened (codex P1 round 12). setupContradictions runs on
  // UN-normalized text, so both the digit and the word form are matched.
  /\b(?:0|zero)\s+(?:new\s+)?(?:captures?|catches)\b/i,
  /\b(?:caught|captured|removed)\s+(?:0|zero)\b/i,
  new RegExp(`\\b(?:0|zero)${ANIMAL_MODIFIER_RUN}\\s+${TRAP_ANIMAL_NOUNS}\\b[^.!?]{0,30}?\\b(?:caught|captured|removed)\\b`, 'i'),
  // Negated ANIMAL forms and do-not-catch verb phrases make the same claim
  // with neither the word "captures" nor a number: "No mice were caught",
  // "We did not catch any rodents", "no rats have been trapped". The count
  // guard cannot see them at all — there is no numeric claim to reconcile
  // (codex P1 round 13). "trapped" joins the verb set here only: a bare
  // "set" stays legal, and "trapped" in the negated form is a check claim.
  new RegExp(`\\bno${ANIMAL_MODIFIER_RUN}\\s+${TRAP_ANIMAL_NOUNS}\\b[^.!?]{0,30}?\\b(?:caught|captured|removed|trapped)\\b`, 'i'),
  /\b(?:(?:did|do|does|have|has|had)\s+not|didn['’]t|don['’]t|doesn['’]t|haven['’]t|hasn['’]t|hadn['’]t)\s+(?:yet\s+)?(?:catch|caught|capture[ds]?|trap(?:ped)?)\b/i,
  /\bnothing\s+(?:was\s+|has\s+been\s+|had\s+been\s+)?(?:caught|captured|trapped)\b/i,
  // Active and partitive ways of saying the traps came up empty — all of
  // them assert a check that a setup has not performed (codex P1). The
  // "empty" form stays PREDICATIVE so "we set 8 traps in the empty
  // crawlspace" is untouched: only copulas and quantifiers may sit between
  // the trap noun and the word.
  /\b(?:traps?|devices?)\s+(?:(?:were|was|are|is|all|still|found|sat|sit)\s+)*empty\b/i,
  new RegExp(`\\bnone\\s+of\\s+${TRAP_PARTITIVE_DET}\\b(?:\\s+[a-z-]+){0,3}?\\s+(?:traps?|devices?)\\b`, 'i'),
  /\b(?:produced|yielded|held|contained)\s+(?:no|zero|0)\s+(?:catches|captures|rodents?|rats?|mice)\b/i,
];

// NOUN-form re-check claims: "Trap inspection completed today", "We
// completed a full trap inspection". The verb scans never see these —
// there is no verb bound to a trap noun at all (codex P1 round 15).
//
// A completion word is REQUIRED, and that is the whole safety margin: the
// setup's own ratified next-step sentence is "We will return for the
// scheduled trap check", and the setup prompt explicitly asks the model to
// say we return to check them. A bare "trap check" matcher would reject
// exactly the copy this stage is supposed to produce. The trap noun must
// also sit directly on the inspection noun (or be its `of` object), so
// "exterior inspection completed" and "attic inspection" stay legal.
const RECHECK_NOUN = '(?:re-?)?(?:inspections?|checks?|checkups?)';
const COMPLETION_WORD = '(?:completed|complete|performed|done|finished|conducted)';
// The gap between the trap-check noun and its completion word must stay
// inside ONE clause and carry no future marker. Allowing it to cross a
// comma, semicolon, or dash bound a completion word describing the SETUP
// to a check that is merely scheduled — "Initial setup complete, trap
// check scheduled for next week" was rejected — and with no tense test
// "The trap check will be completed on our next visit" was too. Both are
// ordinary setup prose; rejecting them discards the technician's copy.
// The round-15 pass only pinned examples that happened to use a period.
const NOT_FUTURE = '(?!\\b(?:will|shall|scheduled|upcoming|next|when|once|planned)\\b)';
// Dashes separate clauses as readily as commas in field prose ("Trap
// placement completed - trap check in 7 days"). A hyphen inside a word
// ends the gap too, which only ever costs a match — the safe direction.
const CLAUSE_GAP = (n) => `(?:${NOT_FUTURE}[^.!?,;:\\-\\u2013\\u2014])${n}`;
const SETUP_RECHECK_NOUN_RES = [
  new RegExp(`\\b(?:traps?|devices?)\\s+${RECHECK_NOUN}\\b${CLAUSE_GAP('{0,20}?')}\\b${COMPLETION_WORD}\\b`, 'i'),
  new RegExp(`\\b${COMPLETION_WORD}\\b${CLAUSE_GAP('{0,30}?')}\\b(?:traps?|devices?)\\s+${RECHECK_NOUN}\\b`, 'i'),
  new RegExp(`\\b${RECHECK_NOUN}\\s+of\\s+${TRAP_PARTITIVE_DET}\\b${TRAP_MODIFIER_RUN}\\s+(?:traps?|devices?)\\b${CLAUSE_GAP('{0,20}?')}\\b${COMPLETION_WORD}\\b`, 'i'),
  // Completion-first, `of` form: "We completed an inspection of the traps
  // today". The noun-adjacent pattern above needs "trap inspection", and
  // the `of` pattern needs its completion word to FOLLOW, so this word
  // order fell between them. The verb scans don't catch it either —
  // "check" doubles as a verb so "a check of the traps" is caught
  // incidentally, but "inspection" has no verb form to match (codex P1
  // round 16).
  new RegExp(`\\b${COMPLETION_WORD}\\b${CLAUSE_GAP('{0,20}?')}\\b${RECHECK_NOUN}\\s+of\\s+${TRAP_PARTITIVE_DET}\\b${TRAP_MODIFIER_RUN}\\s+(?:traps?|devices?)\\b`, 'i'),
];
// A stated INTENTION to check is not a claim that checking happened — and
// "we will return to check the traps" is exactly what the setup prompt
// asks the model to write. The verb scans have no tense of their own, so
// the escape hatch was the pronoun in "check THEM"; a tech writing the
// noun instead had the body discarded. Applied per clause, ahead of the
// verb scans, so a real claim in a neighbouring clause still rejects.
const FUTURE_INTENT_RE = /\b(?:will|shall|going\s+to|plan(?:ning)?\s+to|expect\s+to|due\s+to|scheduled|upcoming|return\s+to|be\s+back\s+to|next\s+(?:visit|week|month|trip))\b/i;
// Whether a future marker GOVERNS a particular verb, rather than merely
// sharing a clause with it. Three attempts at the coarser question all
// failed in a different direction: skipping the clause let a promise carry
// out the claim beside it; truncating at the marker lost a claim that came
// after it; and the coordinator rule still lost one EMBEDDED behind it —
// "We will continue monitoring the traps WE CHECKED today", where `will`
// governs `continue`, not `checked`.
//
// Governance is local: an auxiliary or infinitival head sits within a
// couple of tokens of the verb it governs ("will inspect", "plan to
// check", "return to check", "are going to inspect"). Anything further
// away is governing something else. Deliberately a small window — a wider
// one is how the last three versions swallowed neighbouring claims.
const FUTURE_GOVERNOR_RE = /\b(?:will|shall|going|plan|planning|expect|due|return|back|scheduled|upcoming)\b/i;
// Tokens a future predicate may legitimately put between its marker and the
// verb it governs: the infinitival head, motion verbs, and timing. "We will
// COME BACK NEXT WEEK TO inspect the traps" is one promise, and a flat
// three-token window classified it as a completed re-check (codex P1) —
// natural setup copy, silently discarded.
const FUTURE_CHAIN_TOKEN = /^(?:to|back|again|soon|later|then|next|coming|upcoming|week|weeks|month|months|day|days|visit|trip|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|morning|afternoon|come|comes|coming|go|goes|going|return|returns|returning|be|been|stop|stopping|swing|head|by|out|on|in|for|our|the|a|an|[a-z]+ly)$/i;
// The walk STOPS at anything else — and the load-bearing case is a subject
// pronoun, which is what starts an embedded clause with its own verb: in
// "the traps WE checked", `we` ends the reach of any earlier `will`, which
// is exactly the distinction the positional versions of this test kept
// getting wrong.
function futureGovernsVerb(toks, verbAt) {
  for (let i = verbAt - 1; i >= 0 && i >= verbAt - 8; i -= 1) {
    if (FUTURE_GOVERNOR_RE.test(toks[i])) return true;
    if (!FUTURE_CHAIN_TOKEN.test(toks[i])) return false;
  }
  return false;
}
// Same question for the noun-form patterns, asked of the text in front of
// the match. A coordinator ends the reach — "Follow-up scheduled next week
// AND trap inspection completed today" is two assertions, and only the
// first one is a promise. Inside that reach the SAME bounded chain walk as
// the verb form decides governance: a flat three-token window missed "We
// are scheduled next week to complete an inspection of the traps", whose
// governor sits four tokens back behind pure chain tokens, and the valid
// setup copy was discarded (codex P2 r17) — the exact failure mode the
// verb side already fixed by walking instead of truncating.
function futureGovernsMatch(text, index) {
  const before = String(text).slice(0, index);
  const lastBreak = Math.max(
    before.lastIndexOf(' and '), before.lastIndexOf(' but '), before.lastIndexOf(' then '),
  );
  const toks = words(before.slice(lastBreak + 1));
  return futureGovernsVerb(toks, toks.length);
}

// Word-form numbers normalized to numerals before any count check, so
// "eight traps" is validated exactly like "8 traps". Shared with the
// narrative module, which validates the LLM summary against the same facts
// (it imports from this file; a copy in each would drift).
const WORD_NUMBER_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
};
const WORD_NUMBER_RE = new RegExp(`\\b(${Object.keys(WORD_NUMBER_VALUES).join('|')})\\b`, 'gi');

function normalizeWordNumbers(text) {
  return String(text || '')
    .replace(WORD_NUMBER_RE, (word) => String(WORD_NUMBER_VALUES[word.toLowerCase()]))
    // recombine compound word-numbers the word pass split — hyphenated
    // ("twenty-one" → "20-1") AND space-separated ("twenty one" → "20 1")
    // — so they can't slip a smaller grounded digit past the count
    // validators (codex P2 r3 + P1 r8)
    .replace(/\b(\d+)[-\s](\d)\b/g, (full, tens, ones) => (Number(tens) >= 20 && Number(tens) % 10 === 0
      ? String(Number(tens) + Number(ones))
      : full));
}

// Count claims in free prose. `N of M traps` yields M — the roster claim —
// because the N is a subset ("6 of 8 traps were empty" claims 8 exist), and
// bare partitives ("one of the traps") claim no total at all.
//
// The modifier run between the count and its trap noun is bounded by
// MEANING, with no token cap at all: adjectives ("exterior mechanical
// snap") extend the same noun phrase however long it runs, while anything
// that starts a NEW phrase ends it. The old two-token cap missed "We
// checked 8 exterior mechanical snap traps" entirely (codex P1 round 13),
// and the interim {0,6} was the same mistake smaller — catalog prose runs
// past any fixed cap (codex P2 round 14).
//
// Three terminator families, all of them closed sets (the same philosophy
// as OBJECT_PHRASE_END — an ADJECTIVE allowlist can always be beaten by an
// unlisted adjective, whereas the words that start a new phrase are few):
//  1. nouns the count could belong to instead, and partitives/articles —
//     "2 rats near the traps" counts rats, not traps.
//  2. prepositions.
//  3. clause connectors, auxiliaries, and the re-check verbs — removing
//     the cap left the scan free to run through a whole predicate, so "We
//     documented 8 fresh droppings then checked mechanical traps" read as
//     an 8-trap roster claim (codex P2 round 15, a regression from the
//     round-14 removal).
// Participial ADJECTIVES a trap phrase legitimately uses (baited, placed,
// new, sealed) are deliberately NOT terminators. Verbs that could also be
// pre-nominal adjectives are the ambiguous middle; they resolve toward
// terminating, which loses a claim rather than inventing one — the bias
// this whole guard stack is built on.
// The `of M` group tolerates an article too, so "6 of the 8 traps" is read
// as ONE N-of-M claim rather than leaving a bare "8 traps" tail behind —
// which is what let the check-predicate suppression below be bypassed.
const TRAP_COUNT_CLAIM_RE = new RegExp(`\\b(\\d+)(?:\\s+(?:out\\s+of|of)\\s+(?:the|our|these|those|all|its)?\\s*(\\d+))?(${TRAP_MODIFIER_RUN})\\s+(?:traps?|devices?)\\b`, 'gi');
// Numeric partitives WITH a check predicate claim the checked count even
// though they never name a roster: "We checked 8 of the traps" puts 8
// against the structured count, where a bare "one of the traps held a
// capture" still claims nothing (codex P1 round 14). CHECK_VERB_PAST
// forms only, deliberately: "reset 3 of the traps" is a subset ACTION on
// some of the checked traps, and "set/placed 3 of the traps in the attic"
// is distributive placement prose — counting either against the
// structured total would re-create the copy-discarding false positive
// this PR exists to fix.
//
// BOTH word orders, and the shared semantic modifier run rather than a
// token cap (codex P1 round 15): the active form was the only one covered,
// so "8 of the traps were checked" — the way a report actually reads —
// extracted nothing.
const TRAP_PARTITIVE_ACTIVE_RE = new RegExp(
  `\\b${CHECK_VERB_PAST}\\s+(\\d+)\\s+of\\s+${TRAP_PARTITIVE_DET}\\b${TRAP_MODIFIER_RUN}\\s+(?:traps?|devices?)\\b`,
  'gi',
);
// The passive predicate is matched as auxiliaries + adverbs + participle
// rather than "the participle within N characters". Here an allowlist is
// the SAFE shape, opposite to the object-binding scans: an unlisted adverb
// costs a missed claim (a stale count may publish), while a loose window
// binds a later unrelated participle — "8 of the traps were empty and the
// attic was inspected" — and discards reviewed copy, which is worse.
const TRAP_PARTITIVE_PASSIVE_RE = new RegExp(
  `\\b(\\d+)\\s+of\\s+${TRAP_PARTITIVE_DET}\\b${TRAP_MODIFIER_RUN}\\s+(?:traps?|devices?)\\b`
  + '(?:\\s+(?:were|was|have|has|had|been|all|both|now|already|just|since|then|also|[a-z]+ly))*'
  + `\\s+${CHECK_VERB_PAST}\\b`,
  'gi',
);
const CAPTURE_CLAIM_RE = /\b(\d+)\s+(?:captures?|catches)\b/gi;
// Bait-station count claims (codex P1 r3 on #3354; hardened per the eight
// #3358 findings): the gauge lanes now accept AI drafts on bait-station
// visits, and a draft naming station counts can go stale against the
// corrected typed values the same way trap counts do. Deliberately NARROW,
// same philosophy as the trap guard — a false positive silently discards
// the technician's reviewed copy — so:
//  - only checked/inspected assert the roster; serviced/monitored counts
//    are ACTION SUBSETS ("we serviced 3 stations with damaged lids") and
//    claim nothing;
//  - a number preceded by "of (the)" is a partitive DENOMINATOR ("10 of
//    the 12 stations were checked") and claims nothing;
//  - activity claims accept only whitelisted positive modifiers, so "had
//    NO activity" / "showed no termite activity" never reads as a positive
//    count, and the at-form refuses a negated noun ("no feeding … at 3
//    stations") and never crosses a clause boundary (,;:) — "Feeding was
//    light; bait at 3 stations was refreshed" is a servicing count;
//  - the noun phrase accepts the repo's own deterministic wording
//    ("exterior rodent bait stations"), and the passive auxiliary gap
//    admits adverbs ("were thoroughly inspected"), matching the trap
//    matcher;
//  - total_stations and stations_inaccessible are customer-visible too and
//    reconcile through their own tight forms.
const STATION_NOUN_SRC = '(?:(?:exterior|interior|in-ground|ground|installed|bait|termite|rodent|monitoring)\\s+)*stations?';
// "A total of 12 stations were checked" DECLARES 12 — only a partitive
// numerator upstream ("10 of the 12") marks the number as a denominator,
// so the guard skips an "of" that is itself governed by "total" (codex r3
// on #3358).
const STATION_PARTITIVE_GUARD_SRC = '(?<!(?<!\\btotal\\s)\\bof\\s+)(?<!(?<!\\btotal\\s)\\bof\\s+the\\s+)';
// The claimed number, guarded against the word-number normalizer's split
// hundreds (codex r5 on #3358): "One hundred twenty" normalizes to
// "1 100 20", and matching the numeric tail read 20 as the count and
// dropped accurate copy. A number adjacent to another number claims
// nothing.
const STATION_NUM_SRC = '(?<!\\d\\s)(\\d+)(?!\\s+\\d)';
const STATION_AUX_GAP_SRC = '(?:\\s+(?:were|was|have|has|had|been|all|now|already|just|also|[a-z]+ly))*';
// A restrictive qualifier after the noun marks a SUBSET, not the checked
// total (codex r5 on #3358): "we inspected 2 bait stations WITH damaged
// lids" describes the two repaired stations, and claiming 2 against a
// corrected stations_checked of 12 dropped accurate copy. Prepositional
// LOCATION qualifiers restrict the same way (codex r6): "inspected 2
// stations NEAR the garage and checked the other ten".
const STATION_SUBSET_QUALIFIER_GUARD_SRC = '(?!\\s+(?:with|that|which|near|behind|beside|by|under|along|inside|outside|in|on|at|around)\\b)';
const STATION_CHECKED_ACTIVE_RE = new RegExp(
  `\\b(?:checked|inspected)\\s+(?:all\\s+|the\\s+)?${STATION_NUM_SRC}\\s+${STATION_NOUN_SRC}\\b${STATION_SUBSET_QUALIFIER_GUARD_SRC}`,
  'gi',
);
const STATION_CHECKED_PASSIVE_RE = new RegExp(
  `\\b${STATION_PARTITIVE_GUARD_SRC}${STATION_NUM_SRC}\\s+${STATION_NOUN_SRC}\\b${STATION_AUX_GAP_SRC}\\s+(?:checked|inspected)\\b`,
  'gi',
);
// Tempered gap: stops at clause boundaries AND refuses to bridge a
// negation, so "feeding was not observed at 3 stations" claims nothing.
const STATION_NEGATION_FREE_GAP_SRC = '(?:(?!\\b(?:no|not|none|never|zero)\\b)[^.!?;,:]){0,24}?';
// A windowed negation/scope lookbehind (codex r3 on #3358): the immediate
// single-word lookbehind missed "NO SIGNS OF termite activity … at 3
// stations", and "we will continue MONITORING activity at 3 stations" is
// monitoring SCOPE, not an observed subset. Any negation or scope word
// within the same clause fragment (no ,;:.!? between) suppresses the
// claim — the safe direction: a missed claim publishes copy, a false
// claim discards it.
const STATION_ACTIVITY_SCOPE_GUARD_SRC = '(?<!\\b(?:no|not|none|never|zero|without|for|monitor|monitors|monitored|monitoring|watch|watching|check|checking|prevent|preventing)\\b[^.!?;,:]{0,24})';
// "activity CHECKS/inspections … at N stations" is the scope of the work,
// not an observed subset (codex r5 on #3358) — the noun must not head a
// checking-scope compound.
const STATION_ACTIVITY_AT_RE = new RegExp(
  `\\b${STATION_ACTIVITY_SCOPE_GUARD_SRC}(?:activity|feeding|consumption)\\b(?!\\s+(?:checks?|inspections?|monitoring)\\b)${STATION_NEGATION_FREE_GAP_SRC}\\b(?:at|in|across)\\s+${STATION_NUM_SRC}\\s+${STATION_NOUN_SRC}\\b`,
  'gi',
);
const STATION_ACTIVITY_MOD_SRC = '(?:(?:visible|light|moderate|heavy|active|fresh|recent|new|termite|rodent)\\s+)*';
// "showed SIGNS OF activity" / "had EVIDENCE OF termite activity" are
// direct positive assertions (codex r3 on #3358) — the evidence noun is
// optional between the verb and the activity noun. "showed no signs of
// activity" still claims nothing: 'no' is not a whitelisted modifier.
const STATION_EVIDENCE_OF_SRC = '(?:(?:signs|evidence|indications|traces)\\s+of\\s+)?';
const STATION_ACTIVITY_WITH_RE = new RegExp(
  `\\b${STATION_PARTITIVE_GUARD_SRC}${STATION_NUM_SRC}\\s+${STATION_NOUN_SRC}\\s+(?:with|showing|showed|had)\\s+${STATION_ACTIVITY_MOD_SRC}${STATION_EVIDENCE_OF_SRC}${STATION_ACTIVITY_MOD_SRC}(?:activity|feeding|consumption|hits?)\\b`,
  'gi',
);
// A roster TOTAL requires an explicit assertion (codex r4 on #3358 —
// owner-accepted scope 2026-08-11): "there are N stations" or "N stations
// (are) installed / in place". Any "N stations … on the property" phrase
// alone is a LOCATION — "Activity was observed at 2 bait stations on the
// property" identifies the activity subset's whereabouts, and claiming it
// as the property total discarded accurate copy. "A total of N stations
// were checked" belongs to stations_checked (the passive checked matcher
// claims it through the total-of exemption above), so the total form
// deliberately excludes it.
// The existential form must be an UNQUALIFIED roster assertion (codex r5
// on #3358): "there are 2 bait stations WITH ACTIVITY on the property"
// restricts the assertion to the active subset and claims no total.
const STATION_TOTAL_RE = new RegExp(
  // The existential total keeps its location tail ("there are 20 stations
  // ON the property" IS the roster assertion) — only subset markers void
  // it, not the location prepositions the checked-active guard excludes.
  `\\bthere\\s+(?:are|is)\\s+${STATION_NUM_SRC}\\s+${STATION_NOUN_SRC}\\b(?!\\s+(?:with|that|which|showing|showed|had)\\b)`
  + `|\\b${STATION_PARTITIVE_GUARD_SRC}${STATION_NUM_SRC}\\s+${STATION_NOUN_SRC}\\s+(?:are\\s+|were\\s+)?(?:installed|in\\s+place)\\b`,
  'gi',
);
const STATION_INACCESSIBLE_RE = new RegExp(
  `\\b${STATION_PARTITIVE_GUARD_SRC}${STATION_NUM_SRC}\\s+${STATION_NOUN_SRC}\\b(?:\\s+(?:were|was|are|is))?\\s+(?:inaccessible|not\\s+accessible|unreachable|could\\s+not\\s+be\\s+(?:accessed|reached|checked))\\b`,
  'gi',
);
// Active inaccessible claims (codex r3 on #3358): "we could not access 2
// bait stations", "we were unable to reach 2 stations". PHYSICAL access
// verbs only (codex r6): "unable to SERVICE 2 stations before rain" is a
// work stoppage, not an access failure, and must not feed the
// inaccessible count.
const STATION_INACCESSIBLE_ACTIVE_RE = new RegExp(
  `\\b(?:could\\s+not|couldn['’]t|(?:was|were)\\s+unable\\s+to|unable\\s+to)\\s+(?:access|reach|get\\s+to)\\s+(?:all\\s+|the\\s+)?${STATION_NUM_SRC}\\s+${STATION_NOUN_SRC}\\b`,
  'gi',
);
const CAUGHT_CLAIM_RE = new RegExp(
  `\\b(?:caught|captured|removed)\\s+(\\d+)${ANIMAL_MODIFIER_RUN}\\s+(?:rats?|mice|mouse|rodents?|animals?)\\b`,
  'gi',
);
// The PASSIVE capture claim, where the animal precedes its verb: "two mice
// were caught", "3 rats have been removed". Neither pattern above sees it —
// one needs the noun `captures`, the other needs the verb before the number
// (codex P1 round 10). Same mistake as the reduced-passive trap claim: the
// count guard was only looking at one word order.
const CAUGHT_PASSIVE_CLAIM_RE = new RegExp(
  `\\b(\\d+)${ANIMAL_MODIFIER_RUN}\\s+(?:rats?|mice|mouse|rodents?|animals?)\\b[^.!?]{0,30}?\\b(?:caught|captured|removed)\\b`,
  'gi',
);

// Cues that mark a trap count as a SUBSET of the roster carrying some
// status, rather than a claim about how many traps there are. "We checked 8
// traps and found activity at 2 traps" claims a roster of 8 and a subset of
// 2 — treating both as roster claims made the pair look ambiguous, and the
// `claims.size !== 1` bail then skipped the subject entirely, so a stale 8
// published beside a corrected "Traps checked: 6" (codex P1 round 11).
//
// Read from the text BEFORE the number, bounded to the current sentence so a
// status mentioned in a previous one can't reclassify this count.
const SUBSET_LEAD_RE = /\b(?:activity|captur|consum|access|damag|missing|sprung|empty|disturb|chew)/i;

// A capture COUNT inside a window is not a status cue for the trap count
// beside it. In "We checked 8 traps and recorded 2 captures" the trailing
// window saw `captur`, dropped the only roster claim as a status subset,
// and a stale 8 sailed past the guard while the capture guard separately
// validated the 2 (codex P1 round 12; the lead window had the same hole —
// "We recorded 2 captures and checked 8 traps"). Capture claims are masked
// out length-preservingly BEFORE the windows are read, so indices still
// line up and a cue survives only when it describes the trap count itself
// ("8 traps had captures"), not when it belongs to a neighbouring capture
// count. Masking the whole matched span (not just the cue word) also
// covers a window that slices mid-claim.
function maskCaptureClaims(text) {
  return [CAPTURE_CLAIM_RE, CAUGHT_CLAIM_RE, CAUGHT_PASSIVE_CLAIM_RE].reduce(
    (out, rx) => out.replace(new RegExp(rx.source, 'gi'), (m) => ' '.repeat(m.length)),
    text,
  );
}

// Trap ROSTER claims only — subset counts are recognized and dropped rather
// than counted as competing totals.
//
// The cue can sit on either side of its count ("activity at 2 traps", "2
// traps had captures"), so both windows are consulted — but each is bounded
// by the NEIGHBOURING claims, or a cue between two counts would be read as
// belonging to both. Text between two claims is attributed to the later
// one's lead: "we checked 8 traps and found activity at 2 traps" puts
// "found activity at" on the 2, leaving 8 as the roster it is.
function trapRosterClaims(text) {
  const re = new RegExp(TRAP_COUNT_CLAIM_RE.source, 'gi');
  const found = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    found.push({
      index: match.index,
      end: match.index + match[0].length,
      first: match[1],
      second: match[2],
      filler: match[3],
    });
  }
  const claims = new Set();
  const cueText = maskCaptureClaims(text);
  found.forEach((m, i) => {
    if (/\bof\b/i.test(m.filler || '')) return; // "1 of the traps" — no total claimed
    const lead = cueText
      .slice(i > 0 ? found[i - 1].end : Math.max(0, m.index - 40), m.index)
      .split(/[.!?]/).pop();
    // Only the LAST claim owns the text after it; otherwise that text is the
    // next claim's lead and is judged there.
    const trail = i + 1 < found.length
      ? ''
      : cueText.slice(m.end, m.end + 30).split(/[.!?]/)[0];
    // A count a distributive ACTION verb governs is the subset the action
    // touched — "reset 2 traps" claims nothing about how many exist — and
    // must drop before the roster logic, or it becomes a rival total that
    // bails the whole subject (codex P1 r19).
    if (ACTION_PREDICATE_LEAD_RE.test(lead) || ACTION_PREDICATE_TRAIL_RE.test(trail)) return;
    // A count whose OWN predicate is a check verb is a roster assertion no
    // matter what else shares its windows: in "Due to activity, we checked
    // 8 traps" the cue is the REASON for the visit, not a status on the 8,
    // and demoting the count let a stale roster publish (pre-push audit on
    // 42406f3). The windows stay positional, but immunity binds to the verb
    // governing the count — the same anchored check predicates the partitive
    // branch uses, so there is no second list to drift — and "found activity
    // at 2 traps" (no governing check verb) still reads as the subset it is.
    const checkGoverned = CHECK_PREDICATE_LEAD_RE.test(lead) || CHECK_PREDICATE_TRAIL_RE.test(trail);
    if (!checkGoverned && (SUBSET_LEAD_RE.test(lead) || SUBSET_LEAD_RE.test(trail))) return;
    // `N of M` + a check predicate: N is the checked count, and the
    // partitive rules below claim it. Reading M as the roster here would
    // reconcile the wrong number against traps_checked.
    if (m.second != null && checkGoverned) return;
    claims.add(Number(m.second != null ? m.second : m.first));
  });
  for (const rx of [TRAP_PARTITIVE_ACTIVE_RE, TRAP_PARTITIVE_PASSIVE_RE]) {
    const partitive = new RegExp(rx.source, 'gi');
    let pm;
    while ((pm = partitive.exec(text)) !== null) claims.add(Number(pm[1]));
  }
  return claims;
}

function claimedCounts(text, patterns) {
  const claims = new Set();
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, 'gi');
    let match;
    while ((match = re.exec(text)) !== null) {
      const [, first, second, filler] = match;
      if (/\bof\b/i.test(filler || '')) continue; // "1 of the traps" — subset, no total claimed
      claims.add(Number(second != null ? second : first));
    }
  }
  return claims;
}

// Station claims scope to the CURRENT visit (codex r6 on #3358): "At the
// LAST SERVICE, we inspected 12 bait stations; this visit a locked gate
// limited us to ten" is trend copy — a count whose sentence lead
// references a prior visit claims nothing against today's values.
const STATION_PRIOR_VISIT_RE = /\b(?:last|previous|prior|earlier)\s+(?:visit|service|stop|check|inspection|time|month|quarter)\b/i;
function stationClaimedCounts(text, patterns) {
  const claims = new Set();
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, 'gi');
    let match;
    while ((match = re.exec(text)) !== null) {
      const lead = text.slice(0, match.index).split(/[.!?;]/).pop();
      if (STATION_PRIOR_VISIT_RE.test(lead)) continue;
      const [, first, second, filler] = match;
      if (/\bof\b/i.test(filler || '')) continue;
      claims.add(Number(second != null ? second : first));
    }
  }
  return claims;
}

/**
 * Returns the count claims in `text` that contradict the FINAL structured
 * values (empty when clean or unverifiable).
 *
 * The tech drafts the AI report, then can keep editing the typed fields
 * before completing — nothing re-runs the draft. So a body written against
 * 8 traps survives a correction to 6 and publishes "We checked 8 traps"
 * beside a frozen "Traps checked: 6" and a map drawing 6 pins (codex P1
 * round 8). Unlike the stage guards this applies to BOTH stages: the same
 * staleness produces "We set 8 traps" on a setup.
 *
 * Deliberately narrow, because a false positive silently discards the
 * technician's reviewed copy — the exact failure this PR exists to fix:
 *  - only ONE distinct ROSTER claim per subject is enforced. Two competing
 *    totals are a breakdown ("two snap traps and six glue traps"), and
 *    summing them would be a guess. Status SUBSETS are not competing totals
 *    and are dropped before this test — counting them as rivals made the
 *    guard bail on the commonest multi-count sentence there is ("we checked
 *    8 traps and found activity at 2 traps"), letting a stale total through
 *    (codex P1 round 11).
 *  - a missing, blank, or non-integer structured value is unverifiable,
 *    not wrong.
 */
function countContradictions(text, values = {}) {
  const str = normalizeWordNumbers(text);
  const found = [];
  const check = (claims, raw, kind) => {
    // A CLEARED field is missing, not zero. The closeout keeps '' in values
    // when the tech types a count and then deletes it, and both Number('')
    // and Number(null) are 0 — which would read as "the tech recorded zero"
    // and silently reject any body that mentions a count (codex P2 round 9).
    // Blank has to short-circuit before the coercion, or the unverifiable
    // case documented above does not actually cover the common way a value
    // goes missing.
    if (raw === null || raw === undefined || String(raw).trim() === '') return;
    const actual = Number(raw);
    if (!Number.isInteger(actual) || claims.size !== 1) return;
    const [claimed] = [...claims];
    if (claimed !== actual) found.push(`${kind}:claimed_${claimed}_recorded_${actual}`);
  };
  check(trapRosterClaims(str), values.traps_checked, 'trap_count_mismatch');
  check(
    claimedCounts(str, [CAPTURE_CLAIM_RE, CAUGHT_CLAIM_RE, CAUGHT_PASSIVE_CLAIM_RE]),
    values.captures,
    'capture_count_mismatch',
  );
  // Bait-station lanes (codex P1 r3 on #3354): same staleness, different
  // nouns. Unverifiable (blank/missing) values screen nothing, and two
  // competing totals bail, exactly like the trap rules above.
  check(
    stationClaimedCounts(str, [STATION_CHECKED_ACTIVE_RE, STATION_CHECKED_PASSIVE_RE]),
    values.stations_checked,
    'station_count_mismatch',
  );
  check(
    stationClaimedCounts(str, [STATION_ACTIVITY_AT_RE, STATION_ACTIVITY_WITH_RE]),
    values.stations_with_activity,
    'station_activity_count_mismatch',
  );
  check(stationClaimedCounts(str, [STATION_TOTAL_RE]), values.total_stations, 'station_total_mismatch');
  check(
    stationClaimedCounts(str, [STATION_INACCESSIBLE_RE, STATION_INACCESSIBLE_ACTIVE_RE]),
    values.stations_inaccessible,
    'station_inaccessible_mismatch',
  );
  return found;
}

/**
 * Returns the setup-contradicting phrases found in `text` (empty when clean).
 * Callers decide what to do with them — the narrative rejects and falls back
 * to its deterministic summary; the typed snapshot falls back to the
 * deterministic "what we did" sentence.
 */
function setupContradictions(text) {
  const str = String(text || '');
  const found = [];
  for (const clause of clauses(str)) {
    // The whole clause is judged; the future exemption is applied to the
    // matched VERB rather than to a span of text (see futureGovernsVerb).
    const judged = clause;
    // EVERY hit is exempted individually — a future-governed first hit
    // must not mask a completed claim after it (codex P1 r20). One entry
    // per clause keeps the caller's shape.
    const hits = [...activeRecheckOnTrap(judged), ...passiveRecheckOnTrap(judged)];
    const claim = hits.find((hit) => !futureGovernsVerb(hit.toks, hit.verbAt));
    if (claim) {
      found.push(`setup_recheck_claim:${claim.text.toLowerCase()}`);
    }
    // The noun forms run per clause under the SAME intent guard as the verb
    // scans. Whole-string matching left them exposed to the tense hole the
    // verb side had fixed: the gap's own future lookahead only covers text
    // BETWEEN the two anchors, so "We WILL complete an inspection of the
    // traps next week" — a future promise, with a clean gap — would have
    // been read as a completed re-check by the pattern added for round 16.
    for (const rx of SETUP_RECHECK_NOUN_RES) {
      const nounHit = judged.match(rx);
      if (nounHit && !futureGovernsMatch(judged, nounHit.index)) {
        found.push(`setup_recheck_claim:${nounHit[0].trim().toLowerCase()}`);
      }
    }
  }
  for (const rx of SETUP_EMPTY_CAPTURE_RES) {
    // EVERY occurrence is judged — an exempt conditional first match must
    // not mask a completed claim later in the text ("If no captures are
    // recorded at the next check, we will adjust. No captures were
    // recorded today." — codex P1 r20).
    const global = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`);
    let match;
    while ((match = global.exec(str)) !== null) {
      if (!emptyCaptureExempt(str, match.index)) {
        found.push(`setup_empty_capture_claim:${match[0].trim().toLowerCase()}`);
      }
    }
  }
  return found;
}

// Conditional or future INTENT preceding an empty-capture claim exempts
// it: "IF no captures are recorded at the next check, we will adjust the
// placements" is a decision rule about a future check, not a claim that
// the new traps were already checked — and it is exactly the forward-
// looking copy a setup should write (codex P2 r19). Only markers BEFORE
// the match, inside its own sentence, govern: a promise AFTER a completed
// claim must not excuse it ("No mice were caught and we will return next
// week" still rejects — the round-16 rule, learned the hard way on the
// verb side). Derived from FUTURE_INTENT_RE (one source) plus the
// conditional openers, which the verb walk never needed because a verb
// under "if" is inflected differently.
// Bare expectation verbs join here (FUTURE_INTENT_RE only carries
// "expect to"): "We EXPECT no captures until the first check" states an
// expectation, not an observation.
const EMPTY_CAPTURE_INTENT_RE = new RegExp(
  `${FUTURE_INTENT_RE.source}|\\b(?:if|unless|in\\s+case|should|expect(?:s|ed|ing)?|anticipate[sd]?)\\b`,
  'i',
);
function emptyCaptureExempt(str, index) {
  const before = String(str).slice(0, index);
  const sentenceStart = Math.max(
    before.lastIndexOf('.'), before.lastIndexOf('!'),
    before.lastIndexOf('?'), before.lastIndexOf(';'),
  );
  return EMPTY_CAPTURE_INTENT_RE.test(before.slice(sentenceStart + 1));
}

// Activity-LEVEL claim screen (codex P1 on #3354). The AI draft is written
// before the tech's last edit to the gauge/level select, so a body drafted
// while activity read Heavy can ride under a re-pinned "low" headline — the
// nonzero mirror of the zero-state rule (a draft must never outrank the
// typed level it predates). Levels collapse to three bands (low 1 /
// moderate 2 / high 3) and only a CROSS-FAMILY mismatch (|Δ| ≥ 2 — a
// low-family claim on a high-family final, or vice versa) refuses the
// body: adjacent-band drift ("moderate" vs a 4-pin) reads fine under the
// deterministic headline, and the conservative distance keeps ordinary
// prose ("low areas of the yard") from costing the tech their copy unless
// it actually contradicts the record. Claims are judged per clause and
// only in clauses that talk about activity/infestation/pressure;
// future/conditional intent and prior-visit references exempt a claim
// only when they actually govern it (see the scoping rules below).
// Refusal falls back to the deterministic template — a completion is
// never blocked on copy — and the tech's confirmed reconciliation prompt
// overrides this screen like every other (a person reviewed the
// contradiction).
const LEVEL_CLAIM_BANDS = {
  'very low': 1, light: 1, low: 1, minimal: 1,
  moderate: 2,
  high: 3, heavy: 3, severe: 3, extreme: 3,
};
// A level word claims a level ONLY when bound to the noun it qualifies
// (codex r4 on #3358 — owner-accepted scope 2026-08-11): clause-level
// co-occurrence read "Heavy activity near the LIGHT fixture" as a
// low-band claim and "Low activity near the HIGH ceiling" as a high one,
// discarding accurate copy. Two bindings only:
//   attributive — "heavy (termite) activity", the level word directly
//   modifying the noun through at most a short whitelisted modifier run;
//   predicative — "activity was heavy", the noun linked to the level word
//   through a copular verb.
// consumption/feeding join the noun set (they directly drive the
// bait-station and mosquito scores). Anything else — "heavy rain",
// "high ceiling", "light fixture", "heavy levels" — claims nothing.
const LEVEL_WORD_SRC = '(very\\s+low|light|low|minimal|moderate|high|heavy|severe|extreme)';
// 'contamination' joined for the sanitation body screen (codex r40 #3420) —
// "light contamination" beside a Severe finding is a level claim like any
// other; the binding rules keep unrelated uses ("light fixture") out.
const LEVEL_NOUN_SRC = '(?:activity|infestation|pressure|feeding|consumption|contamination)';
const LEVEL_ATTR_MOD_SRC = '(?:(?:cockroach|roach|german|palmetto|termite|rodent|mosquito|flea|tick|ant|pest|bait|overall|general|visible|current|surface|interior|exterior|feeding)\\s+){0,3}';
const LEVEL_CLAIM_ATTRIBUTIVE_RE = new RegExp(
  `\\b${LEVEL_WORD_SRC}\\b(?!-)\\s+${LEVEL_ATTR_MOD_SRC}${LEVEL_NOUN_SRC}\\b`,
  'gi',
);
const LEVEL_CLAIM_PREDICATIVE_RE = new RegExp(
  `\\b${LEVEL_NOUN_SRC}(?:\\s+levels?)?\\s+(?:was|were|is|are|appears?|appeared|looks?|looked|seems?|seemed|remains?|remained|stays?|stayed|has\\s+been|had\\s+been|been)\\s+(?:(?:very|still|quite|rather|somewhat|fairly|relatively|now)\\s+)*${LEVEL_WORD_SRC}\\b(?!-)`,
  'gi',
);
// Exemptions scope to the CLAIM they qualify, not the whole clause (codex
// P1 r2 on #3354: "activity was heavy today and can continue between
// visits" must not let the trailing "can" launder the completed heavy
// claim). Intent/conditional markers govern only what FOLLOWS them, so
// they exempt a claim only from the span BEFORE it ("may be heavy" — yes;
// "was heavy … and can continue" — no). A prior-visit reference qualifies
// its claim from either side but only NEARBY — "was heavy at our last
// visit" — so it exempts from the before-span or a short window after the
// claim, never from the far end of a long clause.
const LEVEL_CLAIM_INTENT_RE = new RegExp(
  `${EMPTY_CAPTURE_INTENT_RE.source}`
  + '|\\b(?:typical(?:ly)?|usual(?:ly)?|may|might|could|can)\\b',
  'i',
);
// An intent marker GOVERNS the claim only when nothing but copular,
// connective, or perception filler stands between them (codex P1 r3 on
// #3354): in "activity may DECREASE from the heavy activity observed
// today" the 'may' governs "decrease", not the heavy claim, and must not
// exempt it — the same governs-vs-shares-a-clause distinction the trap
// stage guard already draws (futureGovernsVerb). A rival verb in the gap
// ("decrease", "drop", "spread") means the marker's predicate is that
// verb, so the claim stands on its own.
const LEVEL_CLAIM_GOVERN_GAP_RE = new RegExp(
  '^(?:\\s+(?:activity|infestation|pressure|levels?|the|a|an|still|again|'
  + 'to|be|been|being|is|are|was|were|become|becomes|becoming|get|gets|'
  + 'getting|go|goes|going|turn|turns|remain|remains|remaining|stay|stays|'
  + 'staying|appear|appears|look|looks|seem|seems|run|runs|running|'
  + 'you|we|they|it|there|see|seeing|notice|noticing|observe|observing|'
  + 'find|finding|experience|experiencing|'
  // Negations stay governed (codex on #3358): "may NOT be heavy" is
  // qualified prose, not a heavy claim — refusing it dropped valid copy.
  + 'not|never|no|longer|yet|'
  // Transition verbs whose RESULT is the claimed band stay governed too
  // (codex r3 on #3358): "may REACH heavy levels", "could ESCALATE TO
  // heavy". The preposition is the real discriminator — "from" is not
  // filler, so "may decrease FROM the heavy activity observed today"
  // (a current-state reference) stays refused.
  + 'reach|reaches|reaching|escalate|escalates|escalating|climb|climbs|climbing|'
  + 'rise|rises|rising|increase|increases|increasing|decrease|decreases|decreasing|'
  + 'drop|drops|dropping|spike|spikes|spiking|approach|approaches|approaching|'
  + 'trend|trends|trending|grow|grows|growing|build|builds|building|'
  + 'worsen|worsens|worsening|improve|improves|improving|fall|falls|falling|'
  + 'decline|declines|declining|hit|hits|hitting|'
  + 'very|quite|somewhat|more|less|rather|fairly|relatively|[a-z]+ly))*\\s*$',
  'i',
);
function intentGovernsLevelClaim(before) {
  const re = new RegExp(LEVEL_CLAIM_INTENT_RE.source, 'gi');
  let last = null;
  let match;
  while ((match = re.exec(before)) !== null) last = match;
  if (!last) return false;
  // Commas/semicolons between the marker and its claim are connective, not
  // a new predicate ("Typically, heavy activity may be seen" — codex on
  // #3358) — strip them before the filler test.
  const gap = before.slice(last.index + last[0].length).replace(/[,;]/g, '');
  return LEVEL_CLAIM_GOVERN_GAP_RE.test(gap);
}
// Subject-position claims put the modal AFTER the level word ("heavy
// activity MAY be seen in summer" — codex on #3358; the clause splitter
// also severs a sentence-leading "Typically," so the before-span is
// empty). The FIRST marker after the claim governs it when only filler
// stands between them; "was heavy today and can continue" stays refused —
// 'today'/'and' are not filler, so that trailing 'can' never reaches back.
// The after-side marker set is RESTRICTED to qualifiers that can govern a
// subject-position claim (codex r3 on #3358): the full intent regex
// includes causal/scheduling tokens like "due to", and "Heavy activity
// DUE TO moisture was observed today" asserts current heavy — only true
// modals and expectation verbs read backward onto their subject.
// Possibility predicates join the after-set (codex r6 on #3358): "heavy
// activity is POSSIBLE" is a forecast, not an observation.
const LEVEL_CLAIM_AFTER_INTENT_RE = /\b(?:will|shall|may|might|could|can|should|expect(?:s|ed|ing)?|anticipate[sd]?|typical(?:ly)?|usual(?:ly)?|possible|possibly|likely|unlikely|potential(?:ly)?)\b/i;
function intentGovernsLevelClaimFromAfter(afterText) {
  const re = new RegExp(LEVEL_CLAIM_AFTER_INTENT_RE.source, 'gi');
  const first = re.exec(afterText);
  if (!first) return false;
  const gap = afterText.slice(0, first.index).replace(/[,;]/g, '');
  return LEVEL_CLAIM_GOVERN_GAP_RE.test(gap);
}
const LEVEL_CLAIM_PRIOR_VISIT_RE = /\b(?:last|previous|prior|initial|first|earlier)\s+(?:visit|service|stop|check|treatment)\b/i;
const LEVEL_CLAIM_PRIOR_VISIT_WINDOW = 48;
function levelBandForScore(score) {
  if (!Number.isInteger(score) || score < 1) return null;
  if (score >= 4) return 3;
  if (score === 3) return 2;
  return 1;
}
// A clause OPENED by a conditional marker is hypothetical throughout
// (codex r6 on #3358): "If conditions worsen heavy activity is possible"
// has a substantive antecedent the filler allowlist can never enumerate,
// so the opener governs the whole clause.
const LEVEL_CLAIM_CONDITIONAL_OPEN_RE = /^\s*(?:if|unless|in\s+case|should|when)\b/i;
// Directly negated claims assert ABSENCE, not the level (codex r6 on
// #3358): "NO heavy activity was observed" / "heavy activity was NOT
// observed" are truthful zero-findings and must not read as heavy claims.
// Negated-verb context is a denial too (codex r68): "We did NOT FIND
// heavy activity" asserts absence of the level, exactly like the passive
// "Heavy activity was not observed" the round-6 freeze exempts.
const LEVEL_CLAIM_NEGATED_BEFORE_RE = /\b(?:no|not|never|without|zero)\s+$|\b(?:did\s+not|didn['’]t|does\s+not|doesn['’]t|do\s+not|don['’]t|have\s+not|haven['’]t|has\s+not|hasn['’]t|never|could\s+not|couldn['’]t)\s+(?:find|observe|note|detect|see|show|reveal|record)\s+(?:any\s+)?$/i;
const LEVEL_CLAIM_NEGATED_AFTER_RE = /^\s+(?:was|were|is|are|has\s+been|had\s+been)\s+(?:not|never)\b/i;
// A zero/absence claim beside a clearly nonzero gauge contradicts even
// though it carries no level word (codex r51): "No flea activity was
// observed" never enters the banded claims above. Bound to the same noun
// set; "new/additional" absences stay legal ("no new activity" can sit
// truthfully beside persisting pressure). An explicit absence claim
// contradicts EVERY nonzero gauge — unlike adjacent level words, "none"
// vs "some" is not a judgment call a band tolerance should absorb
// (codex r52).
// Predicative/existential shapes only: a banded denial ("No HEAVY
// activity was observed" — denies the level word, frozen legal in the
// round-6 #3358 semantics) and compound-noun subsets ("stations had no
// activity signs") must not read as whole-visit absence.
const LEVEL_ABSENCE_CLAIM_RE = new RegExp(
  `\\bno\\s+(?:visible\\s+|current\\s+|active\\s+)*${LEVEL_ATTR_MOD_SRC}${LEVEL_NOUN_SRC}\\s+(?:was|were|is|are)\\s+(?:observed|found|noted|seen|detected|present)\\b`
  + `|(?<!${LEVEL_WORD_SRC}\\s)\\b${LEVEL_NOUN_SRC}\\s+(?:was|were|is|are)\\s+not\\s+(?:observed|found|noted|seen|detected|present)\\b`
  + `|\\bthere\\s+(?:was|were|is|are)\\s+no\\s+(?:visible\\s+|current\\s+|active\\s+)*${LEVEL_ATTR_MOD_SRC}${LEVEL_NOUN_SRC}\\b(?!\\s+(?:signs?|levels?))`
  + `|\\bno\\s+(?:signs?|evidence|indications?)\\s+of\\s+${LEVEL_ATTR_MOD_SRC}${LEVEL_NOUN_SRC}\\b`
  + `|\\b(?:found|observed|noted|detected|saw|identified)\\s+no\\s+(?:visible\\s+|current\\s+|active\\s+)*${LEVEL_ATTR_MOD_SRC}${LEVEL_NOUN_SRC}\\b`
  + `|\\b(?:did\\s+not|didn['’]t)\\s+(?:find|observe|note|detect|see)\\b(?:(?!\\b(?:very\\s+low|light|low|minimal|moderate|high|heavy|severe|extreme)\\b)[^.!?]){0,30}\\b${LEVEL_ATTR_MOD_SRC}${LEVEL_NOUN_SRC}\\b`
  + `|\\bno\\s+(?:visible\\s+|current\\s+|active\\s+)*${LEVEL_ATTR_MOD_SRC}(?:evidence|signs?)\\b[^.!?]{0,20}\\b(?:was|were|is|are)\\s+(?:observed|found|noted|seen|detected|present)\\b`,
  'gi',
);
// A subset-location prepositional phrase directly after an absence match —
// station/room/area-class nouns only; property-level nouns deliberately
// absent so "no activity at the property" stays a whole-visit denial
// (codex r79).
// Generic sweep nouns (areas/zones/sections/perimeter) only narrow the
// scope when a qualifier actually narrows them — "in areas inspected
// today" and "around the perimeter" describe the whole visit and stay
// whole-visit denials; "at the rear perimeter" is a genuine subset
// (codex r87).
const LEVEL_ABSENCE_SUBSET_SCOPE_RE = /^\s*(?:at|in|near|around|along|behind|under|beneath|inside|by)\s+(?:the\s+|a\s+|an\s+|any\s+of\s+the\s+)?(?:(?:(?:front|rear|back|side|north|south|east|west|interior|exterior|remaining|other|first|second|third|upper|lower)\s+)+(?:areas?|zones?|sections?|perimeter)|(?:(?:front|rear|back|side|north|south|east|west|interior|exterior|remaining|other|first|second|third|upper|lower)\s+)*(?:stations?|traps?|monitors?|bait\s+stations?|rooms?|corners?|walls?|closets?|attic|garage|kitchen|bathrooms?|bedrooms?|crawl\s?space|lanai|soffits?|baseboards?|units?))\b/i;
// finalBand semantics: 1..3 = the recorded level band (adjacent claims
// tolerated, 2-band gaps contradict); an EXPLICIT 0 = a zero-score gauge,
// where ANY positive level claim contradicts (codex r60) and absence
// claims are truthful. null/undefined = no gauge, screens nothing.
function activityLevelContradictions(text, finalBand) {
  if (finalBand !== 0 && !finalBand) return [];
  const found = [];
  for (const clause of clauses(String(text || ''))) {
    if (LEVEL_CLAIM_CONDITIONAL_OPEN_RE.test(clause)) continue;
    if (finalBand >= 1) {
      for (const match of clause.matchAll(new RegExp(LEVEL_ABSENCE_CLAIM_RE.source, 'gi'))) {
        const before = clause.slice(0, match.index);
        const afterClause = clause.slice(match.index + match[0].length);
        const after = afterClause.slice(0, LEVEL_CLAIM_PRIOR_VISIT_WINDOW);
        if (intentGovernsLevelClaim(before) || intentGovernsLevelClaimFromAfter(afterClause)) continue;
        if (LEVEL_CLAIM_PRIOR_VISIT_RE.test(before) || LEVEL_CLAIM_PRIOR_VISIT_RE.test(after)) continue;
        // Absence explicitly scoped to a subset location is a subset
        // report, not a whole-visit denial (codex r79): "no activity at
        // the front stations, but moderate activity at station 7" agrees
        // with a nonzero gauge. Property-level nouns (property/home/…)
        // are NOT subsets and still deny the whole visit.
        if (LEVEL_ABSENCE_SUBSET_SCOPE_RE.test(afterClause)) continue;
        found.push('level_claim_mismatch:none');
      }
    }
    // Both bindings collect into one claim list; the exemption machinery
    // then runs per claim against its own before/after spans.
    const claims = [];
    for (const re of [LEVEL_CLAIM_ATTRIBUTIVE_RE, LEVEL_CLAIM_PREDICATIVE_RE]) {
      for (const match of clause.matchAll(new RegExp(re.source, 'gi'))) {
        claims.push({ index: match.index, length: match[0].length, word: match[1] });
      }
    }
    for (const claim of claims) {
      const word = claim.word.toLowerCase().replace(/\s+/g, ' ');
      const claimBand = LEVEL_CLAIM_BANDS[word];
      if (!claimBand) continue;
      // beside an explicit zero, ANY positive claim contradicts; beside a
      // recorded band, adjacent claims are tolerated (codex r60)
      if (finalBand !== 0 && Math.abs(claimBand - finalBand) < 2) continue;
      const before = clause.slice(0, claim.index);
      const afterClause = clause.slice(claim.index + claim.length);
      const after = afterClause.slice(0, LEVEL_CLAIM_PRIOR_VISIT_WINDOW);
      if (LEVEL_CLAIM_NEGATED_BEFORE_RE.test(before) || LEVEL_CLAIM_NEGATED_AFTER_RE.test(afterClause)) continue;
      if (intentGovernsLevelClaim(before) || intentGovernsLevelClaimFromAfter(afterClause)) continue;
      if (LEVEL_CLAIM_PRIOR_VISIT_RE.test(before) || LEVEL_CLAIM_PRIOR_VISIT_RE.test(after)) continue;
      found.push(`level_claim_mismatch:${word}`);
    }
  }
  return found;
}

// Story-lane body screens, hoisted to module scope so BOTH the story
// branches and the gauge branch (trend visits land there) apply them
// (codex r53 #3420).
const NO_REPAIRS_CLAIM_RE = /\bno\s+(?:exclusion\s+)?(?:repairs?|work)\s+(?:was|were)\s+(?:completed|performed|done|made|needed)\b|\b(?:did\s+not|didn['’]t)\s+(?:complete|perform|make)\b[^.!?]{0,25}\b(?:repairs?|exclusion)\b|\b(?:repairs?|work|exclusion)\b[^.!?]{0,30}\b(?:could\s+not|couldn['’]t|cannot|can['’]t|will\s+not|won['’]t)\s+be\s+(?:completed|performed|done|made|finished)\b|\bunable\s+to\s+(?:complete|perform|finish|make|do)\b[^.!?]{0,30}\b(?:repairs?|exclusion|work)\b/i;
const RODENT_NOUN_SRC = '(?:rodents?|rats?|mice|mouse)';
const NO_ACTIVITY_CLAIM_RE = new RegExp(`\\bno\\s+(?:current\\s+|visible\\s+|active\\s+)*(?:${RODENT_NOUN_SRC}\\s+)?activity\\b|\\bno\\s+(?:signs?|evidence)\\s+of\\s+${RODENT_NOUN_SRC}\\b|\\bno\\s+(?:current\\s+|visible\\s+|active\\s+|fresh\\s+|new\\s+|obvious\\s+)*${RODENT_NOUN_SRC}\\s+(?:evidence|signs?|droppings|indications?)\\b|\\bfree\\s+of\\s+${RODENT_NOUN_SRC}\\b|\\b(?:did\\s+not|didn['’]t|could\\s+not|couldn['’]t|have\\s+not|haven['’]t|has\\s+not|hasn['’]t|never)\\s+(?:find|found|observe[d]?|note[d]?|confirm(?:ed)?|detect(?:ed)?|see|seen|saw|spot(?:ted)?)\\b[^.!?]{0,40}\\b(?:${RODENT_NOUN_SRC}|activity)\\b|\\bno\\s+${RODENT_NOUN_SRC}\\s+(?:was|were)\\s+(?:found|observed|seen|noted)\\b`, 'i');
const ACTIVITY_FOUND_CLAIM_RE = new RegExp(`\\b(?:${RODENT_NOUN_SRC}\\s+)?activity\\s+(?:was|were|is)\\s+(?:found|observed|confirmed|noted|present)\\b|\\bactive\\s+${RODENT_NOUN_SRC}\\b|\\bevidence\\s+of\\s+${RODENT_NOUN_SRC}\\s+(?:was|were)\\s+(?:found|observed|noted)\\b|\\b(?:found|observed|noted|detected|confirmed|spotted|saw)\\s+(?:a\\s+|an\\s+|the\\s+|some\\s+|several\\s+|multiple\\s+|two\\s+|three\\s+|a\\s+few\\s+)?(?:fresh\\s+|new\\s+|active\\s+|visible\\s+|recent\\s+|significant\\s+|clear\\s+|live\\s+|dead\\s+)*${RODENT_NOUN_SRC}\\b|\\b(?:found|observed|noted|detected|confirmed|spotted|saw)\\s+(?:signs?|evidence|droppings)\\s+of\\s+${RODENT_NOUN_SRC}\\b|\\b${RODENT_NOUN_SRC}\\s+(?:droppings?|evidence|signs?|tracks?|gnawing|nesting)\\b[^.!?]{0,30}\\b(?:was|were|is|are)\\s+(?:present|found|observed|visible|noted|seen|evident|discovered)\\b|\\bthere\\s+(?:was|were|is|are)\\s+(?:some\\s+|fresh\\s+|new\\s+|visible\\s+|clear\\s+)*(?:signs?|evidence|droppings)\\s+of\\s+${RODENT_NOUN_SRC}\\b|\\bthere\\s+(?:was|were|is|are)\\s+(?:a\\s+|an\\s+|some\\s+)?${RODENT_NOUN_SRC}\\b`, 'i');
// "Inspection only" is a valid exclusion_work_completed chip — those
// visits recorded NO repairs, so the repair-denial screen must not reject
// truthful copy, and the composition must not claim completed repairs
// (codex r54). Chips are exclusive by validation, but derive from the
// recorded values rather than trusting that.
function exclusionInspectionOnly(values = {}) {
  const chips = String(values.exclusion_work_completed || '')
    .split(',').map((s) => s.trim()).filter(Boolean).filter((c) => c !== 'Other');
  return chips.length > 0 && chips.every((c) => c === 'Inspection only');
}
// The reverse contradiction for inspection-only visits: a body claiming
// repair work was performed.
// The ordinary close/patch/block repair verbs claim the same completed
// work as "sealed" (codex r74): "We closed two gaps at the soffit line",
// "patched the garage opening", "blocked the rodent entry point".
const REPAIRS_DONE_CLAIM_RE = /\brepairs?\s+(?:was|were)\s+(?:completed|performed|made|done|finished)\b|\bcompleted\s+(?:the\s+)?(?:permanent\s+)?(?:exclusion\s+)?repairs?\b|\b(?:sealed|closed|patched|blocked|covered|filled|plugged|screened(?:\s+off)?|caulked|boarded(?:\s+up)?|repaired)\s+(?:the\s+|an?\s+|two\s+|three\s+|several\s+|multiple\s+|some\s+)?(?:[a-z]+\s+){0,2}(?:entry\s+points?|entries|access\s+points?|gaps?|openings?|holes?|points?|voids?|penetrations?)\b|\binstalled\s+(?:hardware\s+cloth|mesh|sealant|door\s+sweeps?|screens?)\b|\breinforced\s+(?:the\s+|an?\s+)?openings?\b/i;
// True when a reviewed body contradicts the recorded story facts of an
// exclusion/inspection section — used by the first-visit story branches
// AND the gauge branch their trend visits land in (codex r53).
function rodentStoryBodyContradiction(projectType, values = {}, text = '') {
  const body = String(text || '');
  if (!body.trim()) return false;
  if (projectType === 'rodent_exclusion') {
    if (!values.exclusion_work_completed) return false;
    // strip denial phrasing first so "no repairs were completed" never
    // reads as a repairs-performed claim
    return exclusionInspectionOnly(values)
      ? REPAIRS_DONE_CLAIM_RE.test(body.replace(new RegExp(NO_REPAIRS_CLAIM_RE.source, 'gi'), ''))
      : NO_REPAIRS_CLAIM_RE.test(body);
  }
  if (projectType === 'rodent_inspection') {
    const recorded = String(values.activity_found || '');
    if (!recorded) return false;
    return recorded === 'Yes'
      ? NO_ACTIVITY_CLAIM_RE.test(body)
      : ACTIVITY_FOUND_CLAIM_RE.test(body.replace(new RegExp(NO_ACTIVITY_CLAIM_RE.source, 'gi'), ''));
  }
  return false;
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
  // Tech-reviewed AI report copy (the completion form's "Generate AI report"
  // output, parsed + banned-copy-screened by the complete route via
  // technician-report-copy.js). The generic non-gauge default composition,
  // every gauge lane, and the knockdown/one-time-mosquito story branches use
  // it — zero states and the remaining owner-specified story branches
  // (rodent exclusion/inspection, flea, tree & shrub) keep their approved
  // wording.
  technicianReportBody = null,
  // The tech confirmed the pre-submit reconciliation prompt
  // (GATE_REPORT_RECONCILE_PROMPT): the contradiction the matcher found
  // was reviewed by a person and overridden, so the stage/count screens
  // must not silently discard the body they confirmed — that is the exact
  // outcome the prompt exists to avoid (codex P1 on the reconciliation
  // round). Stamped onto todaysResult so render-time consumers (the
  // report-data summary screen) honor the same decision.
  reconcileConfirmed = false,
}) {
  const indicator = ACTIVITY_INDICATORS[projectType];
  // Sectioned-checklist types compose "what we did" from their selections
  // (trapping: counts + actions; others: work chips; inspections: areas).
  // The free-text keys stay in the fallback chain so pre-v2 drafts still
  // produce a sentence.
  const isTrappingType = projectType === 'rodent_trapping' || projectType === 'wildlife_trapping';
  // The trap-setup visit: the traps go out TODAY, so every "checked /
  // reset / no captures yet" phrasing is wrong (owner 2026-08-02 — the
  // reports "always assume it's a secondary trapping"). Driven by the tech's
  // `trap_visit_type` selection, NOT by the visit number — a setup can land
  // on any visit. Wildlife is untouched: its checklist carries an explicit
  // 'Trap installed' chip that already reads right on visit 1.
  const initialTrapSetup = isInitialRodentTrapSetup(projectType, visitSequence, values);
  const isBaitStationType = projectType === 'termite_bait_station' || projectType === 'rodent_bait_station';
  // Combo trapping visits (owner spec §3) append the exclusion/sanitation
  // module work to the trap sentence so the narrative covers the whole stop.
  const trapSentence = isTrappingType
    && [
      trapActivitySentence(values, { initialSetup: initialTrapSetup }),
      rodentComboModuleSentences(values),
    ].filter(Boolean).join(' ');
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
  // treatments, palm notes (Ganoderma reassurance/flag), next step. PRIMARY
  // completions no longer collect the Ganoderma/trunk fields (owner
  // 2026-07-23 — the AI photo review carries palm detail on the V2 report),
  // so the palm note only composes for COMPANION sections, where the
  // companionOnly fields still capture it.
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
      // Reviewed Generate-AI copy replaces the scope/what-we-did portion
      // (owner 2026-08-11 rule); the Ganoderma answer and next step are
      // mandated and carry in EVERY body (codex r24 #3420). The body must
      // agree with the recorded landscape CONDITION — a "landscape is
      // healthy" draft beside a Poor/Declining finding (or the reverse)
      // keeps the deterministic copy; reconcile override honored
      // (codex r41).
      // Every explicit condition claim is EXTRACTED and its family compared
      // to the recorded value's family — the former positive/negative
      // buckets missed cross-family middle values ("condition is fair"
      // beside a recorded Poor matched neither bucket and shipped a Poor
      // headline over a Fair body — codex r45). Four families: positive
      // (Excellent/Good), middle (Fair), recovering, negative
      // (Poor/Declining); any claim outside the recorded family
      // contradicts. Reconcile override honored (codex r41).
      // explicit negative adjectives included — "unhealthy" names the
      // negative family directly, no negation needed (codex r55)
      const TS_CONDITION_WORD_SRC = '(excellent|healthy|thriving|great|good|strong|fair|average|so[-\\s]?so|okay|ok|moderate|poor|declining|struggling|deteriorating|failing|rough|bad|unhealthy|unwell|sickly|dying|wilting|stressed|recovering|improving|rebounding)';
      const TS_CLAIM_RES = [
        // past-tense/copular forms included — "The plants appeared healthy"
        // is the common paraphrase the present-tense alternation missed
        // (codex r46)
        new RegExp(`\\b(?:landscape|plants?|shrubs?|palms?|ornamentals?|turf|overall\\s+condition)\\b[^.!?]{0,30}\\b(?:is|are|was|were|looks?|looked|remains?|remained|appears?|appeared|seems?|seemed)\\s+(?:very\\s+|quite\\s+|overall\\s+)*(?:in\\s+(?:very\\s+|quite\\s+)*)?${TS_CONDITION_WORD_SRC}\\b`, 'gi'),
        new RegExp(`\\b${TS_CONDITION_WORD_SRC}\\s+(?:overall\\s+)?(?:landscape|plant|shrub|palm|turf)?\\s*(?:condition|health|shape)\\b`, 'gi'),
        // rated/assessed constructions — "condition was rated excellent"
        // puts a verb between the copular verb and the condition word, so
        // neither shape above extracts it (codex r47)
        new RegExp(`\\b(?:rated|assessed|graded|scored|evaluated|judged|deemed|considered)\\s+(?:as\\s+)?(?:very\\s+|quite\\s+|overall\\s+)*${TS_CONDITION_WORD_SRC}\\b`, 'gi'),
      ];
      const TS_CLAIM_BANDS = {
        excellent: 'positive', healthy: 'positive', thriving: 'positive', great: 'positive', good: 'positive', strong: 'positive',
        fair: 'middle', average: 'middle', 'so-so': 'middle', okay: 'middle', ok: 'middle', moderate: 'middle',
        poor: 'negative', declining: 'negative', struggling: 'negative', deteriorating: 'negative', failing: 'negative', rough: 'negative', bad: 'negative',
        unhealthy: 'negative', unwell: 'negative', sickly: 'negative', dying: 'negative', wilting: 'negative', stressed: 'negative',
        recovering: 'recovering', improving: 'recovering', rebounding: 'recovering',
      };
      const TS_RECORDED_BANDS = {
        Excellent: 'positive', Good: 'positive', Fair: 'middle', Recovering: 'recovering', Poor: 'negative', Declining: 'negative',
      };
      const tsBodyText = String(technicianReportBody || '');
      const tsRecordedBand = TS_RECORDED_BANDS[condition] || null;
      const tsClaimedBands = TS_CLAIM_RES
        .flatMap((re) => [...tsBodyText.matchAll(re)])
        .map((m) => TS_CLAIM_BANDS[String(m[1] || '').toLowerCase().replace(/[\s-]+/g, '-')])
        .filter(Boolean);
      // Negated claims deny the named family — "the plants are not
      // healthy" contradicts a recorded Good/Excellent even though it
      // names no opposing word. The positive shapes cannot cross "not",
      // so these never double-extract (codex r51).
      const TS_NEGATED_CLAIM_RE = new RegExp(
        `\\b(?:landscape|plants?|shrubs?|palms?|ornamentals?|turf|overall\\s+condition)\\b[^.!?]{0,30}\\b(?:(?:is|are|was|were|looks?|looked|remains?|remained|appears?|appeared|seems?|seemed)\\s+(?:not|no\\s+longer|anything\\s+but|far\\s+from|nowhere\\s+near|hardly|scarcely|barely|by\\s+no\\s+means|less\\s+than)|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|(?:do|does|did)\\s+not\\s+(?:look|seem|appear))\\s+(?:very\\s+|quite\\s+|overall\\s+)*(?:in\\s+(?:very\\s+|quite\\s+)*)?${TS_CONDITION_WORD_SRC}\\b`,
        'gi',
      );
      const tsNegatedBands = [...tsBodyText.matchAll(TS_NEGATED_CLAIM_RE)]
        .map((m) => TS_CLAIM_BANDS[String(m[1] || '').toLowerCase().replace(/[\s-]+/g, '-')])
        .filter(Boolean);
      const tsContradiction = Boolean(tsRecordedBand)
        && (tsClaimedBands.some((band) => band !== tsRecordedBand)
          // a negated word contradicts exactly when its family IS the
          // recorded one ("not healthy" beside Good; "not declining"
          // beside Declining)
          || tsNegatedBands.some((band) => band === tsRecordedBand));
      // The body must also agree with the recorded Ganoderma answer — the
      // mandated palm sentence is appended either way, so a body claiming
      // "no Ganoderma conks were observed" beside a recorded Yes (or the
      // reverse) would contradict its own report one sentence later
      // (codex r50).
      const GANODERMA_ABSENT_RE = /\bno\s+(?:visible\s+|possible\s+|suspected\s+)*(?:ganoderma\s*)?conks?\b|\bno\s+ganoderma\b|\b(?:ganoderma|conks?)\b[^.!?]{0,40}\b(?:was|were)\s+not\s+(?:observed|found|seen|noted|detected|identified)\b|\b(?:did\s+not|didn['’]t)\s+(?:observe|find|see|note|detect|identify|locate)\b[^.!?]{0,40}\b(?:ganoderma|conks?)\b/i;
      // presence-state phrasing ("was present", "the palm had a conk",
      // "is showing a conk") claims presence like observed/found do
      // (codex r51)
      // ordinary discovery verbs included — "We detected a Ganoderma
      // conk" (codex r55)
      const GANODERMA_PRESENT_RE = /\b(?:observed|found|noted|saw|spotted|detected|identified|discovered|located|uncovered|possible|suspected)\b[^.!?]{0,40}\b(?:ganoderma|conks?)\b|\b(?:ganoderma|conks?)\b[^.!?]{0,40}\b(?:was|were|is|are)\s+(?:observed|found|noted|seen|present|visible|evident|developing|growing|forming)\b|\b(?:has|have|had|showing|shows?|showed|developed|revealed)\b[^.!?]{0,30}\b(?:ganoderma|conks?)\b|\bthere\s+(?:was|were|is|are|appeared?\s+to\s+be)\s+(?:a\s+|an\s+|one\s+|some\s+)?(?:possible\s+|suspected\s+)*(?:ganoderma|conks?)\b/i;
      const gRecorded = String(values.ganoderma_conk_observed || '');
      const gAbsentClaim = GANODERMA_ABSENT_RE.test(tsBodyText);
      // strip absence phrasing first so "no conks were observed" never
      // reads as a presence claim
      const gPresentClaim = GANODERMA_PRESENT_RE
        .test(tsBodyText.replace(new RegExp(GANODERMA_ABSENT_RE.source, 'gi'), ''));
      const gContradiction = (gRecorded === 'Yes' && gAbsentClaim)
        || (gRecorded === 'No' && gPresentClaim);
      const tsReportBody = technicianReportBody
        && (reconcileConfirmed || (!tsContradiction && !gContradiction))
        ? technicianReportBody
        : null;
      return {
        headline,
        body: `${tsReportBody || `${scopeSentence} ${whatWeDid}`}${palmNote} ${nextStep}`.replace(/\s+/g, ' ').trim(),
        nextStep,
        ...(tsReportBody ? { bodySource: 'technician_report' } : {}),
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
    // Reviewed Generate-AI copy replaces the repair-story sentences (owner
    // 2026-08-11 rule); the remaining-concerns disclosure and next step are
    // mandated and carry in EVERY body (codex r24 #3420). The body must not
    // deny the recorded repairs — "no exclusion repairs were completed"
    // beside the fixed repairs-completed headline keeps the deterministic
    // copy; reconcile override honored (codex r43).
    // modal and inability denials included — "repairs could not be
    // completed" / "we were unable to complete the repairs" deny the
    // recorded work just as plainly as "no repairs were completed"
    // (codex r46; regex hoisted to module scope in r53)
    // Inspection-only visits recorded NO repairs (codex r54): truthful
    // no-repairs copy is legal there, a repairs-performed claim is the
    // contradiction, and the composition must not claim completed repairs.
    const inspectionOnlyVisit = exclusionInspectionOnly(values);
    const exclusionReportBody = technicianReportBody
      && (reconcileConfirmed || !rodentStoryBodyContradiction('rodent_exclusion', values, technicianReportBody))
      ? technicianReportBody
      : null;
    const exclusionMandated = [
      realConcerns.length
        ? `Remaining concerns: ${joinPhrases(realConcerns.map((c) => c.toLowerCase()))}.`
        : 'No remaining concerns were observed today.',
      nextStep,
    ].filter(Boolean);
    const exclusionDescriptive = exclusionReportBody
      ? [exclusionReportBody]
      : [
        areas.length
          ? `Completed ${inspectionOnlyVisit ? 'a rodent exclusion inspection' : 'rodent exclusion work'} today around the ${joinPhrases(areas)}.`
          : `Completed ${inspectionOnlyVisit ? 'a rodent exclusion inspection' : 'rodent exclusion work'} today.`,
        points.length
          ? `${inspectionOnlyVisit ? 'Possible entry points noted' : 'Entry points addressed'} included the ${joinPhrases(points)}.`
          : null,
        whatWeDid,
        materials.length ? `Materials used included ${joinPhrases(materials)}.` : null,
      ].filter(Boolean);
    return {
      headline: inspectionOnlyVisit
        ? 'An exclusion inspection was completed to identify potential rodent access points.'
        : 'Exclusion repairs were completed to reduce rodent access and help prevent re-entry.',
      body: [...exclusionDescriptive, ...exclusionMandated].join(' ').replace(/\s+/g, ' ').trim(),
      nextStep,
      ...(exclusionReportBody ? { bodySource: 'technician_report' } : {}),
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
    // The tech's reviewed "Generate AI report" copy replaces the descriptive
    // portion (owner 2026-08-11 rule, same as knockdown/mosquito/flea) — the
    // limitation disclosure, the severe-contamination follow-up line, and
    // the next step are mandated and carry in EVERY body (codex r23 #3420).
    // The body must agree with the recorded contamination LEVEL: a draft
    // claiming "light contamination" beside a Severe finding keeps the
    // deterministic copy (same level screen the flea/mosquito/knockdown
    // branches run; reconcile override honored — codex r40).
    const sanitationBand = LEVEL_CLAIM_BANDS[level] || null;
    const sanitationReportBody = technicianReportBody
      && (reconcileConfirmed
        || !activityLevelContradictions(technicianReportBody, sanitationBand).length)
      ? technicianReportBody
      : null;
    const mandated = [
      limitations.length
        ? `Some areas had limitations: ${joinPhrases(limitations.map((c) => c.toLowerCase()))}.`
        : 'No limitations were encountered during the cleanup.',
      String(values.contamination_level).startsWith('Severe')
        ? 'Because of the contamination level, our office will follow up with you on next steps.'
        : null,
      nextStep,
    ].filter(Boolean);
    const descriptive = sanitationReportBody
      ? [sanitationReportBody]
      : [
        areas.length
          ? `Completed rodent sanitation service in the ${joinPhrases(areas)}.`
          : 'Completed your rodent sanitation service today.',
        `Contamination level was ${level}.`,
        evidence.length ? `We removed and treated ${joinPhrases(evidence)}.` : null,
        whatWeDid,
      ].filter(Boolean);
    return {
      headline: `${level.charAt(0).toUpperCase()}${level.slice(1)} rodent contamination was cleaned and sanitized today.`,
      body: [...descriptive, ...mandated].join(' ').replace(/\s+/g, ' ').trim(),
      nextStep,
      ...(sanitationReportBody ? { bodySource: 'technician_report' } : {}),
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
    // Reviewed Generate-AI copy replaces the inspection narrative (owner
    // 2026-08-11 rule); the service recommendation and next step are
    // mandated and carry in EVERY body (codex r24 #3420). The body must
    // agree with the boolean finding — a draft claiming "no activity" on a
    // found=Yes visit (or vice versa) keeps the deterministic copy, with
    // the reconciliation override honored (codex r39).
    // noun-first evidence denials included — "No visible rodent evidence
    // was observed" is the natural form of "no evidence of rodents"
    // (codex r46)
    // rat/mouse species nouns claim (and deny) the same finding as
    // "rodent" (codex r50; regexes hoisted to module scope in r53 and
    // shared via rodentStoryBodyContradiction with the gauge branch)
    const inspectionReportBody = technicianReportBody
      && (reconcileConfirmed || !rodentStoryBodyContradiction('rodent_inspection', values, technicianReportBody))
      ? technicianReportBody
      : null;
    const inspectionMandated = [
      service && service !== 'No service needed at this time'
        ? `Based on today's findings, we recommend ${service.charAt(0).toLowerCase()}${service.slice(1)}${urgency === 'High' ? ' — scheduling soon is recommended' : ''}.`
        : 'No service is needed at this time based on today’s findings.',
      nextStep,
    ].filter(Boolean);
    const inspectionDescriptive = inspectionReportBody
      ? [inspectionReportBody]
      : [
        areas.length
          ? `We inspected the ${joinPhrases(areas)}.`
          : 'We completed a rodent inspection of the property today.',
        values.entry_points_found
          ? `Possible entry points were noted: ${String(values.entry_points_found).trim().replace(/\.$/, '')}.`
          : null,
      ].filter(Boolean);
    return {
      headline: found
        ? 'Rodent activity was found during today’s inspection.'
        : 'No current rodent activity was observed during today’s inspection.',
      body: [...inspectionDescriptive, ...inspectionMandated].join(' ').replace(/\s+/g, ' ').trim(),
      nextStep,
      ...(inspectionReportBody ? { bodySource: 'technician_report' } : {}),
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
    // The tech's reviewed "Generate AI report" copy replaces only the
    // intro/what-we-did portion (same owner 2026-08-11 rule the knockdown
    // and mosquito branches follow) — the owner-mandated cooperation line
    // carries in EVERY body. A cleared state keeps the template, and a
    // draft contradicting the FINAL level family is refused (reconcile
    // override honored) — codex r21 on #3420.
    const fleaBand = score != null
      ? levelBandForScore(score)
      : (LEVEL_CLAIM_BANDS[select.toLowerCase()] || null);
    const fleaReportBody = !cleared
      && (reconcileConfirmed
        || !activityLevelContradictions(technicianReportBody, fleaBand).length)
      ? technicianReportBody
      : null;
    return {
      headline,
      body: `${fleaReportBody || `${intro} ${whatWeDid}`} Flea control works best when treatment and home care happen together — the aftercare steps below make the biggest difference.${nextStep ? ` ${nextStep}` : ''}`.replace(/\s+/g, ' ').trim(),
      nextStep,
      ...(fleaReportBody ? { bodySource: 'technician_report' } : {}),
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
    // The tech's reviewed "Generate AI report" copy replaces only the
    // intro/what-we-did portion (owner 2026-08-11); the mandated
    // disclosure and follow-up sentences survive the swap — the German
    // bait-cooperation guidance and the palmetto flush disclosure are
    // owner-critical and carry in EVERY body. A cleared state keeps the
    // template: the draft can predate a late flip to "None observed" and
    // must never outrank the typed zero it predates. A nonzero draft that
    // contradicts the FINAL level family is refused the same way (codex
    // P1 on #3354), unless the tech confirmed the reconciliation prompt.
    const knockdownBand = score != null
      ? levelBandForScore(score)
      : (LEVEL_CLAIM_BANDS[levelWord] || null);
    const knockdownReportBody = !cleared
      && (reconcileConfirmed
        || !activityLevelContradictions(technicianReportBody, knockdownBand).length)
      ? technicianReportBody
      : null;
    return {
      headline,
      body: `${knockdownReportBody || `${intro} ${whatWeDid}`}${disclosure}${followup} ${nextStep}`.replace(/\s+/g, ' ').trim(),
      nextStep,
      ...(knockdownReportBody ? { bodySource: 'technician_report' } : {}),
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
      // The tech's reviewed "Generate AI report" copy becomes the body
      // (owner 2026-08-11 — the one-time mosquito report dropped it). The
      // "None observed" state above keeps the template: the draft can
      // predate a late flip to zero and must never outrank it — and a
      // draft claiming the opposite level family is refused the same way
      // (codex P1 on #3354), reconcile override honored.
      const mosquitoBand = { Light: 1, Moderate: 2, Heavy: 3 }[level];
      const mosquitoReportBody = (reconcileConfirmed
        || !activityLevelContradictions(technicianReportBody, mosquitoBand).length)
        ? technicianReportBody
        : null;
      return {
        headline: `Mosquito activity was ${level.toLowerCase()} today.`,
        body: `${mosquitoReportBody || whatWeDid} ${nextStep}`,
        nextStep,
        ...(mosquitoReportBody ? { bodySource: 'technician_report' } : {}),
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
    // Every gauge lane honours the tech's reviewed "Generate AI report"
    // copy the same way the generic default composition below does (owner
    // 2026-08-02 for rodent trapping, owner 2026-08-11 for the rest — the
    // cockroach report "didn't render" the generated copy, and the drop was
    // collective across gauge lanes). The headline stays deterministic and
    // gauge-driven; only the body swaps, and only when a parsed,
    // banned-copy-screened body exists. bodySource is stamped so the
    // report's summary slot follows the same precedence every other typed
    // report already uses (report-data.js). Rodent exclusion and inspection
    // keep their owner-ratified story wording (DECISIONS.md 2026-07-13) on
    // every path, so their trend visits — which land in this branch — stay
    // template too.
    //
    // The zero score is excluded HERE, not just in the zero-state branch
    // below — a repeat visit with a prior score always carries a trendWord,
    // so a gauge the tech flipped to 0 reaches the trend branch first and
    // would have published a draft written while activity still looked
    // heavy (codex P1 on #3159). Same rule as the default composition: a
    // draft must never outrank the typed zero it predates.
    // A draft that contradicts the declared stage is refused outright
    // (codex P1 on #3159): the AI-report prompt never receives
    // trap_visit_type, and the tech can flip the selector AFTER generating,
    // so a body reading "we checked 8 traps and found no captures" could
    // otherwise ride onto a declared setup — stamped bodySource, published
    // to both Today's Result and the summary slot, with the setup line
    // appended right after it. Falls back to the deterministic sentence,
    // which is always stage-correct because it is composed from the same
    // declaration.
    // Story-lane TREND visits consume the reviewed body like every other
    // gauge lane (owner 2026-08-11 collective rule; codex r53 — the old
    // unconditional template kept Generate billing for prose completion
    // silently discarded). The same story screens their first-visit
    // branches run apply here, reconcile override honored downstream.
    const storyScreened = !rodentStoryBodyContradiction(projectType, values, technicianReportBody)
      || reconcileConfirmed;
    // Story-lane visits consume screened copy even at score 0 (codex r65
    // — their first-visit branches never score-gate, so the client keeps
    // Generate enabled): the story screens verify the recorded facts and
    // the band-0 level screen refuses any positive activity claim, so a
    // zero-score trend body can only publish absence-consistent prose.
    // Every other gauge lane keeps the fixed zero template.
    const storyLane = projectType === 'rodent_exclusion' || projectType === 'rodent_inspection';
    const rawGaugeBody = storyScreened
      && (activity.score !== 0
        || (storyLane
          && activityLevelContradictions(String(technicianReportBody || ''), 0).length === 0))
      ? technicianReportBody
      : null;
    // Stage guard (setup only) AND count guard (both stages): the draft is
    // written before the tech's last edit to the typed fields, so it can
    // contradict the frozen findings on the stage OR on the numbers.
    const gaugeReportBody = rawGaugeBody
      && (reconcileConfirmed
        || (!(initialTrapSetup && setupContradictions(rawGaugeBody).length)
          && !countContradictions(rawGaugeBody, values).length
          // A draft describing one activity family under a final gauge in
          // the opposite family is refused (codex P1 on #3354) — the
          // nonzero mirror of the zero exclusion above.
          && !activityLevelContradictions(rawGaugeBody, levelBandForScore(activity.score)).length))
      ? rawGaugeBody
      : null;
    // One line of expectation-setting on a trap-setup visit: nothing has
    // been checked yet, so the customer is told what happens next instead of
    // reading a re-check story.
    //
    // Dropped when the tech recorded a capture on the same visit (codex P2
    // on #3159): "we removed 1 capture" next to "we check them and record
    // what they catch" reads as a contradiction. The capture is the tech's
    // observed fact and stays; the forward-looking line is the part that no
    // longer applies. Deliberately NOT a validation rejection — a completion
    // is never blocked on copy, and a setup that catches something the same
    // day is a real (if rare) state.
    //
    // Wording note: forward-looking only. An earlier draft opened with "the
    // traps go out on this first visit", which contradicted the trend
    // headline on a setup declared AFTER an earlier rodent-family visit —
    // the main case the selector exists for (trapping that follows an
    // inspection). Restating "the traps went out today" also just echoed the
    // sentence before it, so the line now carries only what the customer
    // does not already know.
    const capturesRecorded = Number(values.captures) > 0;
    const setupLine = initialTrapSetup && !capturesRecorded
      ? ' We return to check them, record what they catch, and adjust placements from there.'
      : '';
    // Story-lane trend visits keep their owner-mandated disclosures even
    // though the generic gauge path composes them (codex r61): the
    // exclusion remaining-concerns sentence and the inspection
    // recommended-service sentence carry in EVERY body, same as their
    // first-visit branches.
    let storyMandatedLine = '';
    if (projectType === 'rodent_exclusion') {
      const trendConcerns = String(values.remaining_concerns || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
        .filter((c) => c !== 'No remaining concerns observed');
      storyMandatedLine = trendConcerns.length
        ? ` Remaining concerns: ${joinPhrases(trendConcerns.map((c) => c.toLowerCase()))}.`
        : ' No remaining concerns were observed today.';
    } else if (projectType === 'rodent_inspection') {
      const trendService = String(values.recommended_service || '');
      const trendUrgency = String(values.urgency || '');
      storyMandatedLine = trendService && trendService !== 'No service needed at this time'
        ? ` Based on today's findings, we recommend ${trendService.charAt(0).toLowerCase()}${trendService.slice(1)}${trendUrgency === 'High' ? ' — scheduling soon is recommended' : ''}.`
        : ' No service is needed at this time based on today’s findings.';
    }
    if (visitSequence > 1 && activity.trendWord) {
      // Stable needs its own sentence shape — "has about the same as the
      // last visit since our last visit" is not English (Codex P2).
      const headline = activity.trend === 'stable'
        ? `${noun} activity is about the same as our last visit.`
        : `${noun} activity has ${activity.trend === 'worsening' ? 'increased' : 'decreased'} since our last visit.`;
      return {
        headline,
        // setupLine belongs here too (codex P2 on #3159): a setup declared
        // after an earlier rodent-family visit lands in THIS branch —
        // visitSequence > 1 with a resolved trendWord — and that is the
        // main case the selector exists for. Omitting the guidance here
        // dropped it from exactly the reports that needed it most.
        body: `${gaugeReportBody || whatWeDid}${setupLine}${storyMandatedLine} ${nextStep}`,
        nextStep,
        ...(gaugeReportBody ? { bodySource: 'technician_report' } : {}),
      };
    }
    if (activity.score === 0) {
      return {
        headline: `No active signs of ${noun.toLowerCase()} activity observed today.`,
        body: `${whatWeDid}${setupLine}${storyMandatedLine} Continue monitoring and contact us if activity returns.`,
        nextStep,
      };
    }
    const levelWord = SCORE_LEVEL_WORDS[activity.score] || 'activity';
    return {
      headline: `${noun} activity was ${levelWord.replace(' activity', '').toLowerCase()} today.`,
      body: `${gaugeReportBody || whatWeDid}${setupLine}${storyMandatedLine} ${nextStep}`,
      nextStep,
      ...(gaugeReportBody ? { bodySource: 'technician_report' } : {}),
    };
  }

  // Non-gauge types (one-shot treatments + pest inspection). The zero state
  // deliberately keeps the template body even when AI report copy exists
  // (Codex P2 #2709): the draft can predate a late flip of the activity
  // select to "None observed", and a body describing activity under the
  // "No active signs" headline would contradict the tech's typed zero.
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
  // The default composition has no owner-mandated body story, so it is the
  // one place the technician's reviewed AI report copy replaces the template
  // body (the one-time pest family — re-services, cleanouts, bee/wasp,
  // tick — lands here on any non-zero activity). Headline stays
  // deterministic; bodySource is stamped only when the AI copy is used so
  // template snapshots stay byte-identical.
  return {
    // The label suffix reads awkwardly in a headline ("Palm Injection
    // Summary completed today") — the approved golden-fixture style is
    // "Palm Injection Treatment completed today."
    // No trailing period — it's a headline, not a sentence (owner 2026-07-21).
    headline: `${reportTypeLabel.replace(/ Summary$/, '')} completed today`,
    body: `${technicianReportBody || whatWeDid} ${nextStep}`,
    nextStep,
    ...(technicianReportBody ? { bodySource: 'technician_report' } : {}),
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
// Screens a reviewed report body against ONE section's recorded findings
// regardless of which snapshot carries the body (codex r52 #3420): a
// primary-carried body must not contradict a customer-facing companion's
// card. Runs the value-driven guards the branches apply when they consume
// the body themselves — trap setup, trap/station counts, and the
// level-band screen for a gauge score. Value-driven means sections
// without those fields screen nothing.
function typedBodyContradictions(projectType, values = {}, score = null, body = '') {
  const text = String(body || '');
  if (!text.trim()) return [];
  const vals = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const found = [];
  if (projectType === 'rodent_trapping' && isInitialRodentTrapSetup(projectType, 1, vals)) {
    found.push(...setupContradictions(text));
  }
  found.push(...countContradictions(text, vals));
  const numericScore = Number.isInteger(score) ? score : Number.parseInt(score, 10);
  // an explicit zero screens positive level claims (codex r60) — a
  // primary-carried body must not claim activity a zero-score companion's
  // fixed card denies
  const band = numericScore === 0
    ? 0
    : levelBandForScore(Number.isInteger(numericScore) ? numericScore : null);
  if (band !== null && band !== undefined) found.push(...activityLevelContradictions(text, band));
  // The story-specific guards run for the companion's type too (codex r79):
  // a primary-carried whole-visit body must not publish a repairs-completed
  // claim beside an inspection-only exclusion companion card — the same
  // body is rejected when that snapshot carries it itself.
  if (rodentStoryBodyContradiction(projectType, vals, text)) {
    found.push('story_contradiction');
  }
  return found;
}

// True when the frozen snapshots in a parsed service_data ACCEPT the
// reviewed body for customer surfaces (codex r65 #3420): mirrors
// report-data's governing-snapshot rule so voice consumers refuse exactly
// what the web report refuses. Customer viewers see auto_send companions
// only; a zero-score snapshot's reconcile flag never means acceptance.
// No governing snapshot (untyped visit) accepts by default — the
// request-context rejection marker covers that path separately.
function typedStoryAcceptsBody(serviceData = {}) {
  const sd = serviceData && typeof serviceData === 'object' ? serviceData : {};
  const typedSnapshot = sd.typedReportSnapshot && typeof sd.typedReportSnapshot === 'object'
    && sd.typedReportSnapshot.type ? sd.typedReportSnapshot : null;
  const companions = Array.isArray(sd.companionReportSnapshots) ? sd.companionReportSnapshots : [];
  const governing = [
    typedSnapshot,
    ...(typedSnapshot ? [] : companions.filter((snap) => snap?.delivery === 'auto_send')),
  ].filter((snap) => snap?.todaysResult);
  if (!governing.length) return true;
  return governing.some((snap) => snap.todaysResult?.bodySource === 'technician_report'
    || (snap.todaysResult?.reconcileConfirmed === true
      && snap.activity?.score !== 0
      // A cleared non-gauge severity/activity select is a zero state too
      // (codex r80/r81) — mirror the web report's exclusion so voice
      // consumers refuse exactly what report-data refuses.
      && !['None observed', 'No activity'].includes(
        String(snap.values?.severity || snap.values?.activity_level || ''),
      )));
}

function buildTypedReportSnapshot({
  projectType,
  values = {},
  nextStepChips = [],
  serviceKey = null,
  serviceLabel = null,
  visitSequence = 1,
  activity = null,
  photoSummary = null,
  technicianReportBody = null,
  reconcileConfirmed = false,
}) {
  const config = PROJECT_TYPES[projectType];
  if (!config) return null;

  const reportTypeLabel = serviceLabel
    ? `${serviceLabel} Summary`
    : `${config.label} Summary`;
  const resolvedReportTypeLabel = visitSequence > 1 && ACTIVITY_INDICATORS[projectType]
    ? `${ACTIVITY_INDICATORS[projectType].programNoun || ACTIVITY_INDICATORS[projectType].pestNoun} Program — Progress Visit`
    : reportTypeLabel;

  // On a trap-SETUP visit the traps are being put out, so the count the tech
  // entered is the number set, not the number re-checked — the customer
  // label follows (owner 2026-08-02). Same signal the Today's Result copy
  // uses, so the finding row and the summary always agree.
  const initialTrapSetup = isInitialRodentTrapSetup(projectType, visitSequence, values);

  const items = [];
  for (const field of config.findingsFields || []) {
    // internal compliance fields (e.g. pollinator status, IRAC/FRAC) stay in
    // the stored values for audit but never render on the customer report.
    if (field.internal) continue;
    const value = values[field.key];
    if (value == null || value === '') continue;
    // chips persist a comma-joined selection — map each element through
    // the copy map individually so per-chip customer wording applies. The
    // mapped PARTS also persist on the item (D1): the report renders chips
    // from this authoritative array only — a client-side comma split would
    // shred single-select customer labels that contain commas ("Older,
    // inactive damage only"), and mapped chip labels may themselves carry
    // commas. Legacy snapshots without the array render as prose.
    const customerValueParts = (field.type === 'chips' || field.type === 'multi_select')
      ? String(value).split(',').map((s) => s.trim()).filter(Boolean)
        .map((part) => customerLabelForValue(field.key, part))
      : null;
    const customerValueLabel = customerValueParts
      ? customerValueParts.join(', ')
      : customerLabelForValue(field.key, value);
    items.push({
      fieldKey: field.key,
      technicianLabel: field.label,
      customerLabel: initialTrapSetup && field.key === 'traps_checked'
        ? 'Traps set'
        : customerLabelForField(field.key, field.label),
      value,
      customerValueLabel,
      ...(customerValueParts && customerValueParts.length ? { customerValueParts } : {}),
    });
  }

  const todaysResult = buildTodaysResult({
    projectType,
    reportTypeLabel: resolvedReportTypeLabel,
    values,
    chips: nextStepChips,
    activity,
    visitSequence,
    technicianReportBody,
    reconcileConfirmed,
  });
  // Stamped HERE, on every snapshot shape — not per todaysResult branch —
  // so companion-only completions (where the trapping snapshot carries no
  // body at all) still freeze the tech's confirmed override for the
  // render-time summary screen to honor (codex P1 on the reconciliation
  // rounds). One stamp site, no branch drift.
  if (reconcileConfirmed && todaysResult) todaysResult.reconcileConfirmed = true;

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

function findingsSchemaForType(projectType, { serviceKey = null, companion = false } = {}) {
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
        // companionOnly fields exist for COMPANION sections only (combined
        // visits run no per-line AI assessment, so hand capture stays the
        // condition source there) — the primary slice never serves them.
        if (f.companionOnly && !companion) return false;
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
        required: requiredFindingsFieldsFor(projectType, { companion }).includes(f.key),
        // Conditional requirement ({ field, value } or { field, values }):
        // required exactly when the named sibling field holds a non-empty
        // value other than `value` / outside `values`. Served so the client
        // pre-submit gate mirrors the server enforcement instead of
        // discovering it as a post-submit 422 (Codex P2).
        requiredUnless: f.requiredUnless || null,
        // internal fields are tech-facing compliance entries — validated and
        // stored, but excluded from the customer-facing snapshot findings.
        internal: !!f.internal,
        // detail fields render inside the collapsed "More detail (optional)"
        // expander; autoFilled fields are hidden from the form entirely and
        // derived server-side at completion (e.g. treatments from products);
        // pesticideOnly fields only render once a pesticide product is on the
        // visit (server compliance validation is the enforcement either way).
        detail: !!f.detail,
        // Companion sections must collect what the server can't derive there —
        // the companion-required extras render as normal inputs.
        autoFilled: !!f.autoFilled && !(companion && (COMPANION_REQUIRED_FINDINGS_FIELDS[projectType] || []).includes(f.key)),
        pesticideOnly: !!f.pesticideOnly,
      })),
    photoCategories: config.photoCategories || [],
    requiredFields: requiredFindingsFieldsFor(projectType, { companion }),
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
// Fixed-timing figures for the compliance classes below: digits OR
// spelled-out quantities, incl. "half an hour" / "a couple of hours"
// forms (codex r48 #3420).
const TIME_FIGURE_SRC = '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty[-\\s]?five|forty|fifty|sixty|ninety|half\\s+an?|a\\s+half|a\\s+couple(?:\\s+of)?|a\\s+few|several|an?)';
const TIME_UNIT_SRC = '(?:minutes?|mins?|hours?|hrs?|half[-\\s]?hours?)';
// One entry-verb alternation shared by the duration and clock-time shapes
// (codex r52/r53). "keep an eye out" carries no of/off/away-from and stays
// legal; "avoid" is scoped to treated-surface nouns so agronomic
// aftercare ("avoid mowing for 48 hours") stays legal too.
// Passive occupancy forms are anchored on be/been/being so completed-action
// prose ("we entered through the side gate") never matches (codex r54).
const REENTRY_VERB_SRC = '(?:re-?ent(?:er|ry)|enter(?:ing)?|occupy(?:ing)?|return(?:ing)?|go(?:es|ing)?\\s+back|com(?:e|es|ing)\\s+back|reoccupy(?:ing)?|walk(?:ing)?\\s+on|play(?:ing)?\\s+on|sit(?:ting)?\\s+on|let\\s+(?:your\\s+|the\\s+)?(?:pets?|dogs?|cats?|children|kids?|family)\\b|(?:allow(?:ing)?|permit(?:ting)?|bring(?:ing|s)?|tak(?:e|es|ing))\\s+(?:your\\s+|the\\s+)?(?:pets?|dogs?|cats?|children|kids?|family|people|guests?|anyone)\\b|(?:be|been|being|are|is|was|were)\\s+brought\\s+back\\b|go(?:es|ing)?\\s+outside|keep[^.!?]{0,25}\\b(?:out\\s+of|off|away(?:\\s+from)?|indoors?|inside)\\b|stay(?:ing)?\\s+(?:out\\s+of|off|away(?:\\s+from)?|indoors?|inside)|remain(?:s|ed|ing)?\\s+(?:out\\s+of|off|away(?:\\s+from)?|indoors?|inside|out(?:side)?)\\b|wait(?:s|ed|ing)?\\s+(?:out\\s+of|off|away(?:\\s+from)?|indoors?|inside|outside)\\b|avoid\\s+(?:the\\s+)?(?:treated|sprayed)\\s+(?:areas?|lawn|turf|yard|rooms?|surfaces?)|access(?:ing)?\\s+(?:the\\s+)?(?:treated|sprayed)\\s+(?:areas?|lawn|turf|yard|rooms?|surfaces?)|us(?:e|ing)\\s+(?:the\\s+)?(?:treated|sprayed)\\s+(?:areas?|lawn|turf|yard|rooms?|surfaces?)|(?:be|been|being)\\s+(?:safely\\s+)?(?:(?:re-?)?(?:entered|occupied|reoccupied|used|accessed)|walked\\s+on|played\\s+on|sat\\s+on|returned\\s+to)|occupancy[^.!?]{0,25}\\b(?:may|can|will|could|should)\\s+(?:safely\\s+)?resume|resum(?:e|es|ing)\\s+(?:normal\\s+)?(?:occupancy|use)|ready\\s+for\\s+(?:use|occupancy|pets?|children|kids|families|play|foot\\s+traffic)|available\\s+for\\s+(?:use|occupancy|pets?|children|kids|families|play|foot\\s+traffic)|safe\\s+for\\s+(?:pets?|children|kids|families|play|foot\\s+traffic)|(?:be|is|are|being|been)\\s+(?:safely\\s+)?(?:accessible|usable|walkable|open\\s+for\\s+(?:use|occupancy))|re-?open(?:s|ed|ing)?|open(?:s|ed|ing)?\\s+(?:back\\s+)?(?:up|again)\\b|dry(?:ing|s)?|dried)';
// Clock times state the same fixed re-entry window as durations
// (codex r53): "Enter the treated area at 4:30 PM", "Stay off until 6 PM".
const CLOCK_TIME_SRC = '(?:\\d{1,2}:\\d{2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?|\\d{1,2}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)|noon|midnight)';
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
  // Compliance-language classes (AGENTS.md customer-surface rule, codex r47
  // #3420): "EPA-registered"/"EPA-exempt" are legal, "EPA-approved" never
  // is; a fixed re-entry/drying minute-or-hour figure is never stated — the
  // idiom is "safe once dry" with the technician confirming timing, and
  // that idiom carries no number so it stays legal here.
  // grant/give/issue constructions state the same approval claim with a
  // verb between EPA and "approval" (codex r74): "The EPA granted approval
  // for this treatment" — EPA-registered/-exempt wording is untouched
  /\bEPA\s+(?:(?:has|have|had)\s+)?(?:(?:now|also|already|officially|recently|just|formally)\s+)?approv(?:ed|es)\b|\bEPA[-\s]?approv(?:ed|al)\b|\bapprov(?:ed|al)\b[^.!?]{0,20}\b(?:by|from|of)\s+(?:the\s+)?EPA\b|\bEPA\s+(?:(?:has|have|had)\s+)?(?:(?:now|also|already|officially|recently|just|formally)\s+)?(?:grant(?:ed|s)?|gave|giv(?:es|en)|issu(?:ed|es)?|provid(?:ed|es)?|extend(?:ed|s)?|award(?:ed|s)?)\b[^.!?]{0,15}\bapproval\b|\bEPA['’]s\s+(?:(?:full|formal|official)\s+)?approval\b/i,
  // spelled-out quantities ("thirty minutes", "two hours", "half an hour",
  // "a few minutes") state the same prohibited fixed timing as digits
  // (codex r48)
  // "return"/"go back"/"come back" state the same re-entry timing without
  // the re-entry word (codex r50): "Return to the treated area after
  // thirty minutes"
  // direct enter/occupancy instructions state the same timing without a
  // "re-" prefix ("Enter the treated area after thirty minutes") —
  // codex r51
  new RegExp(`\\b${REENTRY_VERB_SRC}\\b[^.!?]{0,40}\\b${TIME_FIGURE_SRC}\\s*(?:more\\s+)?${TIME_UNIT_SRC}\\b`, 'i'),
  new RegExp(`\\b${TIME_FIGURE_SRC}\\s*${TIME_UNIT_SRC}\\b[^.!?]{0,40}\\b${REENTRY_VERB_SRC}\\b`, 'i'),
  // clock-time forms (codex r53): forward takes any temporal preposition;
  // the reverse direction takes DEADLINE prepositions only, so "We arrived
  // at 2 PM and entered through the side gate" stays legal.
  new RegExp(`\\b${REENTRY_VERB_SRC}\\b[^.!?]{0,40}\\b(?:at|by|until|till|before|after|around)\\s+${CLOCK_TIME_SRC}\\b`, 'i'),
  new RegExp(`\\b(?:until|till|before|by)\\s+${CLOCK_TIME_SRC}\\b[^.!?]{0,40}\\b${REENTRY_VERB_SRC}\\b`, 'i'),
  // reverse at-time INSTRUCTIONS (codex r56): "At 4 PM, you can enter the
  // treated area" — gated on a modal/permission marker before the entry
  // verb so arrival prose ("we arrived at 2 PM and entered…") stays legal
  new RegExp(`\\b(?:at|around|after)\\s+${CLOCK_TIME_SRC}\\b[^.!?]{0,40}\\b(?:can|may|could|free\\s+to|safe\\s+to|able\\s+to|allowed\\s+to)\\s+(?:safely\\s+)?(?:re-?)?(?:enter|occupy|return|access|use|go\\s+back|come\\s+back|walk\\s+on|play\\s+on|sit\\s+on)\\b`, 'i'),
  // ... and reverse IMPERATIVES (codex r57): "After 4 PM, enter the
  // treated area" — the base-form verb must sit right after the clock
  // phrase, so past-tense arrival narration ("at 2 PM and entered") still
  // never matches
  new RegExp(`\\b(?:at|around|after)\\s+${CLOCK_TIME_SRC}\\s*[,;—–-]?\\s*(?:and\\s+)?(?:then\\s+)?(?:please\\s+)?(?:feel\\s+free\\s+to\\s+)?(?:safely\\s+)?(?:re-?)?(?:enter|occupy|return|access|use|go\\s+back|come\\s+back|walk\\s+on|play\\s+on|sit\\s+on)\\b`, 'i'),
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
  typedBodyContradictions,
  typedStoryAcceptsBody,
  isInitialRodentTrapSetup,
  setupContradictions,
  countContradictions,
  activityLevelContradictions,
  levelBandForScore,
  normalizeWordNumbers,
  findingsSchemaForType,
};
