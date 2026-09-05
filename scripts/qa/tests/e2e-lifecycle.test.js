'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const entry = path.resolve(__dirname, '../e2e.js');
const realRequire = createRequire(entry);

async function runHarness(t, { seedOnly = false, built = false, pageFails = false, buildCode = 0, buildSignal = null, buildError = false, cleanupOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-qa-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (built) {
    fs.mkdirSync(path.join(root, 'client/dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'client/dist/index.html'), 'fixture');
  }
  const events = [];
  const server = new EventEmitter();
  server.exitCode = null;
  server.kill = () => { events.push('server-stopped'); server.exitCode = 0; server.emit('exit'); };
  const browserContext = {
    tracing: { start: async () => {}, stop: async () => { throw new Error('trace write failed'); } },
    route: async () => {}, newPage: async () => {
      if (!pageFails) throw new Error('browser disconnected');
      return {
        goto: async () => { throw new Error('journey navigation failed'); },
        screenshot: async () => { throw new Error('screenshot disconnected'); },
      };
    },
  };
  const mocks = {
    '../dev/context': { readContext: () => ({ id: 'fixture', root, ports: { api: 12345 } }),
      childEnvironment: (_context, options) => options?.database
        ? { DATABASE_URL: 'postgresql://test:test@localhost/waves_qa_fixture' } : { WAVES_LOCAL_DEV: '1' } },
    '../dev/doctor': { doctor: async () => {} },
    './browser': { evidence: () => ({}), launchBrowser: async () => ({
      newContext: async () => browserContext, close: async () => { events.push('browser-closed'); },
    }) },
    './fixtures': { fixtureIdentity: () => ({ runId: 'fixture' }),
      seed: async () => { events.push('seeded'); }, cleanup: async () => {} },
    knex: () => ({ destroy: async () => { events.push('database-closed'); } }),
    'node:child_process': { spawn: (command, args, options) => {
      if (command !== 'npm') { events.push('server-started'); return server; }
      events.push('build-started');
      assert.deepEqual(Array.from(args), ['run', 'build']);
      assert.equal(options.cwd, root);
      assert.equal(options.env.DATABASE_URL, undefined);
      assert.equal(options.env.NODE_ENV, 'production');
      assert.equal(options.env.WAVES_LOCAL_DEV, '1');
      const build = new EventEmitter();
      queueMicrotask(() => {
        if (buildError) build.emit('error', new Error('npm unavailable'));
        else build.emit('exit', buildCode, buildSignal);
      });
      return build;
    } },
  };
  const processState = { argv: ['node', entry, ...(seedOnly ? ['--seed'] : []), ...(cleanupOnly ? ['--cleanup'] : [])], execPath: process.execPath };
  await vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    require: (name) => mocks[name] || realRequire(name), process: processState,
    console: { log() {}, error() {} }, URL, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true }),
  }, { filename: entry });
  const report = JSON.parse(fs.readFileSync(path.join(root, '.tmp/qa/e2e', cleanupOnly ? 'cleanup.json' : 'report.json'), 'utf8'));
  return { events, processState, report };
}

test('seed-only mode succeeds without a frontend build and closes its database', async (t) => {
  const result = await runHarness(t, { seedOnly: true });
  assert.deepEqual(result.events, ['seeded', 'database-closed']);
  assert.equal(result.processState.exitCode, undefined);
});

test('full QA still requires a frontend build before seeding', async (t) => {
  const result = await runHarness(t);
  assert.deepEqual(result.events, ['build-started', 'database-closed']);
  assert.equal(result.processState.exitCode, 1);
  assert.match(result.report.error, /did not produce/);
});

test('a failed trace preserves the journey error, report, and resource shutdown', async (t) => {
  const result = await runHarness(t, { built: true });
  assert.deepEqual(result.events, ['build-started', 'seeded', 'server-started', 'browser-closed', 'server-stopped', 'database-closed']);
  assert.equal(result.processState.exitCode, 1);
  assert.equal(result.report.error, 'browser disconnected');
  assert.deepEqual(result.report.cleanupErrors, ['Trace: trace write failed']);
});

test('a failed failure screenshot preserves the original journey error', async (t) => {
  const result = await runHarness(t, { built: true, pageFails: true });
  assert.equal(result.processState.exitCode, 1);
  assert.equal(result.report.error, 'journey navigation failed');
  assert.deepEqual(result.report.steps, [{ name: 'staff-login-and-role-isolation', passed: false,
    error: 'journey navigation failed', screenshotError: 'screenshot disconnected' }]);
  assert.deepEqual(result.events, ['build-started', 'seeded', 'server-started', 'browser-closed', 'server-stopped', 'database-closed']);
  assert.deepEqual(result.report.cleanupErrors, ['Trace: trace write failed']);
});

for (const failure of [{ buildCode: 1 }, { buildCode: null, buildSignal: 'SIGTERM' }, { buildError: true }]) {
  test(`failed build rejects existing stale assets: ${JSON.stringify(failure)}`, async (t) => {
    const result = await runHarness(t, { built: true, ...failure });
    assert.deepEqual(result.events, ['build-started', 'database-closed']);
    assert.equal(result.processState.exitCode, 1);
    assert.match(result.report.error, /build failed|npm unavailable/);
  });
}

test('cleanup-only mode never builds or seeds', async (t) => {
  const result = await runHarness(t, { cleanupOnly: true });
  assert.deepEqual(result.events, ['database-closed']);
  assert.equal(result.processState.exitCode, undefined);
});
