import { describe, expect, it } from 'vitest';
import * as projectTypesModule from '../../../../server/services/project-types.js';
import { PROJECT_APPLICATION_EVIDENCE, applicatorIdLine, projectAppliedProduct } from './PoisonControlCopy';

const PROJECT_TYPES = projectTypesModule.PROJECT_TYPES || projectTypesModule.default?.PROJECT_TYPES;

describe('PROJECT_APPLICATION_EVIDENCE stays pinned to the project-type registry', () => {
  it('every evidence field and option exists on that type in server/services/project-types.js', () => {
    for (const [type, rules] of Object.entries(PROJECT_APPLICATION_EVIDENCE)) {
      const config = PROJECT_TYPES[type];
      expect(config, type).toBeTruthy();
      if (rules === true) continue;
      for (const { field, values } of rules) {
        const def = (config.findingsFields || []).find((f) => f.key === field);
        expect(def, `${type}.${field}`).toBeTruthy();
        for (const value of values || []) {
          // chips are stored comma-joined — an option containing a comma
          // could never match after the split
          expect(value, `${type}.${field}`).not.toContain(',');
          expect(def.options, `${type}.${field}: "${value}"`).toContain(value);
        }
      }
    }
  });
});

describe('projectAppliedProduct — recorded evidence, not the project type', () => {
  it('a treatment the tech recorded carries the line', () => {
    expect(projectAppliedProduct('flea', { treatment_completed: 'Inspection only, Interior flea treatment' })).toBe(true);
    expect(projectAppliedProduct('tree_shrub', { treatments_completed: ['Inspection only', 'Fertilizer'] })).toBe(true);
    expect(projectAppliedProduct('termite_treatment', { products_used: 'Termidor SC' })).toBe(true);
    expect(projectAppliedProduct('rodent_sanitation', { sanitation_work_completed: 'Removed droppings, Disinfected / sanitized affected areas' })).toBe(true);
    // the bed-bug follow-up visit counts too
    expect(projectAppliedProduct('bed_bug', { treatment_method: 'Heat only' }, { work_completed: 'Baseboard treatment' })).toBe(true);
  });

  it('inspection-only, deferred, heat-only and non-disinfecting visits do not', () => {
    expect(projectAppliedProduct('flea', { treatment_completed: 'Inspection only' })).toBe(false);
    expect(projectAppliedProduct('one_time_lawn_treatment', { work_completed: 'Inspection completed' })).toBe(false);
    expect(projectAppliedProduct('one_time_pest_treatment', { work_completed: 'Treatment deferred', products_used: 'None' })).toBe(false);
    expect(projectAppliedProduct('bed_bug', { treatment_method: 'Heat only', work_completed: 'Steam treatment' })).toBe(false);
    expect(projectAppliedProduct('rodent_sanitation', { sanitation_work_completed: 'Removed droppings' })).toBe(false);
    expect(projectAppliedProduct('termite_treatment', { treatment_method: 'Cartridge replacement' })).toBe(false);
    expect(projectAppliedProduct('flea', {})).toBe(false);
  });

  it('rodent bait stations always carry it; other project types never do', () => {
    expect(projectAppliedProduct('rodent_bait_station', {})).toBe(true);
    for (const type of ['wdo_inspection', 'pre_treatment_termite_certificate', 'termite_bait_station', 'pest_inspection', 'rodent_exclusion', 'rodent_trapping']) {
      expect(projectAppliedProduct(type, { products_used: 'Termidor SC', work_completed: 'Bait placement' }), type).toBe(false);
    }
  });
});

describe('applicatorIdLine', () => {
  it('prints the name and ID card number, the number alone without a name, nothing without a number', () => {
    expect(applicatorIdLine('Adam', 'JE000001')).toBe('Applicator: Adam · FDACS ID card #JE000001');
    expect(applicatorIdLine('', 'JE000001')).toBe('Applicator FDACS ID card #JE000001');
    expect(applicatorIdLine('Adam', null)).toBeNull();
    expect(applicatorIdLine('Adam', '  ')).toBeNull();
  });
});
