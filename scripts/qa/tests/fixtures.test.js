'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixtureIdentity } = require('../fixtures');
const { etDateString } = require('../../../server/utils/datetime-et');

test('synthetic accounts have fresh credentials, reserved contact details and future appointments', () => {
  const first = fixtureIdentity();
  const second = fixtureIdentity();
  assert.notEqual(first.customerId, second.customerId);
  assert.notEqual(first.password, second.password);
  assert.notEqual(first.token, second.token);
  assert.match(first.phone, /^\+194155501\d{2}$/);
  assert.match(first.customerEmail, /@example\.invalid$/);
  assert.ok(first.date > etDateString(new Date()));
  assert.ok(first.nextDate > first.date);
});

test('QA server refuses another database before reading fixtures or connecting', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../server.js')], {
    env: { WAVES_LOCAL_DEV: '1', WAVES_WORKTREE_ID: '1234',
      DATABASE_URL: 'postgresql://qa:qa@database.invalid/shared_preview', QA_FIXTURE_FILE: '/missing-fixture' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires the worktree-owned database/);
  assert.doesNotMatch(result.stderr, /ENOENT|ENOTFOUND/);
});

test('QA server cannot start inside a deployed Railway process', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../server.js')], {
    env: { WAVES_LOCAL_DEV: '1', RAILWAY_DEPLOYMENT_ID: 'preview-deployment', QA_FIXTURE_FILE: '/missing-fixture' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires the managed local environment/);
});
