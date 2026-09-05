'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('failed database creation leaves provisioning retryable and preserves the selected cluster', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-qa-database-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '.tmp/dev');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'database.env');
  const backup = path.join(directory, 'cluster.env');
  const original = 'WAVES_DATABASE_ENVIRONMENT=preview\nDATABASE_URL=postgresql://test:test@localhost/cluster\n';
  fs.writeFileSync(file, original, { mode: 0o600 });
  let denied = true;
  let created = false;
  let closed = 0;
  const db = () => ({ where: () => ({ first: async () => created ? { datname: 'waves_qa_fixture' } : undefined }) });
  db.raw = async () => {
    if (denied) throw new Error('CREATE DATABASE denied');
    created = true;
  };
  db.destroy = async () => { closed++; };
  const entry = path.resolve(__dirname, '../database.js');
  const realRequire = createRequire(entry);
  const mocks = {
    '../dev/context': { readContext: () => ({ root, id: 'fixture' }),
      childEnvironment: () => ({ DATABASE_URL: 'postgresql://test:test@localhost/cluster' }) },
    knex: () => db,
  };
  async function run() {
    const state = {};
    await vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
      require: (name) => mocks[name] || realRequire(name), process: state, URL,
      console: { log() {}, error() {} },
    }, { filename: entry });
    return state;
  }
  assert.equal((await run()).exitCode, 1);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(closed, 1);
  denied = false;
  assert.equal((await run()).exitCode, undefined);
  assert.equal(created, true);
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, 'utf8'), /\/waves_qa_fixture\n/);
  assert.equal(closed, 2);
});
