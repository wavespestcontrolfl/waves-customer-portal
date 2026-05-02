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
};

const PROJECT_TYPE_KEYS = Object.keys(PROJECT_TYPES);

function getProjectType(key) {
  return PROJECT_TYPES[key] || null;
}

function isValidProjectType(key) {
  return Object.prototype.hasOwnProperty.call(PROJECT_TYPES, key);
}

module.exports = { PROJECT_TYPES, PROJECT_TYPE_KEYS, getProjectType, isValidProjectType };
