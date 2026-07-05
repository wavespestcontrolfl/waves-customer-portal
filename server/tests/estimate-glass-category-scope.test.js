// Regressions for Codex P2s on PR #2373 (rounds 1-2):
// r1 — an engine-inputs-only pest+lawn estimate has no persisted rows and
//   deriveServiceCategory aggregates 2+ inferred services to 'bundle'; the
//   eligibility check must expand the underlying engine-input categories.
// r2a — a generated one-time add-on (e.g. pest_initial_roach) makes the
//   collected set non-empty, so the engine inputs were never consulted and an
//   out-of-scope service could hide behind an in-scope add-on; without
//   persisted recurring rows the engine-input categories must be unioned in.
// r2b — an estimate neither classifier understands (e.g. a WDO inspection)
//   must fail closed under a scoped release instead of riding
//   deriveServiceCategory's pest_control default into glass.
const { glassCategoryEligible, deriveServiceCategory } = require('../routes/estimate-public');

const PEST_LAWN_SCOPE = ['pest_control', 'lawn_care'];

describe('glassCategoryEligible service-category scope (GATE_ESTIMATE_GLASS_CATEGORIES)', () => {
  test('empty scope list releases every estimate', () => {
    expect(glassCategoryEligible({}, [], [], [])).toBe(true);
  });

  test('persisted recurring rows: pest+lawn bundle is in scope, pest+mosquito is not', () => {
    const pestLawn = [{ service: 'pest_control' }, { service: 'lawn_care' }];
    const pestMosquito = [{ service: 'pest_control' }, { service: 'mosquito' }];
    expect(glassCategoryEligible({}, pestLawn, [], PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible({}, pestMosquito, [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('engine-inputs-only pest+lawn bundle is in scope even though the derived category is bundle', () => {
    const estData = { engineInputs: { services: { pest: true, lawn: true } } };
    expect(deriveServiceCategory(estData, [], [])).toBe('bundle');
    expect(glassCategoryEligible(estData, [], [], PEST_LAWN_SCOPE)).toBe(true);
  });

  test('engine-inputs-only pest+mosquito stays out of scope (bundle expansion must not widen the release)', () => {
    const estData = { engineInputs: { services: { pest: true, mosquito: true } } };
    expect(glassCategoryEligible(estData, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('engine-inputs-only single lawn service is in scope, single termite is not', () => {
    const lawnOnly = { inputs: { services: { lawn: true } } };
    const termiteOnly = { inputs: { services: { termiteBait: true } } };
    expect(glassCategoryEligible(lawnOnly, [], [], PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible(termiteOnly, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r2a: an out-of-scope engine-input service cannot hide behind an in-scope one-time add-on', () => {
    const estData = { engineInputs: { services: { pest: true, mosquito: true } } };
    const roachAddOn = [{ service: 'pest_initial_roach', name: 'German Roach Clean-Out' }];
    expect(glassCategoryEligible(estData, [], roachAddOn, PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r2a: an in-scope add-on alongside in-scope engine inputs still releases', () => {
    const estData = { engineInputs: { services: { pest: true, lawn: true } } };
    const roachAddOn = [{ service: 'pest_initial_roach', name: 'German Roach Clean-Out' }];
    expect(glassCategoryEligible(estData, [], roachAddOn, PEST_LAWN_SCOPE)).toBe(true);
  });

  test('persisted recurring rows are authoritative — engine inputs are not unioned when rows exist', () => {
    // Rows exist for every selected recurring service; a stale/extra engine
    // input must not conservatively withhold glass from a persisted estimate.
    const estData = { engineInputs: { services: { pest: true, mosquito: true } } };
    expect(glassCategoryEligible(estData, [{ service: 'pest_control' }], [], PEST_LAWN_SCOPE)).toBe(true);
  });

  test('r2b: unclassifiable estimates fail closed under a scoped release', () => {
    // e.g. a one-time WDO inspection: no engine-input mapping and the item
    // classifier returns null — the derived default would be pest_control.
    const wdoItem = [{ service: 'wdo_inspection', name: 'WDO Inspection' }];
    expect(deriveServiceCategory({}, [], wdoItem)).toBe('pest_control');
    expect(glassCategoryEligible({}, [], wdoItem, PEST_LAWN_SCOPE)).toBe(false);
    expect(glassCategoryEligible({}, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });
});
