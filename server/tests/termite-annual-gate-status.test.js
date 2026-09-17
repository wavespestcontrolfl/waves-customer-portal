test.each([
  ['false', 'false', false], ['true', 'false', false],
  ['false', 'true', false], ['true', 'true', true],
])('startup annual selection status for annual=%s cancel=%s', (annual, cancel, enabled) => {
  const keys = ['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2'];
  const prior = keys.map((key) => process.env[key]);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.env[keys[0]] = annual;
    process.env[keys[1]] = cancel;
    jest.isolateModules(() => {
      const { logGateStatus, termiteAnnualPlanSelectionEnabled } = require('../config/feature-gates');
      logGateStatus();
      expect(termiteAnnualPlanSelectionEnabled()).toBe(enabled);
    });
    expect(log.mock.calls.map(([line]) => line)).toContain(
      `  ${enabled ? '✅' : '🔒'} termiteAnnualPlan: ${enabled ? 'ENABLED' : 'DISABLED'}`,
    );
  } finally {
    log.mockRestore();
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
  }
});
