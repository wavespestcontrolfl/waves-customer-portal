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

async function runHarness(t, { seedOnly = false, built = false } = {}) {
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
    route: async () => {}, newPage: async () => { throw new Error('browser disconnected'); },
  };
  const mocks = {
    '../dev/context': { readContext: () => ({ id: 'fixture', root, ports: { api: 12345 } }),
      childEnvironment: () => ({ DATABASE_URL: 'postgresql://test:test@localhost/waves_qa_fixture' }) },
    '../dev/doctor': { doctor: async () => {} },
    './browser': { evidence: () => ({}), launchBrowser: async () => ({
      newContext: async () => browserContext, close: async () => { events.push('browser-closed'); },
    }) },
    './fixtures': { fixtureIdentity: () => ({ runId: 'fixture' }),
      seed: async () => { events.push('seeded'); }, cleanup: async () => {} },
    knex: () => ({ destroy: async () => { events.push('database-closed'); } }),
    'node:child_process': { spawn: () => { events.push('server-started'); return server; } },
  };
  const processState = { argv: seedOnly ? ['node', entry, '--seed'] : ['node', entry], execPath: process.execPath };
  await vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    require: (name) => mocks[name] || realRequire(name), process: processState,
    console: { log() {}, error() {} }, URL, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true }),
  }, { filename: entry });
  const report = JSON.parse(fs.readFileSync(path.join(root, '.tmp/qa/e2e/report.json'), 'utf8'));
  return { events, processState, report };
}

test('seed-only mode succeeds without a frontend build and closes its database', async (t) => {
  const result = await runHarness(t, { seedOnly: true });
  assert.deepEqual(result.events, ['seeded', 'database-closed']);
  assert.equal(result.processState.exitCode, undefined);
});

test('full QA still requires a frontend build before seeding', async (t) => {
  const result = await runHarness(t);
  assert.deepEqual(result.events, ['database-closed']);
  assert.equal(result.processState.exitCode, 1);
  assert.match(result.report.error, /Run npm run build/);
});

test('a failed trace preserves the journey error, report, and resource shutdown', async (t) => {
  const result = await runHarness(t, { built: true });
  assert.deepEqual(result.events, ['seeded', 'server-started', 'browser-closed', 'server-stopped', 'database-closed']);
  assert.equal(result.processState.exitCode, 1);
  assert.equal(result.report.error, 'browser disconnected');
  assert.deepEqual(result.report.cleanupErrors, ['Trace: trace write failed']);
});
