/**
 * The nightly tab reload check on PostgreSQL. readMissedReloads counts only
 * the stale page views of its window with no name, 'reloaded' or
 * 'reload-missed'. The check keeps the mark of how far it has read in
 * system_settings. The two columns it reads have their own test
 * (admin-usage-reload-columns-postgres.test.js).
 *
 * Self-skips without DATABASE_URL. It runs in a schema of its own, on a
 * small admin_usage_events and system_settings it makes itself, so it needs
 * no migrated database and installs nothing in the database it borrows.
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
const { readMissedReloads, readWindow, marks } = require('../services/tab-reload-check');

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('tab reload check on PostgreSQL', () => {
  const schema = `tab_reload_${randomUUID().replaceAll('-', '')}`;
  // Nov 1 2026, 11:51:02 PM EST: the run on the night the clocks went back.
  // Its read ends at 11:50 PM; the edge before it was Oct 31, 11:50 PM EDT,
  // 25 hours earlier.
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
    // As in its migration (20260414000029).
    await database.schema.withSchema(schema).createTable('system_settings', (t) => {
      t.string('key', 100).primary();
      t.text('value');
      t.string('category', 50);
      t.text('description');
      t.timestamps(true, true);
    });
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
    const START = new Date('2026-11-01T03:50:00Z');
    const END = new Date('2026-11-02T04:50:00Z');
    const at = (date, ms) => ({ ...view(0, { stale_build: true, reload_hold: 'reloaded', page_key: 'schedule', path: '/admin/schedule' }), created_at: new Date(date.getTime() + ms) });
    await database('admin_usage_events').insert([
      // The window's edges: its first moment counts; the moment before it,
      // its end and the second after the end do not. The next run starts at
      // that end.
      at(START, 0),
      at(START, -1),
      at(END, -1),
      at(END, 0),
      at(END, 1000),
      view(10, { stale_build: true, reload_hold: null }),
      view(20, { stale_build: true, reload_hold: null }),
      view(30, { stale_build: true, reload_hold: 'reload-missed', page_key: 'dashboard', path: '/admin/dashboard' }),
      view(40, { stale_build: true, reload_hold: 'reloaded' }),
      // In the hour after the edge before this one: a fixed 24 hours skips it.
      view(24 * 60 + 30, { stale_build: true, reload_hold: 'reload-missed' }),
      // Not counted: a rule the owner chose, a current tab (also with a
      // failed name: the name test is grouped), an unknown build, a tab that
      // had heard no server at its move (a healthy tab sends that for a move
      // made before its first server answer), and a view from before the
      // window.
      view(50, { stale_build: true, reload_hold: 'field-page' }),
      view(60, { stale_build: false, reload_hold: null }),
      view(70, { stale_build: false, reload_hold: 'reloaded' }),
      view(80, { stale_build: null, reload_hold: null }),
      view(90, { stale_build: true, reload_hold: 'never-heard' }),
      view(25 * 60 + 2, { stale_build: true, reload_hold: 'reloaded' }),
    ]);

    expect(readWindow(NOW)).toEqual({ start: START, end: END });
    const rows = await readMissedReloads({ start: START, end: END, knex: database });

    const counted = rows
      .map((r) => [r.reload_hold || 'none', r.page_key, r.technician_id, Number(r.views)])
      .sort((a, b) => a.join().localeCompare(b.join()));
    expect(counted).toEqual([
      ['none', 'pipeline', TECH, 2],
      ['reload-missed', 'dashboard', TECH, 1],
      ['reload-missed', 'pipeline', TECH, 1],
      ['reloaded', 'pipeline', TECH, 1],
      ['reloaded', 'schedule', TECH, 2],
    ]);
  });

  test('keeps the mark of how far it has read in system_settings', async () => {
    const key = 'tab_reload_check.read_to';
    await expect(marks.get(database)).resolves.toBeNull();

    const first = new Date('2026-11-02T04:50:00Z');
    await marks.set(first, database);
    await expect(marks.get(database)).resolves.toEqual(first);
    // The next finished run moves the one row.
    const next = new Date('2026-11-03T04:50:00Z');
    await marks.set(next, database);
    await expect(marks.get(database)).resolves.toEqual(next);
    await expect(database('system_settings').select('key', 'value', 'category'))
      .resolves.toEqual([{ key, value: next.toISOString(), category: 'tab_reload_check' }]);

    // A value that is no time reads as no mark: the run reads one night.
    for (const value of ['not a time', null]) {
      await database('system_settings').where({ key }).update({ value });
      await expect(marks.get(database)).resolves.toBeNull();
    }
  });
});
