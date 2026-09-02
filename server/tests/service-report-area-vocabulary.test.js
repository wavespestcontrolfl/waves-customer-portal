const { PROJECT_TYPES } = require('../services/project-types');

const EDITABLE_TREATMENT_FIELDS = {
  flea: 'areas_treated',
  cockroach: 'areas_treated',
  german_roach_knockdown: 'areas_treated',
  palmetto_roach_knockdown: 'areas_treated',
  one_time_pest_treatment: 'areas_treated',
  one_time_lawn_treatment: 'spot_treatment_areas',
  mosquito_event: 'treatment_zones',
  palm_injection: 'areas_treated',
  tree_shrub: 'areas_treated',
  termite_treatment: 'areas_treated',
  bed_bug: 'areas_treated',
};

describe('editable service-report area vocabulary', () => {
  test.each(Object.entries(EDITABLE_TREATMENT_FIELDS))(
    '%s has a dedicated dropdown-backed treatment-area field',
    (type, fieldKey) => {
      const field = PROJECT_TYPES[type].findingsFields.find(({ key }) => key === fieldKey);
      expect(field).toBeDefined();
      expect(['chips', 'multi_select']).toContain(field.type);
      expect(field.options.length).toBeGreaterThanOrEqual(7);
      expect(field.options.every((option) => typeof option === 'string' && option.trim() && !option.includes(','))).toBe(true);
    },
  );

  test('inspection and rodent work keep their truthful location semantics', () => {
    expect(PROJECT_TYPES.pest_inspection.findingsFields.find(({ key }) => key === 'areas_inspected')?.type).toBe('chips');
    expect(PROJECT_TYPES.rodent_inspection.findingsFields.find(({ key }) => key === 'areas_inspected')?.type).toBe('chips');
    expect(PROJECT_TYPES.rodent_sanitation.findingsFields.find(({ key }) => key === 'sanitation_areas')?.label).toBe('Areas serviced');
    expect(PROJECT_TYPES.rodent_exclusion.findingsFields.find(({ key }) => key === 'entry_points_addressed')).toBeDefined();
    expect(PROJECT_TYPES.rodent_trapping.findingsFields.find(({ key }) => key === 'trap_activity_locations')).toBeDefined();
  });

  test('protected compliance documents are outside this treatment-area contract', () => {
    expect(EDITABLE_TREATMENT_FIELDS).not.toHaveProperty('wdo_inspection');
    expect(EDITABLE_TREATMENT_FIELDS).not.toHaveProperty('pre_treatment_termite_certificate');
  });
});
