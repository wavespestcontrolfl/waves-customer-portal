'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function boot(overrides = {}) {
  const connection = 'postgresql://test:test@dev.example/waves_qa_fixture';
  const config = { development: { connection }, production: { connection: { ssl: true } } };
  const env = { WAVES_LOCAL_DEV: '1', WAVES_WORKTREE_ID: 'fixture', DATABASE_URL: connection,
    QA_FIXTURE_FILE: 'fixture.json', ...overrides };
  const reachedFixture = new Error('reached fixture');
  const run = () => vm.runInNewContext(source, { process: { env }, URL, require(name) {
    if (name === '../../server/knexfile') return config;
    if (name === 'node:fs') return { readFileSync() { throw reachedFixture; } };
    throw new Error(`Unexpected import: ${name}`);
  } });
  return { run, config, connection, reachedFixture };
}

test('QA production application uses the same dev connection as fixture setup', () => {
  const state = boot();
  assert.throws(state.run, error => error === state.reachedFixture);
  assert.equal(state.config.production.connection, state.connection);
});
for (const overrides of [
  { RAILWAY_DEPLOYMENT_ID: 'deployed' }, { WAVES_LOCAL_DEV: '0' },
  { DATABASE_URL: 'postgresql://test:test@dev.example/another_database' },
]) test(`rejects unsafe QA target before changing config: ${Object.keys(overrides)[0]}`, () => {
  const state = boot(overrides);
  assert.throws(state.run, /QA server requires/);
  assert.deepEqual(state.config.production.connection, { ssl: true });
});
