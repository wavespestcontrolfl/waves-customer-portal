// The page of one new home through PostgreSQL (services/mail/home-page.js, migration 20261123200000): each row's own
// 32-hex token, the price rule, the view counter, and a payload that never carries the recipient, parcel, permit or digest.
// Every write runs in a transaction that is rolled back. Synthetic names and addresses only. Skips without DATABASE_URL
// (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { getHomePage } = require('../services/mail/home-page');
const tokenMigration = require('../models/migrations/20261123200000_mail_prospects_page_token');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;

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

describeDb('New-home page (PostgreSQL)', () => {
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

  const HEX32 = /^[0-9a-f]{32}$/;
  const priced = { price_status: 'priced', price_annual: 627.01, price_setup_fee: 0, price_digest: 'DIGEST-SECRET-9X', priced_at: '2026-11-22T22:00:00Z' };
  const tokenOf = async (sourceRef) => (await mockPg('mail_prospects').where({ source_ref: sourceRef }).first('page_token')).page_token;
  const rowOf = (sourceRef) => mockPg('mail_prospects').where({ source_ref: sourceRef }).first();

  test('two rows get different 32-hex tokens from the column default', async () => {
    await mockPg('mail_prospects').insert([prospect({ source_ref: 'A1' }), prospect({ source_ref: 'A2' })]);
    const [a, b] = [await tokenOf('A1'), await tokenOf('A2')];
    expect(a).toMatch(HEX32);
    expect(b).toMatch(HEX32);
    expect(a).not.toBe(b);
  });

  test('the table refuses a token that is not 32 lowercase hex, a repeated token and a negative view count', async () => {
    await mockPg('mail_prospects').insert(prospect({ source_ref: 'B1' }));
    const token = await tokenOf('B1');
    for (const bad of ['ABCDEF0123456789ABCDEF0123456789', 'short', `${token}0`]) {
      await mockPg.raw('SAVEPOINT s');
      await expect(mockPg('mail_prospects').insert(prospect({ source_ref: 'B2', page_token: bad }))).rejects.toThrow();
      await mockPg.raw('ROLLBACK TO SAVEPOINT s');
    }
    await mockPg.raw('SAVEPOINT s');
    await expect(mockPg('mail_prospects').insert(prospect({ source_ref: 'B3', page_token: token }))).rejects.toThrow();
    await mockPg.raw('ROLLBACK TO SAVEPOINT s');
    await mockPg.raw('SAVEPOINT s');
    await expect(mockPg('mail_prospects').where({ source_ref: 'B1' }).update({ page_views: -1 })).rejects.toThrow();
    await mockPg.raw('ROLLBACK TO SAVEPOINT s');
  });

  test('the migration gives rows that already exist their own tokens, and running up again changes nothing', async () => {
    await tokenMigration.down(mockPg);
    expect(await mockPg.schema.hasColumn('mail_prospects', 'page_token')).toBe(false);
    await mockPg('mail_prospects').insert([prospect({ source_ref: 'M1' }), prospect({ source_ref: 'M2' }), prospect({ source_ref: 'M3' })]);
    await tokenMigration.up(mockPg);
    const tokens = [await tokenOf('M1'), await tokenOf('M2'), await tokenOf('M3')];
    tokens.forEach((token) => expect(token).toMatch(HEX32));
    expect(new Set(tokens).size).toBe(3);
    const first = await rowOf('M1');
    expect(first.page_views).toBe(0);
    expect(first.page_first_viewed_at).toBeNull();
    expect(first.page_last_viewed_at).toBeNull();
    await tokenMigration.up(mockPg);
    expect([await tokenOf('M1'), await tokenOf('M2'), await tokenOf('M3')]).toEqual(tokens);
  });

  test('a priced eligible home shows its price, monthly to the cent', async () => {
    await mockPg('mail_prospects').insert(prospect({ source_ref: 'P1', address_line1: '101 EXAMPLE TRL', ...priced }));
    const page = await getHomePage(await tokenOf('P1'));
    expect(page).toEqual({
      address: { line1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212' },
      price: { monthly: 52.25, annual: 627.01, setupFee: 0, pricedAt: '2026-11-22T22:00:00.000Z' },
      plan: 'pest_quarterly',
      heldUntil: null,
    });
  });

  test('held back, or not priced: the address and no price', async () => {
    await mockPg('mail_prospects').insert([
      prospect({ source_ref: 'H1', status: 'held_back', ...priced }),
      prospect({ source_ref: 'U1', price_status: 'missing_fact', price_reason: 'no_sqft' }),
      prospect({ source_ref: 'U2' }),
      prospect({ source_ref: 'U3', price_status: 'not_clean', price_reason: 'x' }),
    ]);
    for (const ref of ['H1', 'U1', 'U2', 'U3']) {
      const page = await getHomePage(await tokenOf(ref));
      expect(page.price).toBeNull();
      expect(page.address.zip).toBe('34212');
      expect(page.plan).toBe('pest_quarterly');
    }
  });

  test('another list, a not_eligible row, an unmatched row, a malformed and an unknown token: null', async () => {
    await mockPg('mail_prospects').insert([
      prospect({ source_ref: 'X1', list_key: 'other_list', ...priced }),
      prospect({ source_ref: 'N1', status: 'not_eligible', reason: 'company_buyer' }),
      prospect({ source_ref: 'N2', status: 'unmatched', reason: 'no_permit', address_line1: null }),
    ]);
    for (const ref of ['X1', 'N1', 'N2']) expect(await getHomePage(await tokenOf(ref), { recordView: true })).toBeNull();
    expect(await getHomePage('f'.repeat(32))).toBeNull();
    expect(await getHomePage("' OR 1=1 --")).toBeNull();
    // A null read counts nothing.
    const counts = await mockPg('mail_prospects').whereIn('source_ref', ['X1', 'N1', 'N2']).select('page_views');
    expect(counts.map((r) => r.page_views)).toEqual([0, 0, 0]);
  });

  test('the view counter: no count without recordView, +1 each open, the first time stays fixed, the last time moves', async () => {
    await mockPg('mail_prospects').insert(prospect({
      source_ref: 'V1', ...priced,
    }));
    const token = await tokenOf('V1');
    await getHomePage(token);
    await getHomePage(token, { recordView: false });
    let row = await rowOf('V1');
    expect(row.page_views).toBe(0);
    expect(row.page_first_viewed_at).toBeNull();

    await getHomePage(token, { recordView: true });
    row = await rowOf('V1');
    expect(row.page_views).toBe(1);
    expect(row.page_first_viewed_at).toBeInstanceOf(Date);
    expect(row.page_last_viewed_at).toBeInstanceOf(Date);

    // Put the first open in the past: a second open must leave it and move the last open (inside this transaction
    // now() is one value, so the past dates make the move visible).
    const past = new Date('2026-11-01T12:00:00Z');
    await mockPg('mail_prospects').where({ source_ref: 'V1' }).update({ page_first_viewed_at: past, page_last_viewed_at: past });
    await getHomePage(token, { recordView: true });
    row = await rowOf('V1');
    expect(row.page_views).toBe(2);
    expect(row.page_first_viewed_at.getTime()).toBe(past.getTime());
    expect(row.page_last_viewed_at.getTime()).toBeGreaterThan(past.getTime());
  });

  test('the payload never carries the recipient, the digest, the parcel, the permit or the deed fields', async () => {
    await mockPg('mail_prospects').insert(prospect({
      source_ref: 'S1', ...priced, price_reason: 'REASON-SECRET-7Q', parcel_pin: 'PIN-SECRET-5W', permit_no: 'PMT-SECRET-3E',
    }));
    const row = await rowOf('S1');
    const page = await getHomePage(row.page_token, { recordView: true });
    const json = JSON.stringify(page);
    for (const secret of ['TESTER', 'ALEX', 'DIGEST-SECRET-9X', 'REASON-SECRET-7Q', 'PIN-SECRET-5W', 'PMT-SECRET-3E',
      'SAMPLE BUILDER', '412345', 'LOT 12', 'REF-', 'new_home', 'manatee_clerk_deeds', row.id, row.page_token]) {
      expect(json).not.toContain(secret);
    }
    expect(Object.keys(page).sort()).toEqual(['address', 'heldUntil', 'plan', 'price']);
    expect(Object.keys(page.price).sort()).toEqual(['annual', 'monthly', 'pricedAt', 'setupFee']);
  });
});
