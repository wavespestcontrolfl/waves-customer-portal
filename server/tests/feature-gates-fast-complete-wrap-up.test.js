// GATE_FAST_COMPLETE_WRAP_UP: the dark switch for the Wrap-up section on the lawn visit and
// Tree & Shrub Fast Complete sheets. Read at call time, exactly 'true'; the context routes carry
// `wrapUp: true` from it (lawn-fast-complete.test.js, tree-shrub-fast-context.test.js).
const gates = require('../config/feature-gates');

describe('fastCompleteWrapUpLive', () => {
  const saved = process.env.GATE_FAST_COMPLETE_WRAP_UP;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_FAST_COMPLETE_WRAP_UP; else process.env.GATE_FAST_COMPLETE_WRAP_UP = saved;
  });

  test('ships dark: unset is off', () => {
    delete process.env.GATE_FAST_COMPLETE_WRAP_UP;
    expect(gates.fastCompleteWrapUpLive()).toBe(false);
  });

  test('only exactly true turns it on, and a flip needs no restart', () => {
    for (const value of ['', 'false', '1', 'on', 'TRUE']) {
      process.env.GATE_FAST_COMPLETE_WRAP_UP = value;
      expect(gates.fastCompleteWrapUpLive()).toBe(false);
    }
    process.env.GATE_FAST_COMPLETE_WRAP_UP = 'true';
    expect(gates.fastCompleteWrapUpLive()).toBe(true);
    delete process.env.GATE_FAST_COMPLETE_WRAP_UP;
    expect(gates.fastCompleteWrapUpLive()).toBe(false);
  });

  test('the gate is in the known-gate catalog and documented', () => {
    expect(gates.knownGateCatalog().has('GATE_FAST_COMPLETE_WRAP_UP')).toBe(true);
  });
});
