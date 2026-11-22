// New-home mail list through PostgreSQL: the real SQL (the counts over the whole list, each view's filter, the order, the
// 300-row cap, dates read as text) against mail_prospects. Every write runs in a transaction that is rolled back.
// Synthetic names and addresses only. Skips without DATABASE_URL (CI runs it against the migrated database).
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
const { VIEWS, listMailProspects } = require('../services/prospects/mail-list');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
const mockTransactionSettings = [];

let seq = 0;
// A live row needs a parcel and a permit (table CHECK), and live parcels and permits are unique per list.
const prospect = (over) => {
  seq += 1;
  const live = ['eligible', 'held_back'].includes((over && over.status) || 'eligible');
  return {
    list_key: 'new_home',
    source: 'manatee_clerk_deeds',
    source_ref: `REF-${seq}`,
    recorded_date: '2026-11-18',
    seller_names: JSON.stringify(['SAMPLE BUILDER LLC']),
    recipient_names: JSON.stringify(['TESTER ALEX J']),
    buyer_kind: 'person',
    consideration: 412345.67,
    legal_description: 'LOT 12 SAMPLETON ESTATES PH 2',
    status: 'eligible',
    reason: null,
    match_basis: 'lot_block',
    parcel_pin: live ? `PIN${String(seq).padStart(7, '0')}` : null,
    permit_no: live ? `PMT-${seq}` : null,
    co_date: '2026-10-30',
    address_line1: `${100 + seq} EXAMPLE TRL`,
    city: 'SAMPLETON',
    zip: '34212',
    subdivision: 'SAMPLETON ESTATES',
    living_sqft: 2100,
    last_checked_at: '2026-11-21T15:00:00Z',
    ...over,
  };
};

describeDb('New-home mail list (PostgreSQL)', () => {
  beforeAll(async () => {
    // Only this worktree's own QA database, or CI's: another worktree's database would have its rows deleted (inside a
    // transaction that is rolled back) and its writes blocked until the rollback. The URL carries no query options: one
    // there (?host=, ?sslmode=) could move the connection or change its TLS where this check cannot see.
    const url = new URL(process.env.DATABASE_URL);
    // The ID must be the full 32 hex characters: a missing or cut-off ID would admit "/waves_qa_" or a look-alike name.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const ownedQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && url.pathname === `/waves_qa_${worktreeId}`;
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if ((!ownedQa && !ciTest) || url.search) {
      throw new Error('Use this worktree\'s private QA database or the isolated CI database, with no query options');
    }
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    mockPg = database;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    await mockPg('mail_prospects').del();
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  const seedAll = () => mockPg('mail_prospects').insert([
    prospect({ source_ref: 'E1', recorded_date: '2026-11-18', address_line1: '300 EXAMPLE TRL' }),
    prospect({ source_ref: 'E2', recorded_date: '2026-11-20', address_line1: '200 EXAMPLE TRL' }),
    prospect({ source_ref: 'H1', status: 'held_back', recorded_date: '2026-11-19' }),
    prospect({ source_ref: 'N1', status: 'not_eligible', reason: 'company_buyer', recorded_date: '2026-11-17', buyer_kind: 'company' }),
    prospect({ source_ref: 'N2', status: 'not_eligible', reason: 'company_buyer', recorded_date: '2026-11-16' }),
    prospect({ source_ref: 'N3', status: 'not_eligible', reason: 'trust_buyer', recorded_date: '2026-11-15' }),
    prospect({ source_ref: 'U1', status: 'unmatched', reason: 'no_permit', recorded_date: '2026-11-14', address_line1: null }),
    // Another list: never counted, never listed.
    prospect({ list_key: 'other_list', source_ref: 'X1', recorded_date: '2026-11-25', last_checked_at: '2026-11-25T15:00:00Z' }),
  ]);

  test('the live view lists eligible and held-back homes, newest deed first; counts cover every status', async () => {
    await seedAll();
    const result = await listMailProspects({ view: 'live' });
    expect(result.view).toBe('live');
    expect(result.rows.map((row) => [row.recordedDate, row.status])).toEqual([
      ['2026-11-20', 'eligible'], ['2026-11-19', 'held_back'], ['2026-11-18', 'eligible'],
    ]);
    expect(result.counts).toEqual({ eligible: 2, heldBack: 1, notEligible: 3, unmatched: 1 });
    expect(result.truncated).toBe(false);
  });

  test('live is the default view', async () => {
    await seedAll();
    expect((await listMailProspects()).view).toBe('live');
    expect(VIEWS).toEqual(['live', 'not_eligible', 'unmatched']);
  });

  test('the not_eligible and unmatched views list only their own status, with the reason', async () => {
    await seedAll();
    const notEligible = await listMailProspects({ view: 'not_eligible' });
    expect(notEligible.rows.map((row) => [row.status, row.reason])).toEqual([
      ['not_eligible', 'company_buyer'], ['not_eligible', 'company_buyer'], ['not_eligible', 'trust_buyer'],
    ]);
    const unmatched = await listMailProspects({ view: 'unmatched' });
    expect(unmatched.rows.map((row) => [row.status, row.reason, row.addressLine1])).toEqual([['unmatched', 'no_permit', null]]);
    // The counts are the same list whichever view is asked for.
    expect(unmatched.counts).toEqual(notEligible.counts);
  });

  test('reasons group the not_eligible and unmatched rows, biggest first, whichever view is asked for', async () => {
    await seedAll();
    const expected = [
      { status: 'not_eligible', reason: 'company_buyer', count: 2 },
      { status: 'not_eligible', reason: 'trust_buyer', count: 1 },
      { status: 'unmatched', reason: 'no_permit', count: 1 },
    ];
    expect((await listMailProspects({ view: 'live' })).reasons).toEqual(expected);
    expect((await listMailProspects({ view: 'unmatched' })).reasons).toEqual(expected);
  });

  test('a day with several deeds is ordered by address, then id', async () => {
    await mockPg('mail_prospects').insert([
      prospect({ source_ref: 'A', address_line1: '20 EXAMPLE TRL', parcel_pin: 'P-A', permit_no: 'T-A' }),
      prospect({ source_ref: 'B', address_line1: '10 EXAMPLE TRL', parcel_pin: 'P-B', permit_no: 'T-B' }),
      prospect({ source_ref: 'C', status: 'unmatched', reason: 'no_lot', address_line1: '30 EXAMPLE TRL' }),
    ]);
    const live = await listMailProspects({ view: 'live' });
    expect(live.rows.map((row) => row.addressLine1)).toEqual(['10 EXAMPLE TRL', '20 EXAMPLE TRL']);
  });

  test('newestRecordedDate and lastCheckedAt cover the whole list of this key, not only the view', async () => {
    await seedAll();
    await mockPg('mail_prospects').where({ source_ref: 'U1' }).update({ last_checked_at: '2026-11-22T09:30:00Z', recorded_date: '2026-11-14' });
    const result = await listMailProspects({ view: 'live' });
    expect(result.newestRecordedDate).toBe('2026-11-20'); // not the other list's 2026-11-25
    expect(result.lastCheckedAt).toBe('2026-11-22T09:30:00.000Z');
  });

  test('dates are YYYY-MM-DD text, with no day slip', async () => {
    await mockPg('mail_prospects').insert(prospect({ source_ref: 'D', recorded_date: '2026-03-08', co_date: '2026-11-01' }));
    const [row] = (await listMailProspects({ view: 'live' })).rows;
    expect([row.recordedDate, row.coDate]).toEqual(['2026-03-08', '2026-11-01']);
    expect((await listMailProspects()).newestRecordedDate).toBe('2026-03-08');
  });

  test('a row carries the screen fields only: no sale price, sellers, parcel or permit number, or deed reference', async () => {
    await mockPg('mail_prospects').insert(prospect({ source_ref: 'F', co_date: null, living_sqft: null }));
    const [row] = (await listMailProspects({ view: 'live' })).rows;
    expect(row).toEqual({
      id: expect.any(String),
      recordedDate: '2026-11-18',
      status: 'eligible',
      reason: null,
      recipientNames: ['TESTER ALEX J'],
      addressLine1: expect.stringMatching(/ EXAMPLE TRL$/),
      city: 'SAMPLETON',
      zip: '34212',
      subdivision: 'SAMPLETON ESTATES',
      matchBasis: 'lot_block',
      coDate: null,
      livingSqft: null,
      legalDescription: 'LOT 12 SAMPLETON ESTATES PH 2',
    });
    const text = JSON.stringify(await listMailProspects({ view: 'live' }));
    expect(text).not.toMatch(/412345|SAMPLE BUILDER|PIN\d|PMT-|REF-|consideration|seller|parcel|permit/i);
  });

  test('at most 300 rows come back and truncated says more matched; the counts stay whole', async () => {
    const rows = Array.from({ length: 301 }, (_, i) => prospect({
      source_ref: `BULK-${i}`, status: 'not_eligible', reason: 'no_lot', recorded_date: '2026-10-01', address_line1: `${1000 + i} EXAMPLE TRL`,
    }));
    await mockPg('mail_prospects').insert(rows);
    const over = await listMailProspects({ view: 'not_eligible' });
    expect([over.rows.length, over.truncated, over.counts.notEligible]).toEqual([300, true, 301]);
    expect(over.reasons).toEqual([{ status: 'not_eligible', reason: 'no_lot', count: 301 }]);
    await mockPg('mail_prospects').where({ source_ref: 'BULK-0' }).del();
    const exact = await listMailProspects({ view: 'not_eligible' });
    expect([exact.rows.length, exact.truncated]).toEqual([300, false]);
  });

  test('an empty table gives zero counts and null dates', async () => {
    expect(await listMailProspects()).toEqual({
      view: 'live',
      counts: { eligible: 0, heldBack: 0, notEligible: 0, unmatched: 0 },
      reasons: [],
      newestRecordedDate: null,
      lastCheckedAt: null,
      rows: [],
      truncated: false,
    });
  });

  test('the totals and the rows are read in one read-only REPEATABLE READ snapshot', async () => {
    mockTransactionSettings.length = 0;
    await listMailProspects();
    // knex adds its own keys to the settings it is given.
    expect(mockTransactionSettings).toEqual([expect.objectContaining({ isolationLevel: 'repeatable read', readOnly: true })]);
  });

  test('a view that is not offered is refused before any read', async () => {
    await expect(listMailProspects({ view: 'held_back' })).rejects.toThrow('unknown view');
  });
});
