/**
 * ib_action_phases (round 11): mutable phase state for a multi-step Intelligence Bar action, kept out of the append-only
 * audit_log. The migration is a two-way door: up creates the table, down drops it.
 */
const migration = require('../models/migrations/20261011020000_ib_action_phases');

function fakeKnex({ exists = false } = {}) {
  const log = [];
  const table = new Proxy({}, {
    get: (_t, name) => (...args) => {
      log.push([String(name), ...args]);
      const chain = new Proxy(function () {}, { get: () => (...a) => { log.push(['chain', ...a]); return chain; }, apply: () => chain });
      return chain;
    },
  });
  return {
    log,
    fn: { now: () => 'now()', uuid: () => 'uuid()' },
    schema: {
      hasTable: async () => exists,
      createTable: async (name, cb) => { log.push(['createTable', name]); cb(table); },
      dropTableIfExists: async (name) => { log.push(['dropTableIfExists', name]); },
    },
  };
}

test('up creates ib_action_phases with the state columns, a unique action_key and the alert stamp', async () => {
  const knex = fakeKnex();
  await migration.up(knex);
  expect(knex.log[0]).toEqual(['createTable', 'ib_action_phases']);
  const columns = knex.log.filter((e) => ['uuid', 'string', 'jsonb', 'timestamp'].includes(e[0])).map((e) => e[1]);
  expect(columns).toEqual(expect.arrayContaining(['id', 'tool', 'customer_id', 'action_key', 'phase', 'payload', 'created_at', 'updated_at', 'alerted_at']));
  expect(knex.log.map((e) => e[0])).toContain('index');
});

test('up is a no-op when the table already exists; down drops it', async () => {
  const existing = fakeKnex({ exists: true });
  await migration.up(existing);
  expect(existing.log).toEqual([]);
  const knex = fakeKnex();
  await migration.down(knex);
  expect(knex.log).toEqual([['dropTableIfExists', 'ib_action_phases']]);
});

test('action_key is unique per attempt (source contract)', () => {
  const src = require('fs').readFileSync(require.resolve('../models/migrations/20261011020000_ib_action_phases'), 'utf8');
  expect(src).toContain("t.string('action_key', 200).notNullable().unique()");
});
