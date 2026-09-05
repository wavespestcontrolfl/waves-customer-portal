const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

function evaluate(code, env) {
  return execFileSync(process.execPath, ['-e', code], {
    cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('explicit cron opt-out works in development; production stays opt-in', () => {
  const code = "console.log(require('./server/config/feature-gates').isEnabled('cronJobs'))";
  expect(evaluate(code, { NODE_ENV: 'development', GATE_CRON_JOBS: 'false' })).toBe('false');
  expect(evaluate(code, { NODE_ENV: 'development' })).toBe('true');
  expect(evaluate(code, { NODE_ENV: 'production' })).toBe('false');
  expect(evaluate(code, { NODE_ENV: 'production', GATE_CRON_JOBS: 'true' })).toBe('true');
});

test('managed mode never loads dotenv and refuses deployed processes', () => {
  const code = "require('dotenv').config = () => { throw new Error('dotenv must not run'); }; require('./server/config/load-env')(); console.log('isolated')";
  expect(evaluate(code, { WAVES_LOCAL_DEV: '1' })).toBe('isolated');
  expect(() => evaluate(code, { WAVES_LOCAL_DEV: '1', RAILWAY_DEPLOYMENT_ID: 'deployment' })).toThrow();
});
