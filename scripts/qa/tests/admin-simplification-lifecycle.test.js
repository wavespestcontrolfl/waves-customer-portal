'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('admin QA closes its preview server when Chromium cannot launch', async () => {
  const entry = path.resolve(__dirname, '../admin-simplification.cjs');
  const realRequire = createRequire(entry);
  let serverClosed = false;
  let report;
  const mocks = {
    'node:fs': { mkdirSync() {}, writeFileSync(_path, text) { report = JSON.parse(text); } },
    './browser': {
      evidence: () => ({}),
      previewServer: async () => ({ close: async () => { serverClosed = true; } }),
      launchBrowser: async () => { throw new Error('Synthetic missing Chromium'); },
    },
  };
  const processState = {};
  await vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    require: (name) => mocks[name] || realRequire(name), process: processState,
    __dirname: path.dirname(entry), URL, console: { log() {}, error() {} },
  }, { filename: entry });
  assert.equal(serverClosed, true);
  assert.equal(report.failure.message, 'Synthetic missing Chromium');
  assert.equal(processState.exitCode, 1);
});
