'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('preview trace failures preserve page failures, close contexts, and allow later scenarios', async (t) => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-preview-lifecycle-'));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  const entry = path.resolve(__dirname, '../previews.js');
  const realRequire = createRequire(entry);
  let closedContexts = 0;
  let closedBrowser = false;
  let closedServer = false;
  const page = { on() {}, route: async () => {}, screenshot: async () => {},
    goto: async () => { throw new Error('page disconnected'); } };
  const browser = {
    newContext: async () => ({
      tracing: { start: async () => {}, stop: async () => { throw new Error('trace write failed'); } },
      newPage: async () => page,
      close: async () => { closedContexts++; },
    }),
    close: async () => { closedBrowser = true; },
  };
  const mocks = { './browser': {
    evidence: () => ({}), launchBrowser: async () => browser,
    previewServer: async () => ({ baseUrl: 'http://127.0.0.1:12345', close: async () => { closedServer = true; } }),
  } };
  const processState = { env: { QA_ARTIFACT_DIR: artifactDir } };
  await vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    require: (name) => mocks[name] || realRequire(name), process: processState,
    __dirname: path.dirname(entry), URL, console: { log() {}, error() {} },
  }, { filename: entry });
  const report = JSON.parse(fs.readFileSync(path.join(artifactDir, 'report.json'), 'utf8'));
  assert.equal(report.scenarios.length, 12);
  for (const result of report.scenarios) {
    assert.equal(result.passed, false);
    assert.equal(result.failure, 'page disconnected');
    assert.deepEqual(result.cleanupErrors, ['Trace: trace write failed']);
  }
  assert.equal(closedContexts, 12);
  assert.ok(closedBrowser && closedServer);
  assert.equal(processState.exitCode, 1);
});
