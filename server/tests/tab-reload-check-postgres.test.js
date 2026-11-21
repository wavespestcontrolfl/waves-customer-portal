/**
 * The nightly tab reload check's read, on PostgreSQL: readMissedReloads
 * counts only the stale page views from the scheduled time of the run
 * before it up to its own, with no name, 'no-server-heard', 'reloaded' or
 * 'reload-missed'.
 * The two columns it reads have their own test
 * (admin-usage-reload-columns-postgres.test.js).
 *
 * Self-skips without DATABASE_URL. It runs in a schema of its own, on a
 * small admin_usage_events it makes itself, so it needs no migrated database
 * and installs nothing in the database it borrows.
 */
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({}));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn() }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn() }));

const addColumns = require('../models/migrations/20261120213000_admin_usage_reload_columns');
const { readMissedReloads } = require('../services/tab-reload-check');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('tab reload check on PostgreSQL', () => {
  const schema = `tab_reload_${randomUUID().replaceAll('-', '')}`;
  // Nov 1 2026, 11:51:02 PM EST: the run on the night the clocks went back.
  // The run before it was Oct 31, 11:51 PM EDT, 25 hours earlier.
  const NOW = new Date('2026-11-02T04:51:02Z');
  const TECH = randomUUID();
  let database;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    // Not the table's own migration (20260723000001): that one also runs
    // CREATE EXTENSION "uuid-ossp", and an extension must never land in a
    // schema this test drops.
    await database.schema.withSchema(schema).createTable('admin_usage_events', (t) => {
      t.uuid('id').primary();
      t.uuid('technician_id').notNullable();
      t.string('page_key', 64).notNullable();
      t.string('path', 160);
      t.timestamp('created_at').notNullable().defaultTo(database.fn.now());
    });
    await addColumns.up(database);
  });
  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]).catch(() => {});
    await database.destroy();
  });

  const view = (minutesAgo, fields) => ({
    id: randomUUID(),
    technician_id: TECH,
    page_key: 'pipeline',
    path: '/admin/pipeline',
    created_at: new Date(NOW.getTime() - minutesAgo * 60 * 1000),
    ...fields,
  });

  test('counts the stale page views of its window whose name shows a failed reload', async () => {
    const START = new Date('2026-11-01T03:51:00Z');
    const END = new Date('2026-11-02T04:51:00Z');
    const at = (date, ms) => ({ ...view(0, { stale_build: true, reload_hold: 'reloaded', page_key: 'schedule', path: '/admin/schedule' }), created_at: new Date(date.getTime() + ms) });
    await database('admin_usage_events').insert([
      // The window's edges: its first moment counts; the moment before it,
      // its end and the second after the end (before this run read) do not.
      // The next run starts at that end.
      at(START, 0),
      at(START, -1),
      at(END, -1),
      at(END, 0),
      at(END, 1000),
      view(10, { stale_build: true, reload_hold: null }),
      view(20, { stale_build: true, reload_hold: null }),
      view(30, { stale_build: true, reload_hold: 'no-server-heard', page_key: 'dashboard', path: '/admin/dashboard' }),
      view(40, { stale_build: true, reload_hold: 'reloaded' }),
      // In the hour after the run before this one: a fixed 24 hours skips it.
      view(24 * 60 + 30, { stale_build: true, reload_hold: 'reload-missed' }),
      // Not counted: a rule the owner chose, a current tab (also with a
      // failed name: the name test is grouped), an unknown build, the name a
      // tab sends (a row from before the route stored a name of its own),
      // and a view from before the run before this one.
      view(50, { stale_build: true, reload_hold: 'field-page' }),
      view(60, { stale_build: false, reload_hold: null }),
      view(70, { stale_build: false, reload_hold: 'reloaded' }),
      view(80, { stale_build: null, reload_hold: null }),
      view(90, { stale_build: true, reload_hold: 'never-heard' }),
      view(25 * 60 + 1, { stale_build: true, reload_hold: 'no-server-heard' }),
    ]);

    const rows = await readMissedReloads({ now: NOW, knex: database });

    const counted = rows
      .map((r) => [r.reload_hold || 'none', r.page_key, r.technician_id, Number(r.views)])
      .sort((a, b) => a.join().localeCompare(b.join()));
    expect(counted).toEqual([
      ['no-server-heard', 'dashboard', TECH, 1],
      ['none', 'pipeline', TECH, 2],
      ['reload-missed', 'pipeline', TECH, 1],
      ['reloaded', 'pipeline', TECH, 1],
      ['reloaded', 'schedule', TECH, 2],
    ]);
  });
});
