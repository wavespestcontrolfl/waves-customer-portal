const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
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

test.each([false, true])('pricing startup preserves scheduler ordering (managed=%s)', async (managed) => {
  const source = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const start = source.indexOf('  (async () => {', source.indexOf('primeCatalogNames.then'));
  const end = source.indexOf('// Terminal Tap to Pay:', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const calls = [];
  let finishPricing;
  const pricing = new Promise((resolve) => { finishPricing = resolve; });
  const boot = vm.runInNewContext(source.slice(start, end) + 'recovery(); })()', {
    process: { env: managed ? { WAVES_LOCAL_DEV: '1' } : {} },
    config: { nodeEnv: 'production' },
    initScheduledJobs: () => calls.push('scheduled'),
    initBankingSync: () => calls.push('banking'),
    require: () => ({ syncConstantsFromDB: () => { calls.push('pricing'); return pricing; } }),
    logger: { warn: jest.fn() }, recovery: () => calls.push('recovery'),
  });
  expect(calls).toEqual(managed ? ['pricing'] : ['scheduled', 'banking', 'pricing']);
  finishPricing();
  await boot;
  expect(calls).toEqual(managed ? ['pricing'] : ['scheduled', 'banking', 'pricing', 'recovery']);
});
