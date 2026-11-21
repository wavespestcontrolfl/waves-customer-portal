/**
 * Waves Pest Insider "Your home" facts against real Postgres (services/pest-insider/home.js loadHomeFacts):
 * the count, the first and the latest finished visit, one customer at a time. A visit counts only when it is
 * 'completed' and dated on or before today (Eastern); a future or unfinished visit never does. A customer who is
 * archived (deleted_at) or inactive (active = false), or whose latest finished visit is over 365 days old, has no
 * entry. DISTINCT ON plus window aggregates in one read: real Postgres, because that is the part that can be wrong.
 * Runs in CI's DB-gated step or this worktree's private QA database; every test runs in one transaction that is
 * rolled back, so no row stays. Synthetic customers only.
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
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer', ...over,
    });
    return id;
  }
  const visit = (customerId, date, status = 'completed', serviceType = 'Quarterly Pest Control') => db('scheduled_services')
    .insert({ id: randomUUID(), customer_id: customerId, scheduled_date: date, status, service_type: serviceType });

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

  test('the count, the first finished visit and the latest one, with the latest visit\'s service line', async () => {
    const c = await customer();
    await visit(c, '2025-01-15', 'completed', 'Lawn Care Visit');
    await visit(c, '2026-02-10', 'completed', 'Mosquito Control');
    await visit(c, '2026-11-05', 'completed', 'Quarterly Pest Control');
    const facts = await loadHomeFacts(db, [c], NOW);
    expect(facts.get(c)).toEqual({ lastVisit: { date: '2026-11-05', line: 'pest' }, sinceDate: '2025-01-15', visitCount: 3 });
  });

  test('a visit dated today counts; one dated tomorrow, or one that is not completed, never does', async () => {
    const c = await customer();
    await visit(c, '2026-06-01');
    await visit(c, '2026-11-21');
    await visit(c, '2026-11-22');
    await visit(c, '2026-12-15');
    for (const status of ['pending', 'confirmed', 'cancelled', 'rescheduled']) await visit(c, '2026-11-18', status);
    const facts = await loadHomeFacts(db, [c], NOW);
    expect(facts.get(c)).toEqual({ lastVisit: { date: '2026-11-21', line: 'pest' }, sinceDate: '2026-06-01', visitCount: 2 });
  });

  test('today is the Eastern date: a visit on the 21st is not yet finished late on the 20th Eastern', async () => {
    const c = await customer();
    await visit(c, '2026-11-20');
    await visit(c, '2026-11-21');
    const facts = await loadHomeFacts(db, [c], new Date('2026-11-21T03:00:00Z'));
    expect(facts.get(c).lastVisit.date).toBe('2026-11-20');
    expect(facts.get(c).visitCount).toBe(1);
  });

  test('a customer with no finished visit, an archived customer and an inactive customer have no entry', async () => {
    const none = await customer();
    await visit(none, '2026-11-25', 'pending');
    const archived = await customer({ deleted_at: new Date('2026-10-01T00:00:00Z') });
    await visit(archived, '2026-11-01');
    const inactive = await customer({ active: false });
    await visit(inactive, '2026-11-01');
    const live = await customer();
    await visit(live, '2026-11-01');
    const facts = await loadHomeFacts(db, [none, archived, inactive, live], NOW);
    expect([...facts.keys()]).toEqual([live]);
  });

  test('a latest finished visit over 365 days old has no entry; exactly 365 days old still does', async () => {
    const old = await customer();
    await visit(old, '2024-05-01');
    await visit(old, '2025-11-20');
    const edge = await customer();
    await visit(edge, '2025-11-21');
    const facts = await loadHomeFacts(db, [old, edge], NOW);
    expect([...facts.keys()]).toEqual([edge]);
    expect(facts.get(edge).visitCount).toBe(1);
  });

  test('two customers do not mix: each has its own count, dates and line', async () => {
    const a = await customer();
    const b = await customer();
    await visit(a, '2025-03-01', 'completed', 'Lawn Care Visit');
    await visit(a, '2026-10-01', 'completed', 'Lawn Care Visit');
    await visit(b, '2026-04-01', 'completed', 'Termite Inspection');
    await visit(b, '2026-05-01', 'completed', 'Rodent Exclusion');
    await visit(b, '2026-11-01', 'completed', 'Spring special');
    const facts = await loadHomeFacts(db, [a, b], NOW);
    expect(facts.get(a)).toEqual({ lastVisit: { date: '2026-10-01', line: 'lawn' }, sinceDate: '2025-03-01', visitCount: 2 });
    expect(facts.get(b)).toEqual({ lastVisit: { date: '2026-11-01', line: null }, sinceDate: '2026-04-01', visitCount: 3 });
  });

  test('two finished visits on the latest day give one entry for the customer', async () => {
    const c = await customer();
    await visit(c, '2026-11-01', 'completed', 'Lawn Care Visit');
    await visit(c, '2026-11-01', 'completed', 'Quarterly Pest Control');
    const facts = await loadHomeFacts(db, [c], NOW);
    expect(facts.size).toBe(1);
    expect(facts.get(c).visitCount).toBe(2);
  });

  test('an empty list reads nothing, and a customer not asked for is not returned', async () => {
    const asked = await customer();
    const other = await customer();
    await visit(asked, '2026-11-01');
    await visit(other, '2026-11-01');
    expect((await loadHomeFacts(db, [], NOW)).size).toBe(0);
    expect([...(await loadHomeFacts(db, [asked], NOW)).keys()]).toEqual([asked]);
  });
});
