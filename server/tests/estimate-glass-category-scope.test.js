// Regression for Codex P2 on PR #2373: an engine-inputs-only estimate with
// both pest and lawn has no persisted recurring/one-time rows, and
// deriveServiceCategory aggregates 2+ inferred services to 'bundle' — the
// eligibility check must expand the engine-input services into their
// underlying categories instead of falling back to that aggregate, or an
// in-scope pest+lawn bundle stays on the old page.
const { glassCategoryEligible, deriveServiceCategory } = require('../routes/estimate-public');

const PEST_LAWN_SCOPE = ['pest_control', 'lawn_care'];

describe('glassCategoryEligible service-category scope (GATE_ESTIMATE_GLASS_CATEGORIES)', () => {
  test('empty scope list releases every estimate', () => {
    expect(glassCategoryEligible({}, [], [], 'mosquito', [])).toBe(true);
  });

  test('persisted recurring rows: pest+lawn bundle is in scope, pest+mosquito is not', () => {
    const pestLawn = [{ service: 'pest_control' }, { service: 'lawn_care' }];
    const pestMosquito = [{ service: 'pest_control' }, { service: 'mosquito' }];
    expect(glassCategoryEligible({}, pestLawn, [], 'bundle', PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible({}, pestMosquito, [], 'bundle', PEST_LAWN_SCOPE)).toBe(false);
  });

  test('engine-inputs-only pest+lawn bundle is in scope even though the derived category is bundle', () => {
    const estData = { engineInputs: { services: { pest: true, lawn: true } } };
    expect(deriveServiceCategory(estData, [], [])).toBe('bundle');
    expect(glassCategoryEligible(estData, [], [], 'bundle', PEST_LAWN_SCOPE)).toBe(true);
  });

  test('engine-inputs-only pest+mosquito stays out of scope (bundle expansion must not widen the release)', () => {
    const estData = { engineInputs: { services: { pest: true, mosquito: true } } };
    expect(deriveServiceCategory(estData, [], [])).toBe('bundle');
    expect(glassCategoryEligible(estData, [], [], 'bundle', PEST_LAWN_SCOPE)).toBe(false);
  });

  test('engine-inputs-only single lawn service is in scope, single termite is not', () => {
    const lawnOnly = { inputs: { services: { lawn: true } } };
    const termiteOnly = { inputs: { services: { termiteBait: true } } };
    expect(glassCategoryEligible(lawnOnly, [], [], 'lawn_care', PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible(termiteOnly, [], [], 'termite_bait', PEST_LAWN_SCOPE)).toBe(false);
  });

  test('nothing inferable falls back to the derived category the page renders', () => {
    expect(glassCategoryEligible({}, [], [], 'pest_control', PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible({}, [], [], 'mosquito', PEST_LAWN_SCOPE)).toBe(false);
  });
});
