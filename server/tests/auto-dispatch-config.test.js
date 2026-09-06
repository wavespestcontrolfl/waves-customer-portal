const { getAutoDispatchConfig, isApplyAllowed, isCustomerRecurringDispatchEnabled } = require('../services/auto-dispatch/config');

describe('auto-dispatch config apply gate', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = saved.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_MODE = saved.AUTO_DISPATCH_MODE;
  });

  test('apply is downgraded to dry_run when the apply gate is off', () => {
    delete process.env.AUTO_DISPATCH_ALLOW_APPLY;
    const cfg = getAutoDispatchConfig({ mode: 'apply' });
    expect(cfg.mode).toBe('dry_run');
    expect(cfg.applyBlocked).toBe(true);
    expect(cfg.applyAllowed).toBe(false);
  });

  test('apply is honored once the gate is enabled', () => {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    const cfg = getAutoDispatchConfig({ mode: 'apply' });
    expect(cfg.mode).toBe('apply');
    expect(cfg.applyBlocked).toBe(false);
    expect(isApplyAllowed()).toBe(true);
  });

  test('defaults to dry_run with conservative knobs', () => {
    delete process.env.AUTO_DISPATCH_MODE;
    delete process.env.AUTO_DISPATCH_ALLOW_APPLY;
    const cfg = getAutoDispatchConfig();
    expect(cfg.mode).toBe('dry_run');
    expect(cfg.lockWindowDays).toBe(14);
    expect(cfg.minScoreImprovement).toBe(15);
  });
});

describe('customer recurring handoff prerequisites', () => {
  const { gates } = require('../config/feature-gates');
  const savedEnv = { ...process.env };
  const savedGates = { cronJobs: gates.cronJobs, autoDispatch: gates.autoDispatch };
  beforeEach(() => {
    process.env.GATE_CUSTOMER_RECURRING_DISPATCH = 'true';
    process.env.AUTO_DISPATCH_MAX_CHANGES_PER_RUN = '1';
    process.env.AUTO_DISPATCH_MODE = 'apply';
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    gates.cronJobs = true;
    gates.autoDispatch = true;
  });
  afterEach(() => {
    for (const key of ['GATE_CUSTOMER_RECURRING_DISPATCH', 'AUTO_DISPATCH_MODE', 'AUTO_DISPATCH_ALLOW_APPLY', 'AUTO_DISPATCH_MAX_CHANGES_PER_RUN']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    Object.assign(gates, savedGates);
  });

  test('allows handoff only with an enabled cron and effective apply mode', () => {
    expect(isCustomerRecurringDispatchEnabled()).toBe(true);
  });
  test.each(['cronJobs', 'autoDispatch'])('refuses handoff when %s is inactive', (gate) => {
    gates[gate] = false;
    expect(isCustomerRecurringDispatchEnabled()).toBe(false);
  });
  test.each([
    ['GATE_CUSTOMER_RECURRING_DISPATCH', 'false'],
    ['GATE_CUSTOMER_RECURRING_DISPATCH', undefined],
    ['AUTO_DISPATCH_ALLOW_APPLY', 'false'],
    ['AUTO_DISPATCH_ALLOW_APPLY', undefined],
    ['AUTO_DISPATCH_MODE', 'dry_run'],
    ['AUTO_DISPATCH_MODE', undefined],
    ['AUTO_DISPATCH_MAX_CHANGES_PER_RUN', '0'],
    ['AUTO_DISPATCH_MAX_CHANGES_PER_RUN', '-1'],
  ])('refuses handoff with %s=%s', (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    expect(isCustomerRecurringDispatchEnabled()).toBe(false);
  });
});
