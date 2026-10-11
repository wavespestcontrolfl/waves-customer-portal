/**
 * Round 13: one open start_program attempt per customer, enforced by the database. A partial unique index on
 * ib_action_phases (customer_id) where the phase is booking or booked_pending_bill. The first ledger migration is
 * already pushed, so the index is a separate, later migration. Two-way door: down drops the index.
 */
const fs = require('fs');
const path = require('path');

const FILE = '20261011030000_ib_action_phases_one_open_per_customer';
const migration = require(`../models/migrations/${FILE}`);

function fakeKnex({ exists = true } = {}) {
  const sql = [];
  return { sql, schema: { hasTable: async () => exists }, raw: async (text) => { sql.push(text.replace(/\s+/g, ' ').trim()); } };
}

test('the index migration exists and sorts after the ledger migration', () => {
  const dir = path.join(__dirname, '../models/migrations');
  const names = fs.readdirSync(dir).filter((f) => f.startsWith('202610110'));
  expect(names).toContain(`${FILE}.js`);
  expect(names.indexOf(`${FILE}.js`)).toBeGreaterThan(names.indexOf('20261011020000_ib_action_phases.js'));
});

test('up closes any duplicate open rows, then creates the partial unique index on the two open phases', async () => {
  const knex = fakeKnex();
  await migration.up(knex);
  expect(knex.sql).toHaveLength(2);
  expect(knex.sql[0]).toContain("SET phase = 'abandoned'");
  expect(knex.sql[1]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS ib_action_phases_one_open_per_customer');
  expect(knex.sql[1]).toContain('ON ib_action_phases (customer_id)');
  expect(knex.sql[1]).toContain("WHERE phase IN ('booking', 'booked_pending_bill')");
});

test('up does nothing when the ledger table is absent; down drops the index', async () => {
  const absent = fakeKnex({ exists: false });
  await migration.up(absent);
  expect(absent.sql).toEqual([]);
  const knex = fakeKnex();
  await migration.down(knex);
  expect(knex.sql).toEqual(['DROP INDEX IF EXISTS ib_action_phases_one_open_per_customer']);
});

test('the pushed ledger migration is unchanged (it creates no unique open index itself)', () => {
  const src = fs.readFileSync(require.resolve('../models/migrations/20261011020000_ib_action_phases'), 'utf8');
  expect(src).not.toContain('one_open');
});

test('the marker writer names the same index the migration creates', () => {
  expect(require('../services/intelligence-bar/start-program-marker').ONE_OPEN_INDEX).toBe(migration.INDEX);
});
