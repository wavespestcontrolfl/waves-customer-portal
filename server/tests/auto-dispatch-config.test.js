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

// guardMode is the single source of truth apply.js's grouped-member guard
// reads off the SAME config object index.js resolves — pin its precedence
// here directly (Codex pre-push P1) rather than only through the
// orchestrator's own integration tests.
describe('guardMode — the resolved day-move guard, flex over tiers over legacy', () => {
  test('neither gate ⇒ legacy', () => {
    expect(getAutoDispatchConfig({ routeTiersEnabled: false, flexTierEnabled: false }).guardMode).toBe('legacy');
  });
  test('routeTiersEnabled alone ⇒ tiers', () => {
    expect(getAutoDispatchConfig({ routeTiersEnabled: true, flexTierEnabled: false }).guardMode).toBe('tiers');
  });
  test('flexTierEnabled alone ⇒ flex', () => {
    expect(getAutoDispatchConfig({ routeTiersEnabled: false, flexTierEnabled: true }).guardMode).toBe('flex');
  });
  test('both on ⇒ flex takes precedence', () => {
    expect(getAutoDispatchConfig({ routeTiersEnabled: true, flexTierEnabled: true }).guardMode).toBe('flex');
  });
});

describe('customer recurring handoff prerequisites', () => {
  const { gates } = require('../config/feature-gates');
  const savedEnv = { ...process.env };
  const savedGates = { cronJobs: gates.cronJobs, autoDispatch: gates.autoDispatch };
  beforeEach(() => {
    process.env.GATE_CUSTOMER_RECURRING_DISPATCH = 'true';
    process.env.AUTO_DISPATCH_MAX_CHANGES_PER_RUN = '1';
    process.env.AUTO_DISPATCH_REQUIRE_PORTAL_PREFERENCES = 'false';
    process.env.AUTO_DISPATCH_MODE = 'apply';
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    gates.cronJobs = true;
    gates.autoDispatch = true;
  });
  afterEach(() => {
    for (const key of ['GATE_CUSTOMER_RECURRING_DISPATCH', 'AUTO_DISPATCH_MODE', 'AUTO_DISPATCH_ALLOW_APPLY', 'AUTO_DISPATCH_MAX_CHANGES_PER_RUN', 'AUTO_DISPATCH_REQUIRE_PORTAL_PREFERENCES']) {
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
    ['AUTO_DISPATCH_REQUIRE_PORTAL_PREFERENCES', 'true'],
  ])('refuses handoff with %s=%s', (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    expect(isCustomerRecurringDispatchEnabled()).toBe(false);
  });
});

describe('day-move drive floor and conflict moves (owner 2026-10-09)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['AUTO_DISPATCH_MIN_DAY_MOVE_DRIVE_SAVING_MINUTES', 'GATE_AUTO_DISPATCH_CONFLICT_MOVES']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  test('the floor defaults to 6 minutes and reads its env knob', () => {
    delete process.env.AUTO_DISPATCH_MIN_DAY_MOVE_DRIVE_SAVING_MINUTES;
    expect(getAutoDispatchConfig().minDayMoveDriveSavingMinutes).toBe(6);
    process.env.AUTO_DISPATCH_MIN_DAY_MOVE_DRIVE_SAVING_MINUTES = '0';
    expect(getAutoDispatchConfig().minDayMoveDriveSavingMinutes).toBe(0);
    expect(getAutoDispatchConfig({ minDayMoveDriveSavingMinutes: 10 }).minDayMoveDriveSavingMinutes).toBe(10);
  });

  test('conflict moves are off unless the gate is set', () => {
    delete process.env.GATE_AUTO_DISPATCH_CONFLICT_MOVES;
    expect(getAutoDispatchConfig().conflictMovesEnabled).toBe(false);
    process.env.GATE_AUTO_DISPATCH_CONFLICT_MOVES = 'true';
    expect(getAutoDispatchConfig().conflictMovesEnabled).toBe(true);
  });
});
