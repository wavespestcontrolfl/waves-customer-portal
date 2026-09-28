jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { TERMITE_SCOPE, classifyTermiteScope } = require('../../shared/estimate-termite-scope.cjs');
const { detectServiceCategory } = require('../utils/service-normalizer');
const { serviceMixMakesNoGuaranteeClaim } = require('../routes/estimate-public');

const PEST = [{ service: 'pest_control', name: 'Pest Control', mo: 55 }];
const charge = (service, label) => ({ service, label, amount: 250, kind: 'charge' });

describe('shared estimate termite-scope classification', () => {
  test.each([
    ['WDO Inspection', TERMITE_SCOPE.WDO],
    ['Wood Destroying Organism Report', TERMITE_SCOPE.WDO],
    ['pre_slab_termiticide', TERMITE_SCOPE.PRE_SLAB],
    ['Slab Pre-Treat Service', TERMITE_SCOPE.PRE_SLAB],
    ['Termite Foam Treatment', TERMITE_SCOPE.FOAM],
    ['Termidor Foam Treatment', TERMITE_SCOPE.FOAM],
    ['Foam Drill Treatment', TERMITE_SCOPE.RECURRING_FOAM],
    ['Drill & Foam Treatment', TERMITE_SCOPE.RECURRING_FOAM],
    ['Recurring Foam Treatment (Quarterly)', TERMITE_SCOPE.RECURRING_FOAM],
    // Legacy engine-backed labels with no separator (Codex #5195 r1).
    ['FoamRecurring', TERMITE_SCOPE.RECURRING_FOAM],
    ['RecurringFoam', TERMITE_SCOPE.RECURRING_FOAM],
    ['FoamDrill', TERMITE_SCOPE.RECURRING_FOAM],
    ['DrillAndFoam', TERMITE_SCOPE.RECURRING_FOAM],
    ['TermidorFoam', TERMITE_SCOPE.FOAM],
    ['Termite Foaming Service (Quarterly)', TERMITE_SCOPE.FOAM],
    // "Foam" away from the termite word is termite work, not the verbatim
    // foam label the schedule keeps (the replaced regex's adjacency rule).
    ['Termite Treatment (Foam)', TERMITE_SCOPE.TERMITE],
    ['Bora-Care Foam Application', TERMITE_SCOPE.TERMITE],
    // "Sealing" alone never demotes a drill/recurring foam form.
    ['Drill & Foam Treatment – Seal Holes', TERMITE_SCOPE.RECURRING_FOAM],
    // The termite word beside a drill/recurring foam form keeps the foam scope.
    ['Drill-and-Foam Termite Treatment', TERMITE_SCOPE.RECURRING_FOAM],
    ['Recurring Termite Foam Service (Quarterly)', TERMITE_SCOPE.FOAM],
    ['Bora-Care Wood Treatment', TERMITE_SCOPE.TERMITE],
    ['BoraCare Wood Treatment', TERMITE_SCOPE.TERMITE],
    ['Borate Wood Treatment', TERMITE_SCOPE.TERMITE],
    ['Trelona Bait Monitoring', TERMITE_SCOPE.TERMITE],
    ['Liquid termiticide treatment', TERMITE_SCOPE.TERMITE],
  ])('%s has one shared termite scope', (name, scope) => {
    expect(classifyTermiteScope(name)).toBe(scope);
    expect(detectServiceCategory(name)).toBe('termite');
    // Use an otherwise eligible pest key so the label classifier, rather
    // than an unknown/termite-bearing key, is what makes the estimate neutral.
    expect(serviceMixMakesNoGuaranteeClaim(PEST, [charge('one_time_pest', name)])).toBe(true);
  });

  test.each([
    'Rodent Exclusion – Foam Sealing',
    'Foam Sealing Follow-Up (Rodent)',
    'Plain Foam Treatment',
  ])('%s is not inferred as termite scope', (name) => {
    expect(classifyTermiteScope(name)).toBeNull();
  });

  test('normalizeServiceType keeps only the verbatim foam labels the old rule kept', () => {
    const { normalizeServiceType } = require('../utils/service-normalizer');
    expect(normalizeServiceType('Termite Foaming Service (Quarterly)')).toBe('Termite Foaming Service (Quarterly)');
    expect(normalizeServiceType('Drill & Foam Treatment – Seal Holes')).toBe('Drill & Foam Treatment – Seal Holes');
    expect(normalizeServiceType('Termite Treatment (Foam)')).toBe('Termite Treatment');
    expect(normalizeServiceType('Drill-and-Foam Termite Treatment (Quarterly)')).toBe('Drill-and-Foam Termite Treatment (Quarterly)');
    expect(normalizeServiceType('Drill-and-Foam Termite Treatment')).toBe('Drill-and-Foam Termite Treatment');
    expect(normalizeServiceType('Bora-Care Foam Application')).not.toBe('Bora-Care Foam Application');
  });

  test('primary scheduling category precedence stays separate from guarantee scope', () => {
    for (const [name, primary] of [
      ['Lawn Care and Termite Bait Monitoring', 'lawn'],
      ['Mosquito and Termite Bait Monitoring', 'mosquito'],
      ['Tree & Shrub Bora-Care Treatment', 'tree_shrub'],
    ]) {
      expect(detectServiceCategory(name)).toBe(primary);
      expect(classifyTermiteScope(name)).not.toBeNull();
      expect(serviceMixMakesNoGuaranteeClaim([{ name, mo: 55 }], [])).toBe(true);
    }
  });

  test('rodent foam remains rodent and keeps ordinary pest-plan terms', () => {
    const rows = [
      charge('rodent_exclusion', 'Rodent Exclusion – Foam Sealing'),
      charge('rodent_exclusion_followup', 'Foam Sealing Follow-Up (Rodent)'),
    ];
    expect(rows.map((row) => detectServiceCategory(row.label))).toEqual(['rodent', 'rodent']);
    expect(serviceMixMakesNoGuaranteeClaim(PEST, rows)).toBe(false);
  });
});
