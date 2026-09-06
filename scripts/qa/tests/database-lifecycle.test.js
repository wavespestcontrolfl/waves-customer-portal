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

for (const failure of ['writeFileSync', 'copyFileSync', 'chmodSync', 'renameSync']) {
  test(`selection ${failure} failure preserves the original database and allows retry`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-qa-rollback-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, '.tmp/dev');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'database.env');
    const backup = path.join(directory, 'cluster.env');
    const original = 'WAVES_DATABASE_ENVIRONMENT=preview\nDATABASE_URL=postgresql://test:test@localhost/cluster\n';
    fs.writeFileSync(file, original, { mode: 0o600 });
    let fail = true;
    let created = false;
    let closed = 0;
    const statements = [];
    const db = () => ({ where: () => ({ first: async () => created ? { datname: 'waves_qa_fixture' } : undefined }) });
    db.raw = async (sql, bindings) => {
      assert.deepEqual(Array.from(bindings), ['waves_qa_fixture']);
      statements.push(sql);
      if (sql.startsWith('CREATE')) created = true;
      else { assert.equal(sql, 'DROP DATABASE ??'); created = false; }
    };
    db.destroy = async () => { closed++; };
    const entry = path.resolve(__dirname, '../database.js');
    const realRequire = createRequire(entry);
    const mocks = {
      'node:fs': { ...fs, [failure]: (...args) => {
        if (fail) {
          // Even a partially written staging file must not corrupt the selection.
          if (failure === 'writeFileSync') fs.writeFileSync(args[0], 'partial', args[2]);
          throw new Error('injected filesystem failure');
        }
        return fs[failure](...args);
      } },
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
    assert.equal(created, false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(backup), false);
    assert.deepEqual(fs.readdirSync(directory), ['database.env']);
    assert.equal(closed, 1);
    assert.deepEqual(statements, failure === 'writeFileSync' ? [] : ['CREATE DATABASE ?? TEMPLATE template0', 'DROP DATABASE ??']);
    fail = false;
    assert.equal((await run()).exitCode, undefined);
    assert.equal(created, true);
    assert.equal(fs.readFileSync(backup, 'utf8'), original);
    assert.match(fs.readFileSync(file, 'utf8'), /\/waves_qa_fixture\n/);
    assert.equal(closed, 2);
  });
}

for (const existing of [true, false]) {
  test(existing ? 'an existing database is never dropped' : 'failed rollback retains the original selection and backup', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-qa-ownership-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, '.tmp/dev');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'database.env');
    const original = 'original cluster selection';
    fs.writeFileSync(file, original);
    const statements = [];
    let closed = false;
    const errors = [];
    const db = () => ({ where: () => ({ first: async () => existing ? { datname: 'waves_qa_fixture' } : undefined }) });
    db.raw = async (sql) => {
      statements.push(sql);
      if (sql.startsWith('DROP')) throw new Error('database is in use');
    };
    db.destroy = async () => { closed = true; };
    const entry = path.resolve(__dirname, '../database.js');
    const realRequire = createRequire(entry);
    const mocks = {
      'node:fs': { ...fs, renameSync: () => { throw new Error('injected rename failure'); } },
      '../dev/context': { readContext: () => ({ root, id: 'fixture' }),
        childEnvironment: () => ({ DATABASE_URL: 'postgresql://test:test@localhost/cluster' }) },
      knex: () => db,
    };
    const state = {};
    await vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
      require: (name) => mocks[name] || realRequire(name), process: state, URL,
      console: { log() {}, error: (message) => errors.push(message) },
    }, { filename: entry });
    assert.equal(state.exitCode, 1);
    assert.equal(closed, true);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(statements, existing ? [] : ['CREATE DATABASE ?? TEMPLATE template0', 'DROP DATABASE ??']);
    assert.deepEqual(fs.readdirSync(directory).sort(), existing ? ['database.env'] : ['cluster.env', 'database.env']);
    assert.match(errors[0], existing ? /already exists/ : /rollback failed/);
  });
}
