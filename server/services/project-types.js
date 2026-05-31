/**
 * Project types registry — declarative config for the Projects feature.
 *
 * Each type defines its label, whether it supports a follow-up visit, the
 * photo categories the tech picks from, and the structured findings fields
 * that render into the form and the customer-facing report.
 *
 * Adding a new type = add a row here + seed a report section in
 * client/src/pages/ReportViewPage.jsx. No schema change required.
 */

const WDO_TARGET_OPTIONS = [
  'Subterranean termites',
  'Formosan subterranean termites',
  'Drywood termites',
  'Dampwood termites',
  'Powderpost beetles',
  'Old house borers',
  'Wood-decay fungi',
  'Wood-destroying beetles',
  'Other',
];

const PROJECT_TYPES = {
  wdo_inspection: {
    label: 'WDO Inspection',
    short: 'WDO',
    description: 'FDACS-13645 wood-destroying organism inspection report for real estate / pre-purchase files.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'living_area', 'kitchen', 'bathroom', 'garage', 'attic', 'crawlspace', 'previous_treatment', 'other'],
    findingsFields: [
      { key: 'property_address', label: 'Property inspected', type: 'text', placeholder: 'Street address, city, state, ZIP' },
      { key: 'structures_inspected', label: 'Structure(s) inspected', type: 'textarea', placeholder: 'Main home, detached garage, shed, addition…' },
      { key: 'structure_sqft', label: 'Structure footprint (approx. sq ft)', type: 'text', placeholder: 'Under-roof area, e.g. 2200 — used for the fee tier if no fee is picked' },
      { key: 'inspection_fee', label: 'Inspection fee ($)', type: 'text', placeholder: 'Any amount, e.g. 175 — varies by construction (wood frame), new build, prior termite history' },
      { key: 'requested_by', label: 'Inspection requested by', type: 'text', placeholder: 'Name and contact information' },
      { key: 'report_sent_to', label: 'Report sent to', type: 'text', placeholder: 'Name and contact information if different' },
      { key: 'inspection_scope', label: 'Visible / accessible areas inspected', type: 'textarea', placeholder: 'Interior, attic access, garage, exterior perimeter, crawlspace…' },
      { key: 'wdo_finding', label: 'FDACS Section 2 finding', type: 'select', options: ['No visible signs of WDO observed', 'Visible evidence of WDO observed'] },
      { key: 'live_wdo', label: 'Live WDO(s)', type: 'textarea', placeholder: 'Common name of organism and location, if any' },
      { key: 'wdo_evidence', label: 'Evidence of WDO(s)', type: 'textarea', placeholder: 'Dead insects/parts, frass, shelter tubes, exit holes, description and location' },
      { key: 'wdo_damage', label: 'Damage caused by WDO(s)', type: 'textarea', placeholder: 'Common name, description, and location of visible damage' },
      { key: 'inaccessible_areas', label: 'Obstructions / inaccessible areas', type: 'textarea', placeholder: 'Attic, interior, exterior, crawlspace, other: specific areas and reasons' },
      { key: 'previous_treatment_evidence', label: 'Evidence of previous treatment', type: 'select', options: ['No', 'Yes'] },
      { key: 'previous_treatment_notes', label: 'Previous treatment observations', type: 'textarea', placeholder: 'Visible evidence suggesting possible previous treatment' },
      { key: 'notice_location', label: 'Notice of Inspection location', type: 'text', placeholder: 'Where the notice was affixed to the structure' },
      { key: 'treated_at_inspection', label: 'Treated at time of inspection', type: 'select', options: ['No', 'Yes'] },
      { key: 'organism_treated', label: 'Organism treated', type: 'multi_select', options: WDO_TARGET_OPTIONS },
      { key: 'pesticide_used', label: 'Pesticide used', type: 'product_search', placeholder: 'Search product catalog or type product name' },
      { key: 'treatment_terms', label: 'Treatment terms and conditions', type: 'textarea' },
      { key: 'treatment_method', label: 'Treatment method', type: 'select', options: ['Whole structure', 'Spot treatment', 'Not applicable'] },
      { key: 'treatment_notice_location', label: 'Treatment notice location', type: 'text' },
      { key: 'comments', label: 'Comments / financial disclosure notes', type: 'textarea', placeholder: 'Additional FDACS Section 5 comments' },
    ],
  },

  termite_inspection: {
    label: 'Termite Inspection',
    short: 'Termite',
    description: 'Standalone termite inspection (not for real-estate transactions — use WDO for those).',
    requiresFollowup: false,
    photoCategories: ['exterior', 'foundation', 'garage', 'attic', 'crawlspace', 'evidence', 'other'],
    findingsFields: [
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea' },
      { key: 'termite_type', label: 'Termite species (if found)', type: 'select', options: ['None observed', 'Eastern subterranean', 'Formosan', 'Drywood', 'Dampwood', 'Unknown — sample collected'] },
      { key: 'activity_status', label: 'Activity status', type: 'select', options: ['No activity', 'Old / inactive damage', 'Active infestation'] },
      { key: 'infestation_extent', label: 'Infestation extent', type: 'textarea' },
      { key: 'treatment_recommendation', label: 'Recommended treatment', type: 'textarea' },
    ],
  },

  pest_inspection: {
    label: 'Pest Inspection',
    short: 'Pest',
    description: 'General pest survey (ants, roaches, spiders, etc.) — often pre-treatment scoping.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'kitchen', 'bathroom', 'garage', 'attic', 'entry_point', 'evidence', 'other'],
    findingsFields: [
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea' },
      { key: 'pests_identified', label: 'Pests identified', type: 'textarea', placeholder: 'e.g. German roaches (kitchen), ghost ants (bath #2)' },
      { key: 'severity', label: 'Severity', type: 'select', options: ['Low', 'Moderate', 'Heavy', 'Severe'] },
      { key: 'conducive_conditions', label: 'Conducive conditions', type: 'textarea' },
      { key: 'recommendation', label: 'Recommendation', type: 'textarea' },
    ],
  },

  flea: {
    label: 'Flea Service',
    short: 'Flea',
    description: 'Flea inspection, treatment notes, host pressure, and customer prep/follow-up documentation.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'living_area', 'bedroom', 'pet_area', 'yard', 'evidence', 'treatment_area', 'other'],
    findingsFields: [
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea', placeholder: 'Pet resting areas, rugs, furniture edges, bedrooms, yard, shaded exterior areas…' },
      { key: 'evidence_level', label: 'Evidence level', type: 'select', options: ['Low', 'Moderate', 'Heavy', 'Severe'] },
      { key: 'host_activity', label: 'Host / activity notes', type: 'textarea', placeholder: 'Pets in home, recent bites, wildlife pressure, shaded yard activity…' },
      { key: 'treatment_areas', label: 'Treatment areas', type: 'textarea', placeholder: 'Interior rooms, pet resting zones, exterior shaded areas, crawlspace, lanai…' },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'prep_for_customer', label: 'Customer prep / responsibilities', type: 'textarea', placeholder: 'Vacuuming, washing pet bedding, coordinating vet flea control, staying off treated areas until dry…' },
      { key: 'followup_plan', label: 'Follow-up plan', type: 'textarea' },
    ],
  },

  cockroach: {
    label: 'Cockroach Treatment',
    short: 'Cockroach',
    description: 'Cockroach inspection + treatment — species ID, harborage and conducive conditions, treatment notes, and customer prep.',
    requiresFollowup: false,
    photoCategories: ['kitchen', 'bathroom', 'interior', 'exterior', 'entry_point', 'harborage', 'evidence', 'treatment_area', 'other'],
    findingsFields: [
      { key: 'species', label: 'Species', type: 'select', options: ['German', 'American', 'Oriental', 'Brown-banded', 'Smoky brown', 'Mixed', 'Unknown'] },
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea', placeholder: 'Kitchen, bathrooms, under appliances, cabinets, drains, garage…' },
      { key: 'activity_level', label: 'Activity level', type: 'select', options: ['Low', 'Moderate', 'Heavy', 'Severe'] },
      { key: 'harborage_locations', label: 'Harborage locations', type: 'textarea', placeholder: 'Under/behind fridge, dishwasher, sink cabinet, pantry, wall voids…' },
      { key: 'conducive_conditions', label: 'Conducive conditions', type: 'textarea', placeholder: 'Moisture, food debris, clutter, cardboard, plumbing leaks…' },
      { key: 'treatment_performed', label: 'Treatment performed', type: 'textarea', placeholder: 'Gel bait, crack & crevice, IGR, dusting, vacuuming…' },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'prep_for_customer', label: 'Customer prep / responsibilities', type: 'textarea', placeholder: 'Reduce moisture, store food sealed, remove cardboard, avoid cleaning treated areas…' },
      { key: 'followup_plan', label: 'Follow-up plan', type: 'textarea' },
    ],
  },

  rodent_exclusion: {
    label: 'Rodent Exclusion',
    short: 'Rodent',
    description: 'Entry-point mapping, trapping, and exclusion work.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'entry_point', 'trap_placement', 'damage', 'exclusion_work', 'attic', 'crawlspace', 'other'],
    findingsFields: [
      { key: 'species', label: 'Species', type: 'select', options: ['Roof rat', 'Norway rat', 'House mouse', 'Mixed', 'Unknown'] },
      { key: 'entry_points_found', label: 'Entry points identified', type: 'textarea', placeholder: 'Dryer vent (S wall), gable vent (attic), garage door seal…' },
      { key: 'traps_set', label: 'Traps set (count + locations)', type: 'textarea' },
      { key: 'exclusion_completed', label: 'Exclusion work completed', type: 'textarea' },
      { key: 'exclusion_pending', label: 'Exclusion work pending', type: 'textarea' },
      { key: 'followup_plan', label: 'Follow-up plan', type: 'textarea' },
    ],
  },

  rodent_trapping: {
    label: 'Rodent Trapping',
    short: 'Rodent Trap',
    description: 'Active trapping setup, trap checks, activity findings, and follow-up plan.',
    requiresFollowup: true,
    photoCategories: ['trap_placement', 'entry_point', 'droppings', 'damage', 'attic', 'garage', 'crawlspace', 'other'],
    findingsFields: [
      { key: 'species', label: 'Species', type: 'select', options: ['Roof rat', 'Norway rat', 'House mouse', 'Mixed', 'Unknown'] },
      { key: 'activity_found', label: 'Activity found', type: 'textarea', placeholder: 'Droppings, rub marks, noises, entry trails, nesting evidence…' },
      { key: 'traps_set', label: 'Traps set (count + locations)', type: 'textarea', placeholder: '6 snap traps in attic, 2 glue boards in garage…' },
      { key: 'bait_or_products_used', label: 'Bait / products used', type: 'textarea' },
      { key: 'entry_points_observed', label: 'Entry points observed', type: 'textarea' },
      { key: 'sanitation_or_damage_notes', label: 'Sanitation / damage notes', type: 'textarea' },
      { key: 'followup_plan', label: 'Trap-check / follow-up plan', type: 'textarea', placeholder: 'Return in 3 days to check/reset traps; extend if activity continues.' },
    ],
  },

  wildlife_trapping: {
    label: 'Wildlife Trapping',
    short: 'Wildlife',
    description: 'Wildlife trap setup, monitoring notes, access points, and required daily check plan.',
    requiresFollowup: true,
    photoCategories: ['trap_placement', 'entry_point', 'damage', 'yard', 'attic', 'crawlspace', 'other'],
    findingsFields: [
      { key: 'target_animal', label: 'Target animal', type: 'text', placeholder: 'Armadillo, opossum, raccoon, unknown…' },
      { key: 'activity_found', label: 'Activity found', type: 'textarea' },
      { key: 'traps_set', label: 'Traps set (count + locations)', type: 'textarea' },
      { key: 'property_damage', label: 'Damage / disturbance', type: 'textarea' },
      { key: 'daily_check_plan', label: 'Daily check plan', type: 'textarea' },
      { key: 'customer_instructions', label: 'Customer instructions', type: 'textarea' },
    ],
  },

  one_time_pest_treatment: {
    label: 'One-Time Pest Treatment',
    short: 'One-Time Pest',
    description: 'Documentation for one-time pest cleanouts, removals, and specialty pest treatments.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'interior', 'kitchen', 'bathroom', 'garage', 'evidence', 'treatment_area', 'other'],
    findingsFields: [
      { key: 'target_pest', label: 'Target pest', type: 'text', placeholder: 'German roaches, wasps, fire ants, fleas/ticks…' },
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea' },
      { key: 'activity_level', label: 'Activity level', type: 'select', options: ['Low', 'Moderate', 'Heavy', 'Severe'] },
      { key: 'treatment_performed', label: 'Treatment performed', type: 'textarea' },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'customer_instructions', label: 'Customer instructions', type: 'textarea' },
      { key: 'followup_plan', label: 'Follow-up plan', type: 'textarea' },
    ],
  },

  one_time_lawn_treatment: {
    label: 'One-Time Lawn Treatment',
    short: 'One-Time Lawn',
    description: 'Standalone lawn assessment or treatment documentation outside the recurring WaveGuard flow.',
    requiresFollowup: false,
    photoCategories: ['front_yard', 'back_yard', 'side_yard', 'problem_area', 'weeds', 'disease', 'insects', 'other'],
    findingsFields: [
      { key: 'turf_type', label: 'Turf type', type: 'select', options: ['St. Augustine', 'Bahia', 'Zoysia', 'Bermuda', 'Centipede', 'Mixed', 'Unknown'] },
      { key: 'areas_treated', label: 'Areas treated / assessed', type: 'textarea' },
      { key: 'condition_found', label: 'Condition found', type: 'textarea' },
      { key: 'treatment_performed', label: 'Treatment performed', type: 'textarea' },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'irrigation_or_cultural_notes', label: 'Irrigation / cultural notes', type: 'textarea' },
      { key: 'followup_plan', label: 'Follow-up plan', type: 'textarea' },
    ],
  },

  mosquito_event: {
    label: 'Mosquito Event Spray',
    short: 'Mosquito Event',
    description: 'One-time mosquito event treatment documentation and weather/site notes.',
    requiresFollowup: false,
    photoCategories: ['yard', 'foliage', 'pool_area', 'lanai', 'standing_water', 'equipment', 'other'],
    findingsFields: [
      { key: 'event_context', label: 'Event / service context', type: 'textarea' },
      { key: 'areas_treated', label: 'Areas treated', type: 'textarea' },
      { key: 'standing_water_sources', label: 'Standing water / breeding sources', type: 'textarea' },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'weather_notes', label: 'Weather notes', type: 'textarea' },
      { key: 'customer_instructions', label: 'Customer instructions', type: 'textarea' },
    ],
  },

  palm_injection: {
    label: 'Palm Injection',
    short: 'Palm Injection',
    description: 'Standalone palm injection treatment documentation.',
    requiresFollowup: false,
    photoCategories: ['palm', 'trunk', 'canopy', 'injection_site', 'disease', 'other'],
    findingsFields: [
      { key: 'palm_species', label: 'Palm species', type: 'text' },
      { key: 'palm_count', label: 'Palm count', type: 'text' },
      { key: 'condition_found', label: 'Condition found', type: 'textarea' },
      { key: 'treatment_performed', label: 'Treatment performed', type: 'textarea' },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'followup_plan', label: 'Follow-up / retreatment plan', type: 'textarea' },
    ],
  },

  termite_treatment: {
    label: 'Termite Treatment',
    short: 'Termite Treatment',
    description: 'Termite treatment documentation for spot treatment, liquid treatment, trenching, cartridge work, and setup visits.',
    requiresFollowup: false,
    photoCategories: ['foundation', 'trench', 'drill_point', 'station', 'damage', 'treatment_area', 'before', 'after', 'other'],
    findingsFields: [
      { key: 'target_termite', label: 'Target termite / WDO', type: 'select', options: ['Subterranean termites', 'Formosan subterranean termites', 'Drywood termites', 'Unknown / preventive'] },
      { key: 'areas_treated', label: 'Areas treated', type: 'textarea' },
      { key: 'treatment_method', label: 'Treatment method', type: 'select', options: ['Spot treatment', 'Liquid perimeter', 'Trenching', 'Bait station setup', 'Cartridge replacement', 'Wood treatment', 'Other'] },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'linear_feet_or_stations', label: 'Linear feet / stations', type: 'textarea' },
      { key: 'gallons_or_amount', label: 'Gallons / amount applied', type: 'textarea' },
      { key: 'followup_plan', label: 'Follow-up / warranty plan', type: 'textarea' },
    ],
  },

  bed_bug: {
    label: 'Bed Bug Treatment',
    short: 'Bed Bug',
    description: 'Bed-bug inspection + initial treatment. Supports an optional 14-day follow-up.',
    requiresFollowup: true,
    photoCategories: ['bedroom', 'evidence', 'equipment', 'room_treated', 'furniture', 'other'],
    findingsFields: [
      { key: 'rooms_treated', label: 'Rooms treated', type: 'textarea', placeholder: 'Master bedroom, guest bedroom, living room couch' },
      { key: 'evidence_level', label: 'Evidence level', type: 'select', options: ['Low (few bugs)', 'Moderate', 'Heavy', 'Severe infestation'] },
      { key: 'treatment_method', label: 'Treatment method', type: 'select', options: ['Chemical only', 'Heat only', 'Chemical + heat', 'Steam + chemical'] },
      { key: 'products_used', label: 'Products used', type: 'textarea' },
      { key: 'prep_for_customer', label: 'Customer prep for follow-up', type: 'textarea', placeholder: 'Instructions for the customer before the 14-day return visit.' },
    ],
  },

  pre_treatment_termite_certificate: {
    label: 'Pre-Treatment Certificate of Compliance',
    short: 'Pre-Treat Cert',
    description: 'Florida Building Code 1816.1.7 Certificate of Compliance for pre-construction subterranean termite soil treatment. Doubles as the FDACS Rule 5E-14.106 treatment record.',
    requiresFollowup: false,
    photoCategories: ['slab_prep', 'soil_treatment', 'perimeter', 'equipment', 'before', 'after', 'other'],
    findingsFields: [
      { key: 'treatment_address', label: 'Treatment address', type: 'address', placeholder: 'Start typing the treatment address' },
      { key: 'lot_block', label: 'Lot / Block', type: 'text', placeholder: 'Lot 12, Block C (pre-construction lots)' },
      { key: 'subdivision', label: 'Subdivision / Community', type: 'text', placeholder: 'e.g. Lakewood Ranch — Star Farms' },
      { key: 'permit_number', label: 'Building permit #', type: 'text', placeholder: 'Issued by the building department' },
      { key: 'builder_contractor', label: 'Builder / General contractor', type: 'customer_search', placeholder: 'Search customer database or type contractor name' },
      { key: 'treatment_date', label: 'Date of treatment', type: 'date' },
      { key: 'treatment_time', label: 'Time of treatment', type: 'time' },
      { key: 'treatment_method', label: 'Method of treatment', type: 'select', options: ['Soil barrier (chemical)', 'Wood treatment (borate)', 'Bait system', 'Other'] },
      { key: 'treatment_method_other', label: 'Method description (if Other)', type: 'text' },
      { key: 'wdo_target', label: 'Wood-destroying organism treated for', type: 'multi_select', options: WDO_TARGET_OPTIONS },
      { key: 'product_name', label: 'Product used', type: 'product_search', placeholder: 'Search product catalog or type product name', options: ['Termidor SC', 'Talstar P', 'Premise 2', 'Trelona ATBB', 'Bora-Care', 'Other'] },
      { key: 'product_name_other', label: 'Product (if Other)', type: 'text' },
      { key: 'epa_registration', label: 'EPA registration #', type: 'text', placeholder: 'e.g. 7969-210' },
      { key: 'active_ingredient', label: 'Active ingredient', type: 'text', placeholder: 'e.g. fipronil' },
      { key: 'concentration_pct', label: 'Concentration (%)', type: 'text', placeholder: 'e.g. 0.060' },
      { key: 'square_footage', label: 'Square footage treated', type: 'text' },
      { key: 'linear_feet', label: 'Linear feet treated', type: 'text', placeholder: 'For trenching / perimeter applications' },
      { key: 'gallons_applied', label: 'Gallons of finished solution applied', type: 'text' },
      { key: 'applicator_name', label: "Applicator's printed name", type: 'text' },
      { key: 'applicator_fdacs_id', label: 'Applicator FDACS ID #', type: 'text' },
      // FBC 1816.1.7 requires an "authorized signature of the licensed
      // applicator." A typed attestation paired with the printed name +
      // FDACS ID + treatment date is the standard pattern for portal-
      // generated certificates accepted by Florida building departments.
      { key: 'applicator_attestation', label: 'Applicator attestation', type: 'select', options: ['I am the licensed Florida applicator who performed the treatment described above, and I certify the information is true and complete (FBC 1816.1.7 / FDACS Rule 5E-14.106).'] },
      { key: 'warranty_type', label: 'Warranty / retreatment bond', type: 'select', options: ['Builder 1-year', 'Renewable 5-year retreatment bond', 'Renewable 10-year retreatment bond', 'No warranty'] },
      { key: 'renewal_due', label: 'Renewal due by', type: 'text', placeholder: 'YYYY-MM-DD' },
      { key: 'comments', label: 'Additional notes', type: 'textarea', placeholder: 'Pre-pour conditions, weather, retreatment triggers, etc.' },
    ],
  },
};

const PROJECT_TYPE_KEYS = Object.keys(PROJECT_TYPES);

function getProjectType(key) {
  return PROJECT_TYPES[key] || null;
}

function isValidProjectType(key) {
  return Object.prototype.hasOwnProperty.call(PROJECT_TYPES, key);
}

module.exports = { PROJECT_TYPES, PROJECT_TYPE_KEYS, getProjectType, isValidProjectType };
