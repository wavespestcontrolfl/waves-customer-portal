/**
 * Waves Pest Insider "Your home" facts against real Postgres (services/pest-insider/home.js loadHomeFacts), by
 * subscriber id. The last visit is the latest service_records day that is 'completed' (a NULL status counts, as
 * in the Waves app's own history) and not after today (Eastern); "since" is customers.member_since. A reader
 * gets an entry only when its link is unambiguous: the customer is live and active, has the reader's address,
 * shares that address with no other live customer and its account with no sibling profile, has at most one
 * active saved property, a lived-in one (owner_occupied or seasonal, not commercial), is not a commercial
 * account, and its last visit is at most 365 days old. Real Postgres, because the LATERAL joins, the NOT EXISTS
 * rules and the array_agg are the parts that can be wrong.
 * Runs in CI's DB-gated step or this worktree's private QA database; every test runs in one transaction that is
 * rolled back, so no row stays. Synthetic rows only.
 */
jest.setTimeout(60000);

// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});

const { randomUUID } = require('crypto');

postgres('Pest Insider "Your home" facts (real Postgres)', () => {
  const db = require('../models/db');
  const { loadHomeFacts } = require('../services/pest-insider/home');
  let database;
  const NOW = new Date('2026-11-21T15:00:00Z');

  async function customer(over = {}) {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture', email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
      member_since: '2024-03-05', ...over,
    });
    return id;
  }
  // The subscriber for a customer, on the customer's own address unless told otherwise; returns its id.
  async function reader(customerId, email) {
    const row = email ? { email } : { email: (await db('customers').where({ id: customerId }).first('email')).email };
    const [inserted] = await db('newsletter_subscribers').insert({ ...row, status: 'active', customer_id: customerId }).returning('id');
    return typeof inserted === 'object' ? inserted.id : inserted;
  }
  const record = (customerId, date, serviceType = 'Quarterly Pest Control', status = 'completed') => db('service_records')
    .insert({ id: randomUUID(), customer_id: customerId, service_date: date, service_type: serviceType, status });
  const property = (customerId, over = {}) => db('customer_properties')
    .insert({ customer_id: customerId, occupancy_type: 'owner_occupied', active: true, ...over });
  // A customer with a recent visit and a reader: the base case every exclusion test varies.
  async function eligible(customerOver = {}, readerEmail) {
    const c = await customer(customerOver);
    await record(c, '2026-11-05');
    return { c, s: await reader(c, readerEmail) };
  }

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId)
      && target.pathname === `/waves_qa_${worktreeId}`;
    if (!ci && !ownedQA) throw new Error('Use the isolated CI database or this worktree\'s private QA database');
    // The driver copies every query parameter of a connection string into its
    // settings, so the pool gets the parts checked above, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
  });

  beforeEach(async () => { db.connection = await database.transaction(); });
  afterEach(async () => { await db.connection?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  test('the last visit is the latest completed record up to today; member since is the since date; the line is the day\'s one line', async () => {
    const c = await customer({ member_since: '2024-03-05' });
    await record(c, '2025-08-20', 'Lawn Care Visit');
    await record(c, '2026-02-10', 'Mosquito Control');
    await record(c, '2026-11-05', 'Quarterly Pest Control');
    const s = await reader(c);
    const facts = await loadHomeFacts(db, [s], NOW);
    expect(facts.get(s)).toEqual({ customerId: c, lastVisit: { date: '2026-11-05', line: 'pest' }, sinceDate: '2024-03-05' });
  });

  test('a record with a NULL status counts as completed; a non-completed or future-dated record does not', async () => {
    const c = await customer();
    const s = await reader(c);
    await record(c, '2026-06-01');
    await db('service_records').insert({ id: randomUUID(), customer_id: c, service_date: '2026-09-09', service_type: 'Quarterly Pest Control', status: null });
    for (const status of ['scheduled', 'in_progress', 'cancelled']) await record(c, '2026-11-18', 'Quarterly Pest Control', status);
    await record(c, '2026-11-22');
    await record(c, '2026-12-15');
    expect((await loadHomeFacts(db, [s], NOW)).get(s).lastVisit.date).toBe('2026-09-09');
    // A visit dated today counts.
    await record(c, '2026-11-21');
    expect((await loadHomeFacts(db, [s], NOW)).get(s).lastVisit.date).toBe('2026-11-21');
  });

  test('today is the Eastern date: a record on the 21st is not yet finished late on the 20th Eastern', async () => {
    const c = await customer();
    const s = await reader(c);
    await record(c, '2026-11-20');
    await record(c, '2026-11-21');
    expect((await loadHomeFacts(db, [s], new Date('2026-11-21T03:00:00Z'))).get(s).lastVisit.date).toBe('2026-11-20');
  });

  test('member since is what the customer has, or null: never the first record', async () => {
    const c = await customer({ member_since: null });
    await record(c, '2025-08-20');
    await record(c, '2026-11-05');
    const s = await reader(c);
    expect((await loadHomeFacts(db, [s], NOW)).get(s).sinceDate).toBeNull();
    await db('customers').where({ id: c }).update({ member_since: '2023-01-31' });
    expect((await loadHomeFacts(db, [s], NOW)).get(s).sinceDate).toBe('2023-01-31');
  });

  test('two service names on the last day: from two lines gives no label, from one line gives that line', async () => {
    const two = await customer();
    await record(two, '2026-11-05', 'Quarterly Pest Control');
    await record(two, '2026-11-05', 'Lawn Care Visit');
    await record(two, '2026-10-01', 'Mosquito Control');
    const one = await customer();
    await record(one, '2026-11-05', 'Lawn Care Visit');
    await record(one, '2026-11-05', 'Lawn Care Visit #2');
    const [sTwo, sOne] = [await reader(two), await reader(one)];
    const facts = await loadHomeFacts(db, [sTwo, sOne], NOW);
    expect(facts.get(sTwo).lastVisit.line).toBeNull();
    expect(facts.get(sOne).lastVisit.line).toBe('lawn');
  });

  test('a saved owner-occupied or seasonal property, or none, is a lived-in home', async () => {
    const withOne = await eligible();
    await property(withOne.c);
    const seasonal = await eligible();
    await property(seasonal.c, { occupancy_type: 'seasonal' });
    const none = await eligible();
    const facts = await loadHomeFacts(db, [withOne.s, seasonal.s, none.s], NOW);
    expect([...facts.keys()].sort()).toEqual([withOne.s, seasonal.s, none.s].sort());
  });

  test.each([
    ['an archived customer', { deleted_at: new Date('2026-10-01T00:00:00Z') }],
    ['an inactive customer', { active: false }],
    ['a commercial property type', { property_type: 'commercial' }],
    ['a business property type', { property_type: 'business' }],
    // The tier's stored spelling (customers_waveguard_tier_check allows 'Commercial', capitalized).
    ['the commercial tier', { waveguard_tier: 'Commercial' }],
  ])('%s has no entry', async (_label, over) => {
    const { s } = await eligible(over);
    expect((await loadHomeFacts(db, [s], NOW)).size).toBe(0);
  });

  test('a reader whose address is not the one the customer has on file has no entry (any letter case or spacing still matches)', async () => {
    const { c, s } = await eligible();
    const other = await reader(c, `other-${randomUUID()}@example.invalid`);
    const { email } = await db('customers').where({ id: c }).first('email');
    const spaced = await reader(c, ` ${email.toUpperCase()} `);
    const facts = await loadHomeFacts(db, [s, other, spaced], NOW);
    expect([...facts.keys()].sort()).toEqual([s, spaced].sort());
    // A customer with no address on file has no entry for anyone.
    await db('customers').where({ id: c }).update({ email: '' });
    expect((await loadHomeFacts(db, [s, other, spaced], NOW)).size).toBe(0);
  });

  test('another live customer with the same address leaves the reader out; an archived one does not', async () => {
    const { c, s } = await eligible();
    const { email } = await db('customers').where({ id: c }).first('email');
    const archived = await customer({ email, deleted_at: new Date('2026-10-01T00:00:00Z') });
    expect(archived).toBeDefined();
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(true);
    await customer({ email: email.toUpperCase() });
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(false);
  });

  test('a sibling profile on the account leaves the reader out, whichever profile the reader is linked to; an inactive or archived sibling does not', async () => {
    const [account] = await db('customer_accounts').insert({ first_name: 'Synthetic' }).returning('id');
    const accountId = typeof account === 'object' ? account.id : account;
    const a = await eligible({ account_id: accountId });
    expect((await loadHomeFacts(db, [a.s], NOW)).has(a.s)).toBe(true);
    await customer({ account_id: accountId, active: false });
    await customer({ account_id: accountId, deleted_at: new Date('2026-10-01T00:00:00Z') });
    expect((await loadHomeFacts(db, [a.s], NOW)).has(a.s)).toBe(true);
    const sibling = await customer({ account_id: accountId });
    await record(sibling, '2026-11-05');
    const sibReader = await reader(sibling);
    const facts = await loadHomeFacts(db, [a.s, sibReader], NOW);
    expect(facts.size).toBe(0);
    // A customer who is the account itself (account_id NULL, another profile pointing at its id) has a sibling too.
    const root = await eligible();
    const rootReader = root.s;
    expect((await loadHomeFacts(db, [rootReader], NOW)).has(rootReader)).toBe(true);
    // customers.account_id references customer_accounts(id): the root's own id needs an account row.
    await db('customer_accounts').insert({ id: root.c, first_name: 'Synthetic' });
    await customer({ account_id: root.c });
    expect((await loadHomeFacts(db, [rootReader], NOW)).has(rootReader)).toBe(false);
  });

  test('two active saved properties leave the reader out; one active and one retired does not', async () => {
    const { c, s } = await eligible();
    await property(c, { active: false });
    await property(c);
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(true);
    await property(c);
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(false);
  });

  test.each([
    ['rental_investment', {}],
    ['family_occupied', {}],
    ['commercial', {}],
    ['vacant', {}],
    ['unknown', {}],
    ['owner_occupied', { property_type: 'commercial' }],
    ['owner_occupied', { property_type: 'Business' }],
  ])('a saved property with occupancy %s %j leaves the reader out', async (occupancy, over) => {
    const { c, s } = await eligible();
    await property(c, { occupancy_type: occupancy, ...over });
    expect((await loadHomeFacts(db, [s], NOW)).size).toBe(0);
  });

  test('a retired rental property does not leave the reader out', async () => {
    const { c, s } = await eligible();
    await property(c, { occupancy_type: 'rental_investment', active: false });
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(true);
  });

  test('a last visit over 365 days old has no entry; exactly 365 days old still does; no record at all has none', async () => {
    const old = await customer();
    await record(old, '2024-05-01');
    await record(old, '2025-11-20');
    const edge = await customer();
    await record(edge, '2025-11-21');
    const none = await customer();
    const [sOld, sEdge, sNone] = [await reader(old), await reader(edge), await reader(none)];
    const facts = await loadHomeFacts(db, [sOld, sEdge, sNone], NOW);
    expect([...facts.keys()]).toEqual([sEdge]);
  });

  test('two readers do not mix: each has its own customer, dates and line', async () => {
    const a = await customer({ member_since: '2023-02-01' });
    const b = await customer({ member_since: '2025-09-15' });
    await record(a, '2026-10-01', 'Lawn Care Visit');
    await record(b, '2026-05-01', 'Termite Inspection');
    await record(b, '2026-11-01', 'Spring special');
    const [sA, sB] = [await reader(a), await reader(b)];
    const facts = await loadHomeFacts(db, [sA, sB], NOW);
    expect(facts.get(sA)).toEqual({ customerId: a, lastVisit: { date: '2026-10-01', line: 'lawn' }, sinceDate: '2023-02-01' });
    expect(facts.get(sB)).toEqual({ customerId: b, lastVisit: { date: '2026-11-01', line: null }, sinceDate: '2025-09-15' });
  });

  test('a reader with no customer, an empty list and a reader not asked for return nothing', async () => {
    const lead = (await db('newsletter_subscribers').insert({ email: `lead-${randomUUID()}@example.invalid`, status: 'active' }).returning('id'))[0];
    const leadId = typeof lead === 'object' ? lead.id : lead;
    const asked = await eligible();
    const other = await eligible();
    expect((await loadHomeFacts(db, [leadId], NOW)).size).toBe(0);
    expect((await loadHomeFacts(db, [], NOW)).size).toBe(0);
    expect([...(await loadHomeFacts(db, [asked.s], NOW)).keys()]).toEqual([asked.s]);
    expect(other.s).not.toBe(asked.s);
  });
});
