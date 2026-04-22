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
    description: 'Wood-destroying organism inspection (real estate / pre-purchase).',
    requiresFollowup: false,
    photoCategories: ['exterior', 'living_area', 'kitchen', 'bathroom', 'garage', 'attic', 'crawlspace', 'other'],
    findingsFields: [
      { key: 'areas_inspected', label: 'Areas inspected', type: 'textarea', placeholder: 'Crawlspace, attic, garage, exterior perimeter…' },
      { key: 'evidence_type', label: 'Evidence found', type: 'select', options: ['None — clean', 'Subterranean termite', 'Drywood termite', 'Wood-decay fungi', 'Carpenter ant', 'Powderpost beetle', 'Multiple — see notes'] },
      { key: 'evidence_location', label: 'Evidence location', type: 'text', placeholder: 'e.g. SE corner of garage, near water heater' },
      { key: 'moisture_issues', label: 'Moisture / conducive conditions', type: 'textarea', placeholder: 'Water staining, grade, plumbing leaks, etc.' },
      { key: 'treatment_recommendation', label: 'Treatment recommendation', type: 'select', options: ['None required', 'Monitoring recommended', 'Treatment recommended', 'Further inspection recommended'] },
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
