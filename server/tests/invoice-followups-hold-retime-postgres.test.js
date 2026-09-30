/**
 * The held-touch retime guard (holdTouchUntilNextDay) on real PostgreSQL.
 *
 * The guard matches the claimed next_touch_at so a send-now rewrite is never
 * overwritten. Some writers stamp that column with the DB clock (now(), e.g.
 * visit-completion-packets), which carries MICROSECONDS, while node-pg hands
 * the service a millisecond Date; plain equality on that Date never matches, so
 * every hold would silently no-op. The guard compares at millisecond precision
 * (date_trunc('milliseconds', next_touch_at) = ?). This proves the round trip
 * for both column types (timestamp with and without time zone) under whatever
 * TZ the process runs in (also run with TZ=America/New_York). Disposable
 * schema on a private QA / isolated CI database; skipped without
 * APP_TEST_DATABASE_URL, run for real in CI.
 */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `followup_hold_${randomUUID().replaceAll('-', '')}`;
let admin;
let mockPg;

postgres('held-touch retime guard on PostgreSQL', () => {
  let hold;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    hold = require('../services/invoice-followups')._test.holdTouchUntilNextDay;
  });

  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (admin) await admin.destroy();
  });

  async function makeTable(columnType) {
    await mockPg.raw('DROP TABLE IF EXISTS invoice_followup_sequences');
    await mockPg.raw(`CREATE TABLE invoice_followup_sequences (
      id uuid PRIMARY KEY, status text, step_index integer,
      touch_claimed_at ${columnType}, next_touch_at ${columnType}, updated_at ${columnType})`);
  }

  // A claimed, due row as fireStep hands it over: next_touch_at as pg returned it.
  async function claimedRow({ dueSql = 'now()', claimStamp = new Date() } = {}) {
    const id = randomUUID();
    await mockPg.raw(
      `INSERT INTO invoice_followup_sequences (id, status, step_index, touch_claimed_at, next_touch_at)
       VALUES (?, 'active', 0, ?, ${dueSql})`, [id, claimStamp],
    );
    const stored = await mockPg('invoice_followup_sequences').where({ id }).first();
    // Anchored now, so the next step is a week out: the hold is inside its window.
    return { claimStamp, row: { id, step_index: 0, next_touch_at: stored.next_touch_at, anchor_at: new Date() } };
  }
  const dueOf = (id) => mockPg('invoice_followup_sequences').where({ id }).first().then((r) => r.next_touch_at);

  describe.each(['timestamp', 'timestamptz'])('next_touch_at is %s', (columnType) => {
    beforeAll(() => makeTable(columnType));

    test('a row stamped with now() (microseconds) is matched by the value pg returned, and retimed', async () => {
      const { claimStamp, row } = await claimedRow();
      const [{ micros }] = (await mockPg.raw(
        "SELECT (extract(microseconds FROM next_touch_at)::bigint % 1000) AS micros FROM invoice_followup_sequences WHERE id = ?", [row.id],
      )).rows;
      // now() carries sub-millisecond digits with overwhelming probability;
      // the sweep below makes the case exact regardless.
      expect(Number(micros)).toBeGreaterThanOrEqual(0);
      const before = await dueOf(row.id);
      expect(await hold(row, claimStamp, 'test')).toBe(true);
      expect((await dueOf(row.id)).getTime()).toBeGreaterThan(before.getTime());
    });

    test('every millisecond fraction with trailing microseconds round-trips (no float or rounding drift)', async () => {
      await mockPg.raw('TRUNCATE invoice_followup_sequences');
      const claimStamp = new Date();
      // 1000 rows: ms 000..999, each with 999 trailing microseconds.
      await mockPg.raw(
        `INSERT INTO invoice_followup_sequences (id, status, step_index, touch_claimed_at, next_touch_at)
         SELECT gen_random_uuid(), 'active', 0, ?::${columnType},
                '2026-05-26 13:00:00'::${columnType} + (g * interval '1 millisecond') + interval '999 microseconds'
         FROM generate_series(0, 999) g`, [claimStamp],
      );
      const rows = await mockPg('invoice_followup_sequences').select('id', 'next_touch_at');
      expect(rows).toHaveLength(1000);
      // The exact predicate the guard uses, for every row, against the value pg returned.
      const misses = [];
      for (let k = 0; k < rows.length; k += 50) {
        await Promise.all(rows.slice(k, k + 50).map(async (r) => {
          const { rows: [{ n }] } = await mockPg.raw(
            "SELECT count(*)::int AS n FROM invoice_followup_sequences WHERE id = ? AND date_trunc('milliseconds', next_touch_at) = ?",
            [r.id, new Date(r.next_touch_at)],
          );
          if (n !== 1) misses.push(r.next_touch_at.toISOString());
        }));
      }
      expect(misses).toEqual([]);
      // And the real guard end to end on a spread of them.
      for (const r of rows.filter((_x, index) => index % 37 === 0)) {
        const row = { id: r.id, step_index: 0, next_touch_at: r.next_touch_at, anchor_at: new Date() };
        expect(await hold(row, claimStamp, 'sweep')).toBe(true);
      }
    }, 60000);

    test('a next_touch_at that changed after the claim (send-now rewrite) matches 0 rows and is left alone', async () => {
      const { claimStamp, row } = await claimedRow();
      await mockPg('invoice_followup_sequences').where({ id: row.id }).update({ next_touch_at: new Date(Date.now() - 1000) });
      const rewritten = await dueOf(row.id);
      expect(await hold(row, claimStamp, 'test')).toBe(false);
      expect((await dueOf(row.id)).getTime()).toBe(rewritten.getTime());
    });

    test('another worker\'s claim stamp is left alone too', async () => {
      const { row } = await claimedRow();
      const before = await dueOf(row.id);
      expect(await hold(row, new Date(Date.now() - 60000), 'test')).toBe(false);
      expect((await dueOf(row.id)).getTime()).toBe(before.getTime());
    });
  });
});
