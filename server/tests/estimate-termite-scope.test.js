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
