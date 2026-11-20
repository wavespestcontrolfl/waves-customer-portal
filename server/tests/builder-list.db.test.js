// Builders list through PostgreSQL: the real SQL (date filters, grouping, OWN and canceled exclusions, new-build filter,
// customer match, the job-site read) against the two permit tables. Every write runs in a transaction that is rolled back.
// Synthetic builders and addresses only. Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { listBuilders, builderPermits } = require('../services/prospects/builder-list');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;

// 2026-11-19 12:00 ET. 7-day cutoff Nov 13, 30-day Oct 21, 90-day Aug 22, 365-day Nov 20 2025.
const NOW = new Date('2026-11-19T17:00:00Z');

const pool = (over) => ({ record_id: `P-${Math.random().toString(36).slice(2, 10)}`, record_status: 'Permit Issued', issued_date: '2026-11-10', address_line1: '200 SAMPLE TRL', city: 'PARRISH', zip: '34219', contractor_name: 'SAMPLE POOLS LLC', contractor_license: 'CPC111', ...over });
const home = (over) => ({ permit_no: `H-${Math.random().toString(36).slice(2, 10)}`, status: 'Permit Issued', permit_type: 'Residential', type_of_work: 'New Single Family', issued_date: '2026-11-10', address_raw: '300 SAMPLE CT  PARRISH 34219', zip: '34219', contractor_name: 'SAMPLE HOMES INC', contractor_license: 'CGC333', ...over });

describeDb('Builders list (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    mockPg = database;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    await mockPg('pool_permit_records').del();
    await mockPg('construction_permit_records').del();
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  test('pool: merges spellings and licenses, counts windows by Eastern date, leaves out owner-builders, blanks and canceled', async () => {
    await mockPg('pool_permit_records').insert([
      pool({ issued_date: '2026-11-15' }),
      pool({ issued_date: '2026-11-13', contractor_name: 'Sample Pools, L.L.C.', contractor_license: 'CPC222' }),
      pool({ issued_date: '2026-10-21' }),
      pool({ issued_date: '2026-09-01' }),
      pool({ issued_date: '2025-11-20' }),
      pool({ issued_date: '2025-11-19' }), // 366 days back: outside 12 months
      pool({ issued_date: '2026-11-12', record_status: 'Canceled' }),
      pool({ contractor_name: 'SAMPLE OWNER', contractor_license: 'OWN123' }),
      pool({ contractor_name: '  ', contractor_license: 'CPC999' }),
      pool({ contractor_name: 'FRESH POOLS INC', contractor_license: 'CPC444', issued_date: '2026-11-02' }),
      pool({ contractor_name: 'ANCIENT POOLS INC', contractor_license: 'CPC555', issued_date: '2025-01-02' }),
    ]);
    const result = await listBuilders({ kind: 'pool', now: NOW });

    expect(result.dataThrough).toBe('2026-11-15');
    expect(result.builders.map((builder) => builder.key)).toEqual(['SAMPLE POOLS', 'FRESH POOLS']);
    expect(result.builders[0]).toEqual({
      key: 'SAMPLE POOLS', name: 'SAMPLE POOLS LLC', license: 'CPC111',
      permits30: 3, permits90: 4, permits365: 5, firstPermit: '2025-11-19', lastPermit: '2026-11-15', isNew: false, isCustomer: false,
    });
    expect(result.builders[1]).toMatchObject({ key: 'FRESH POOLS', permits30: 1, firstPermit: '2026-11-02', isNew: true });
    // The week is the 7 days ending on the newest permit on file (Nov 9 to Nov 15): Nov 15 and Nov 13 (SAMPLE POOLS).
    // The canceled Nov 12 permit and FRESH POOLS (Nov 2) are outside it.
    expect(result.week).toEqual({ from: '2026-11-09', through: '2026-11-15', permits: 2, builders: 1 });
  });

  test('home: only new builds on a residential permit, canceled and withdrawn left out, ordered by 90-day permits', async () => {
    await mockPg('construction_permit_records').insert([
      home(), home({ issued_date: '2026-11-11' }),
      home({ type_of_work: 'New Villa', contractor_name: 'SAMPLE VILLAS CORP', contractor_license: 'CGC444' }),
      home({ type_of_work: 'New Duplex', contractor_name: 'SAMPLE VILLAS CORP', contractor_license: 'CGC444' }),
      home({ type_of_work: 'Alteration' }),
      home({ status: 'Canceled' }),
      home({ status: 'Withdrawn' }),
      // Commercial new builds are not homes, even when the work type starts with "New".
      home({ permit_type: 'Commercial', type_of_work: 'New', contractor_name: 'SAMPLE COMMERCIAL BUILDERS INC', contractor_license: 'CGC555' }),
      home({ permit_type: 'Commercial', type_of_work: 'New Multi-Family Residential', contractor_name: 'SAMPLE COMMERCIAL BUILDERS INC', contractor_license: 'CGC555' }),
    ]);
    const result = await listBuilders({ kind: 'home', now: NOW });
    expect(result.builders.map((builder) => [builder.key, builder.permits90])).toEqual([['SAMPLE HOMES', 2], ['SAMPLE VILLAS', 2]]);
    const sites = await builderPermits({ kind: 'home', key: 'SAMPLE COMMERCIAL BUILDERS', now: NOW });
    expect(sites).toEqual([]);
  });

  test('a permit dated after today counts nowhere: not in the windows, not as the first or newest permit, not as a job site', async () => {
    await mockPg('pool_permit_records').insert([
      pool({ record_id: 'A-1', issued_date: '2026-11-15' }),
      pool({ record_id: 'A-2', issued_date: '2026-11-20' }), // tomorrow, Eastern time
      pool({ record_id: 'F-1', contractor_name: 'FUTURE POOLS INC', contractor_license: 'CPC777', issued_date: '2026-11-21' }),
    ]);
    const result = await listBuilders({ kind: 'pool', now: NOW });
    expect(result.dataThrough).toBe('2026-11-15');
    expect(result.builders).toEqual([expect.objectContaining({ key: 'SAMPLE POOLS', permits30: 1, permits365: 1, lastPermit: '2026-11-15' })]);
    expect(result.week).toEqual({ from: '2026-11-09', through: '2026-11-15', permits: 1, builders: 1 });
    // The job sites agree with the list: the future permit never pushes a real one off the page.
    const sites = await builderPermits({ kind: 'pool', key: 'SAMPLE POOLS', limit: 1, now: NOW });
    expect(sites.map((site) => site.id)).toEqual(['A-1']);
    expect(await builderPermits({ kind: 'pool', key: 'FUTURE POOLS', now: NOW })).toEqual([]);
  });

  test('a builder that matches an active payer or a live customer company is flagged; an inactive payer is not', async () => {
    await mockPg('pool_permit_records').insert([
      pool(), pool({ contractor_name: 'FRESH POOLS INC', contractor_license: 'CPC444' }), pool({ contractor_name: 'IDLE POOLS LLC', contractor_license: 'CPC666' }),
      // The county spells it with the accent; the payer was typed without it.
      pool({ contractor_name: 'PEÑA SAMPLE POOLS LLC', contractor_license: 'CPC888' }),
    ]);
    await mockPg('payers').insert([
      { display_name: 'Sample Pools, LLC', active: true },
      { display_name: 'Idle Pools', company_name: 'Idle Pools LLC', active: false },
      { display_name: 'Pena Sample Pools', active: true },
    ]);
    const result = await listBuilders({ kind: 'pool', now: NOW });
    const flags = Object.fromEntries(result.builders.map((builder) => [builder.key, builder.isCustomer]));
    expect(flags).toEqual({ 'SAMPLE POOLS': true, 'FRESH POOLS': false, 'IDLE POOLS': false, 'PENA SAMPLE POOLS': true });
    const sites = await builderPermits({ kind: 'pool', key: 'PENA SAMPLE POOLS', now: NOW });
    expect(sites).toHaveLength(1);
  });

  test('job sites: every spelling of the builder, newest first, the limit applied, no other builder, no canceled permit', async () => {
    await mockPg('pool_permit_records').insert([
      pool({ record_id: 'A-1', issued_date: '2026-11-01' }),
      pool({ record_id: 'A-2', issued_date: '2026-11-14', contractor_name: 'Sample Pools, L.L.C.', contractor_license: 'CPC222' }),
      pool({ record_id: 'A-3', issued_date: '2026-11-08' }),
      pool({ record_id: 'A-4', issued_date: '2026-11-15', record_status: 'Canceled' }),
      pool({ record_id: 'B-1', issued_date: '2026-11-16', contractor_name: 'FRESH POOLS INC', contractor_license: 'CPC444' }),
    ]);
    const sites = await builderPermits({ kind: 'pool', key: 'SAMPLE POOLS', limit: 2, now: NOW });
    expect(sites.map((site) => [site.id, site.issuedDate])).toEqual([['A-2', '2026-11-14'], ['A-3', '2026-11-08']]);
    expect(sites[0]).toEqual({ id: 'A-2', issuedDate: '2026-11-14', status: 'Permit Issued', address: '200 SAMPLE TRL', city: 'PARRISH', zip: '34219', typeOfWork: null });
  });

  test('home job sites carry the type of work and the one-line address', async () => {
    await mockPg('construction_permit_records').insert([home({ permit_no: 'H-1' })]);
    const sites = await builderPermits({ kind: 'home', key: 'SAMPLE HOMES', now: NOW });
    expect(sites).toEqual([{ id: 'H-1', issuedDate: '2026-11-10', status: 'Permit Issued', address: '300 SAMPLE CT  PARRISH 34219', city: null, zip: '34219', typeOfWork: 'New Single Family' }]);
  });
});
