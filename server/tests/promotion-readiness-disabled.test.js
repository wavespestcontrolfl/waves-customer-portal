const { spawnSync } = require('child_process');
const path = require('path');

test('promotion readiness refuses a verdict before loading database or providers', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/v2-promotion-readiness.js')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, WAVES_LOCAL_DEV: '1', DATABASE_URL: 'invalid-must-not-be-used' },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Promotion readiness unavailable: recovery cohort attribution is pending repair');
  expect(result.stderr).not.toContain('Error:');
});
