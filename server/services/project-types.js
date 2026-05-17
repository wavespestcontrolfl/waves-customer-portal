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

const PROJECT_TYPES = {
  wdo_inspection: {
    label: 'WDO Inspection',
    short: 'WDO',
    description: 'FDACS-13645 wood-destroying organism inspection report for real estate / pre-purchase files.',
    requiresFollowup: false,
    photoCategories: ['exterior', 'living_area', 'kitchen', 'bathroom', 'garage', 'attic', 'crawlspace', 'other'],
    findingsFields: [
      { key: 'property_address', label: 'Property inspected', type: 'text', placeholder: 'Street address, city, state, ZIP' },
      { key: 'structures_inspected', label: 'Structure(s) inspected', type: 'textarea', placeholder: 'Main home, detached garage, shed, addition…' },
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
      { key: 'organism_treated', label: 'Organism treated', type: 'text', placeholder: 'Common name of organism, if treated' },
      { key: 'pesticide_used', label: 'Pesticide used', type: 'text', placeholder: 'Name of pesticide, if treated' },
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
      { key: 'treatment_address', label: 'Treatment address', type: 'text', placeholder: 'Street, city, state, ZIP' },
      { key: 'lot_block', label: 'Lot / Block', type: 'text', placeholder: 'Lot 12, Block C (pre-construction lots)' },
      { key: 'subdivision', label: 'Subdivision / Community', type: 'text', placeholder: 'e.g. Lakewood Ranch — Star Farms' },
      { key: 'permit_number', label: 'Building permit #', type: 'text', placeholder: 'Issued by the building department' },
      { key: 'builder_contractor', label: 'Builder / General contractor', type: 'text' },
      { key: 'treatment_date', label: 'Date of treatment', type: 'text', placeholder: 'YYYY-MM-DD' },
      { key: 'treatment_time', label: 'Time of treatment', type: 'text', placeholder: 'e.g. 9:30 AM' },
      { key: 'treatment_method', label: 'Method of treatment', type: 'select', options: ['Soil barrier (chemical)', 'Wood treatment (borate)', 'Bait system', 'Other'] },
      { key: 'treatment_method_other', label: 'Method description (if Other)', type: 'text' },
      { key: 'wdo_target', label: 'Wood-destroying organism treated for', type: 'text', placeholder: 'e.g. Subterranean termites (Reticulitermes spp.)' },
      { key: 'product_name', label: 'Product used', type: 'select', options: ['Termidor SC', 'Talstar P', 'Premise 2', 'Trelona ATBB', 'Bora-Care', 'Other'] },
      { key: 'product_name_other', label: 'Product (if Other)', type: 'text' },
      { key: 'epa_registration', label: 'EPA registration #', type: 'text', placeholder: 'e.g. 7969-210' },
      { key: 'active_ingredient', label: 'Active ingredient', type: 'text', placeholder: 'e.g. fipronil' },
      { key: 'concentration_pct', label: 'Concentration (%)', type: 'text', placeholder: 'e.g. 0.060' },
      { key: 'square_footage', label: 'Square footage treated', type: 'text' },
      { key: 'linear_feet', label: 'Linear feet treated', type: 'text', placeholder: 'For trenching / perimeter applications' },
      { key: 'gallons_applied', label: 'Gallons of finished solution applied', type: 'text' },
      { key: 'applicator_name', label: "Applicator's printed name", type: 'text' },
      { key: 'applicator_fdacs_id', label: 'Applicator FDACS ID #', type: 'text' },
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
