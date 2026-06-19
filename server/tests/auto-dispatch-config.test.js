const { getAutoDispatchConfig, isApplyAllowed } = require('../services/auto-dispatch/config');

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
