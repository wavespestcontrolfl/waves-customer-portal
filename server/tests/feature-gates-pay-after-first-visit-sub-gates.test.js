// Per-item sub-gates of GATE_PAY_AFTER_FIRST_VISIT (owner ruling 2026-09-30):
// each is live only when the MASTER gate and its OWN var are both exactly
// 'true', read at call time, dark by default.
const featureGates = require('../config/feature-gates');

const MASTER = 'GATE_PAY_AFTER_FIRST_VISIT';
const SUBS = [
  ['GATE_PAF_EXISTING_CUSTOMERS', 'pafExistingCustomersLive', 'pafExistingCustomers'],
  ['GATE_PAF_SETUP_FEE', 'pafSetupFeeLive', 'pafSetupFee'],
  ['GATE_PAF_PREPAY', 'pafPrepayLive', 'pafPrepay'],
  ['GATE_PAF_TERMITE', 'pafTermiteLive', 'pafTermite'],
];
const ALL_VARS = [MASTER, ...SUBS.map(([v]) => v)];

describe('GATE_PAF_* sub-gates', () => {
  const saved = {};
  beforeEach(() => { for (const v of ALL_VARS) { saved[v] = process.env[v]; delete process.env[v]; } });
  afterEach(() => { for (const v of ALL_VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } });

  test.each(SUBS)('%s: dark by default and with the master off', (envVar, reader) => {
    expect(featureGates[reader]()).toBe(false);
    process.env[envVar] = 'true';
    expect(featureGates[reader]()).toBe(false); // master still off
  });

  test.each(SUBS)('%s: the master alone does not turn it on', (envVar, reader) => {
    process.env[MASTER] = 'true';
    expect(featureGates[reader]()).toBe(false);
  });

  test.each(SUBS)('%s: live only when master AND its own var are exactly "true"', (envVar, reader) => {
    process.env[MASTER] = 'true';
    process.env[envVar] = 'true';
    expect(featureGates[reader]()).toBe(true);
    for (const v of ['1', 'on', 'TRUE', 'false', '']) {
      process.env[envVar] = v;
      expect(featureGates[reader]()).toBe(false);
    }
    process.env[envVar] = 'true';
    process.env[MASTER] = '1';
    expect(featureGates[reader]()).toBe(false);
  });

  test('each item rolls out independently of the others', () => {
    process.env[MASTER] = 'true';
    process.env.GATE_PAF_PREPAY = 'true';
    expect(featureGates.pafPrepayLive()).toBe(true);
    expect(featureGates.pafExistingCustomersLive()).toBe(false);
    expect(featureGates.pafSetupFeeLive()).toBe(false);
    expect(featureGates.pafTermiteLive()).toBe(false);
  });

  test('read at call time (no redeploy): flipping the env changes the answer', () => {
    process.env[MASTER] = 'true';
    expect(featureGates.pafTermiteLive()).toBe(false);
    process.env.GATE_PAF_TERMITE = 'true';
    expect(featureGates.pafTermiteLive()).toBe(true);
    delete process.env.GATE_PAF_TERMITE;
    expect(featureGates.pafTermiteLive()).toBe(false);
  });

  test('gates-map entries exist for logGateStatus (and are dark by default)', () => {
    for (const [, , key] of SUBS) {
      expect(Object.prototype.hasOwnProperty.call(featureGates.gates, key)).toBe(true);
      expect(featureGates.gates[key]).toBe(false);
    }
  });
});
