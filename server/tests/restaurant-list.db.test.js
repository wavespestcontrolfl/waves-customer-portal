// Restaurants list through PostgreSQL: the real SQL (the date window by Eastern day, the reasons, the food-truck,
// unread-report and 35B-only exclusions, the order) against restaurant_prospects, and the read time from job_health. Every
// write runs in a transaction that is rolled back. Synthetic names and addresses only. Skips without DATABASE_URL (CI runs
// it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  // Each transaction's settings are kept, so a test can check the list's snapshot (inside a test's own transaction
  // knex opens a savepoint and the settings do not apply; the real database opens BEGIN TRANSACTION with them).
  db.transaction = (...args) => { mockTransactionSettings.push(args[1]); return mockPg.transaction(...args); };
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { listRestaurants } = require('../services/prospects/restaurant-list');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
const mockTransactionSettings = [];

// 2026-11-19 12:00 ET. 30 days: Oct 21 to Nov 19. 90 days: Aug 22 to Nov 19. New: first read on or after Nov 12 17:00Z.
const NOW = new Date('2026-11-19T17:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS);

let seq = 0;
const prospect = (over) => {
  seq += 1;
  return {
    kind: 'new_license',
    source_key: `K-${seq}`,
    license_number: `SEA${String(seq).padStart(7, '0')}`,
    license_type_code: '2010',
    business_name: `SAMPLE DINER ${seq}`,
    address: '200 SAMPLE TRL',
    city: 'BRADENTON',
    zip: '34208',
    county: 'Manatee',
    phone: '9415550101',
    seats: 40,
    event_date: '2026-11-18',
    pest_evidence: null,
    detail: JSON.stringify({}),
    first_seen_at: daysAgo(30),
    last_seen_at: daysAgo(1),
    ...over,
  };
};
const ROACHES = [{ code: '35A-02-4', text: 'Live roaches seen in the dry storage area.' }];
const SYNC_JOB = 'restaurant-prospect-sync';
const syncRun = (over) => ({ job_name: SYNC_JOB, last_started_at: daysAgo(3), last_finished_at: daysAgo(3), last_success_at: daysAgo(3), last_status: 'success', ...over });

describeDb('Restaurants list (PostgreSQL)', () => {
  beforeAll(async () => {
    // Only this worktree's own QA database, or CI's: another worktree's database would have its rows deleted (inside a
    // transaction that is rolled back) and its writes blocked until the rollback. The URL carries no query options: one
    // there (?host=, ?sslmode=) could move the connection or change its TLS where this check cannot see.
    const url = new URL(process.env.DATABASE_URL);
    const ownedQa = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if ((!ownedQa && !ciTest) || url.search) {
      throw new Error('Use this worktree\'s private QA database or the isolated CI database, with no query options');
    }
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    mockPg = database;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    await mockPg('restaurant_prospects').del();
    await mockPg('job_health').where({ job_name: SYNC_JOB }).del();
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  test('lists the three reasons newest first and leaves out food trucks, unread or door-only reports and other days', async () => {
    await mockPg('restaurant_prospects').insert([
      prospect({ source_key: 'NEW', business_name: 'SAMPLE GRILL', event_date: '2026-11-18', first_seen_at: daysAgo(2) }),
      prospect({ kind: 'owner_change', source_key: 'OWNER', business_name: 'SAMPLE CAFE', event_date: '2026-11-10', first_seen_at: daysAgo(8) }),
      prospect({
        kind: 'inspection', source_key: '9001', license_id: '5001', business_name: 'SAMPLE BISTRO', event_date: '2026-11-12',
        pest_evidence: true, detail: JSON.stringify({ disposition: 'Warning Issued', findings: ROACHES }), phone: null, seats: null,
      }),
      prospect({ kind: 'inspection', source_key: '9002', event_date: '2026-11-13', pest_evidence: false }), // 35B only
      prospect({ kind: 'inspection', source_key: '9003', event_date: '2026-11-14', pest_evidence: null }), // not read yet
      prospect({ source_key: 'TRUCK', license_type_code: '2014', event_date: '2026-11-17' }), // a food truck
      prospect({ kind: 'owner_change', source_key: 'TRUCK-2', license_type_code: '2014', event_date: '2026-11-16' }),
      prospect({ source_key: 'EDGE', business_name: 'SAMPLE TAVERN', event_date: '2026-10-21' }), // the window's first day
      prospect({ source_key: 'BEFORE', event_date: '2026-10-20' }),
      prospect({ source_key: 'LATER', event_date: '2026-11-20' }), // a date after today: a typing slip
      prospect({ source_key: 'BLANK-TYPE', business_name: 'SAMPLE PANTRY', license_type_code: null, event_date: '2026-11-01' }),
    ]);
    await mockPg('job_health').insert(syncRun());

    const result = await listRestaurants({ days: 30, now: NOW });

    expect(result).toMatchObject({ days: 30, from: '2026-10-21', through: '2026-11-19' });
    expect(result.rows.map((row) => [row.eventDate, row.reason, row.name])).toEqual([
      ['2026-11-18', 'new_restaurant', 'SAMPLE GRILL'],
      ['2026-11-12', 'pest_finding', 'SAMPLE BISTRO'],
      ['2026-11-10', 'new_owner', 'SAMPLE CAFE'],
      ['2026-11-01', 'new_restaurant', 'SAMPLE PANTRY'],
      ['2026-10-21', 'new_restaurant', 'SAMPLE TAVERN'],
    ]);
    expect(result.counts).toEqual({ new_restaurant: 3, new_owner: 1, pest_finding: 1 });
    expect(result.rows[1]).toEqual({
      id: expect.any(String),
      reason: 'pest_finding',
      name: 'SAMPLE BISTRO',
      address: '200 SAMPLE TRL',
      city: 'BRADENTON',
      zip: '34208',
      county: 'Manatee',
      phone: null,
      seats: null,
      eventDate: '2026-11-12',
      licenseNumber: expect.stringMatching(/^SEA\d{7}$/),
      isNew: false,
      findings: ROACHES,
    });
    // First read 2 days ago: new this week. First read 8 days ago: not.
    expect(result.rows[0]).toMatchObject({ isNew: true, phone: '9415550101', seats: 40, findings: [] });
    expect(result.rows[2].isNew).toBe(false);
    // The job's last good run, not the rows' own last_seen_at (a day ago).
    expect(result.readAt).toBe(daysAgo(3).toISOString());
  });

  test('90 days reaches further back; a day is an Eastern day; one day ties by name', async () => {
    await mockPg('restaurant_prospects').insert([
      prospect({ source_key: 'A', business_name: 'SAMPLE B', event_date: '2026-08-22' }),
      prospect({ source_key: 'B', business_name: 'SAMPLE A', event_date: '2026-08-22' }),
      prospect({ source_key: 'C', event_date: '2026-08-21' }),
    ]);
    const ninety = await listRestaurants({ days: 90, now: NOW });
    expect(ninety.from).toBe('2026-08-22');
    expect(ninety.rows.map((row) => row.name)).toEqual(['SAMPLE A', 'SAMPLE B']);
    // 11:30 PM on Nov 19 Eastern is already Nov 20 in UTC: the window still ends on Nov 19.
    const late = await listRestaurants({ days: 30, now: new Date('2026-11-20T04:30:00Z') });
    expect([late.from, late.through]).toEqual(['2026-10-21', '2026-11-19']);
  });

  test('the counts cover the whole period when the list stops at 1,000 rows', async () => {
    const licenses = Array.from({ length: 1000 }, () => prospect({ event_date: '2026-11-18' }));
    for (let i = 0; i < licenses.length; i += 250) await mockPg('restaurant_prospects').insert(licenses.slice(i, i + 250));
    // Older than every license above, so past the cap.
    await mockPg('restaurant_prospects').insert([
      prospect({ kind: 'owner_change', event_date: '2026-10-25' }),
      prospect({ kind: 'owner_change', event_date: '2026-10-24' }),
      prospect({ kind: 'inspection', event_date: '2026-10-22', pest_evidence: true, detail: JSON.stringify({ findings: ROACHES }) }),
      prospect({ kind: 'inspection', event_date: '2026-10-22', pest_evidence: false }), // 35B only: not counted
    ]);
    const result = await listRestaurants({ days: 30, now: NOW });
    expect(result.rows).toHaveLength(1000);
    expect(result.rows.every((row) => row.reason === 'new_restaurant')).toBe(true);
    expect(result.counts).toEqual({ new_restaurant: 1000, new_owner: 2, pest_finding: 1 });
  });

  test('the pest count holds answered 35A inspections only: unread ones, callbacks and 35B-only answers are left out', async () => {
    const unread = (over) => prospect({ kind: 'inspection', event_date: '2026-11-15', pest_evidence: null, ...over });
    await mockPg('restaurant_prospects').insert([
      unread({ detail: JSON.stringify({ visitNumber: 1 }) }), // still to be read
      unread({ detail: JSON.stringify({ visitNumber: 1 }), detail_attempts: 3 }), // could not be read
      unread({ detail: JSON.stringify({ visitNumber: 2 }) }), // a callback
      prospect({ kind: 'inspection', event_date: '2026-11-15', pest_evidence: false }), // answered, 35B only
      prospect({ kind: 'inspection', event_date: '2026-11-15', pest_evidence: true, detail: JSON.stringify({ findings: ROACHES }) }),
    ]);
    const result = await listRestaurants({ days: 30, now: NOW });
    expect(result.counts.pest_finding).toBe(1);
    expect(result.rows.map((row) => row.reason)).toEqual(['pest_finding']);
  });

  test('before the first file read the answer is empty, with no read time', async () => {
    const result = await listRestaurants({ days: 30, now: NOW });
    expect(result).toEqual({
      days: 30, from: '2026-10-21', through: '2026-11-19', readAt: null, readUnfinishedSince: null, readFailedAt: null,
      counts: { new_restaurant: 0, new_owner: 0, pest_finding: 0 }, rows: [],
    });
  });

  test('a good run sets the read time; a failed run after it keeps the last good read and names the failure', async () => {
    await mockPg('job_health').insert(syncRun({ last_success_at: daysAgo(1), last_started_at: daysAgo(1), last_finished_at: daysAgo(1) }));
    const quiet = await listRestaurants({ days: 30, now: NOW });
    expect([quiet.readAt, quiet.readFailedAt, quiet.rows]).toEqual([daysAgo(1).toISOString(), null, []]);
    await mockPg('job_health').where({ job_name: SYNC_JOB })
      .update({ last_started_at: NOW, last_finished_at: NOW, last_status: 'failed', consecutive_failures: 1 });
    const failed = await listRestaurants({ days: 30, now: NOW });
    expect([failed.readAt, failed.readFailedAt]).toEqual([daysAgo(1).toISOString(), NOW.toISOString()]);
    // A run that started after the failure and has not finished is named, and the last finished run's outcome stays.
    const start = new Date(NOW.getTime() + 60000);
    await mockPg('job_health').where({ job_name: SYNC_JOB }).update({ last_started_at: start, last_status: 'running' });
    const reading = await listRestaurants({ days: 30, now: start });
    expect([reading.readUnfinishedSince, reading.readFailedAt]).toEqual([start.toISOString(), NOW.toISOString()]);
    // A good run after it clears the failure: it writes the finish and the success with one value.
    const later = new Date(NOW.getTime() + 120000);
    await mockPg('job_health').where({ job_name: SYNC_JOB })
      .update({ last_finished_at: later, last_success_at: later, last_status: 'success', consecutive_failures: 0 });
    const good = await listRestaurants({ days: 30, now: later });
    expect([good.readAt, good.readUnfinishedSince, good.readFailedAt]).toEqual([later.toISOString(), null, null]);
    // The next run starts. It has not finished, however long ago it started: cron-lock settles a dead run as failed
    // (settleDeadRunningJobs), and then its finish names the failure.
    const next = new Date(later.getTime() + 60000);
    await mockPg('job_health').where({ job_name: SYNC_JOB }).update({ last_started_at: next, last_status: 'running' });
    const soon = await listRestaurants({ days: 30, now: next });
    expect([soon.readAt, soon.readUnfinishedSince, soon.readFailedAt]).toEqual([later.toISOString(), next.toISOString(), null]);
    const days = await listRestaurants({ days: 30, now: new Date(next.getTime() + 3 * DAY_MS) });
    expect([days.readUnfinishedSince, days.readFailedAt]).toEqual([next.toISOString(), null]);
    const settled = new Date(next.getTime() + 15 * 60000);
    await mockPg('job_health').where({ job_name: SYNC_JOB }).update({ last_finished_at: settled, last_status: 'failed' });
    const dead = await listRestaurants({ days: 30, now: settled });
    expect([dead.readUnfinishedSince, dead.readFailedAt]).toEqual([null, settled.toISOString()]);
    await mockPg('job_health').where({ job_name: SYNC_JOB }).update({ last_started_at: later, last_finished_at: later });
    // A failed first run, with no good read before it.
    await mockPg('job_health').where({ job_name: SYNC_JOB }).update({ last_success_at: null, last_status: 'failed' });
    expect((await listRestaurants({ days: 30, now: NOW })).readFailedAt).toBe(later.toISOString());
  });

  test('the rows and the job state are read in one read-only REPEATABLE READ snapshot', async () => {
    mockTransactionSettings.length = 0;
    await listRestaurants({ days: 30, now: NOW });
    // knex adds its own keys to the settings it is given.
    expect(mockTransactionSettings).toEqual([expect.objectContaining({ isolationLevel: 'repeatable read', readOnly: true })]);
  });

  test('a period that is not offered is refused before any read', async () => {
    await expect(listRestaurants({ days: 7, now: NOW })).rejects.toThrow('unknown period');
  });
});
