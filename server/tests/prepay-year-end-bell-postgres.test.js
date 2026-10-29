// Real PostgreSQL transactions (rolled back) and the REAL notification service: the office bell before a
// prepaid year ends. Names are synthetic. Same harness as prepay-coverage-bell-refresh-postgres.test.js.
// The exact marker line CI's DB-gated step greps for (.github/workflows/tests.yml); any other gate form never runs there.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const { runPrepayYearEndBell, _private: { alertKey } } = require('../services/prepay-year-end-bell');

const TODAY = '2026-11-10';
const TERM_START = '2025-11-24';
const TERM_END = '2026-11-24';

jest.setTimeout(30000);
postgres('prepay year end bell (PostgreSQL)', () => {
  let database;
  let trx;

  const customer = async (overrides = {}) => {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Sample', last_name: 'Owner', phone: `fixture-${id.slice(0, 8)}`, email: `${id}@example.invalid`,
      billing_mode: 'annual_prepay', active: true, ...overrides,
    });
    return id;
  };
  const invoice = async (customerId, status) => {
    const id = randomUUID();
    await trx('invoices').insert({
      id, customer_id: customerId, token: id.replace(/-/g, ''), invoice_number: `TEST-${id.slice(0, 8)}`,
      status, total: 444.6, subtotal: 444.6, ...(status === 'paid' ? { paid_at: new Date('2026-10-01T16:00:00Z') } : {}),
    });
    return id;
  };
  const term = async (customerId, { status = 'active', start = TERM_START, end = TERM_END, decision = null, planVersion = null, invoiceId = null } = {}) => {
    const id = randomUUID();
    await trx('annual_prepay_terms').insert({
      id, customer_id: customerId, status, term_start: start, term_end: end, prepay_amount: 444.6, plan_label: 'Synthetic Annual',
      renewal_decision: decision, annual_plan_version: planVersion, prepay_invoice_id: invoiceId,
    });
    return id;
  };
  const run = (today = TODAY) => runPrepayYearEndBell({ conn: trx, today });
  const bells = (termId, end = TERM_END) => trx('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [alertKey(termId, end)])
    .select('title', 'body', 'detail', 'link', 'done_at', 'metadata');
  const openBells = async (termId, end = TERM_END) => (await bells(termId, end)).filter((row) => !row.done_at);

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_PREPAY_YEAR_END_BELL = 'true';
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });
  afterEach(async () => {
    delete process.env.GATE_PREPAY_YEAR_END_BELL;
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  test('raises one bell inside the window, with the customer link and the price rule in the detail', async () => {
    const owner = await customer();
    const id = await term(owner);
    expect(await run()).toEqual({ raised: 1, closed: 0 });
    const [bell] = await openBells(id);
    expect(bell.title).toBe("Billing — send Sample Owner next year's prepay");
    expect(bell.body).toBe('Prepaid year ends Nov 24; if nobody acts, the plan stops booking.');
    expect(bell.link).toBe(`/admin/customers?customerId=${owner}`);
    expect(bell.detail).toContain('visits x visit price - 5%');
    expect(bell.metadata).toMatchObject({ customerId: owner, termId: id, termEnd: TERM_END, doneWhen: 'prepay_year_settled' });
  });

  test('not raised 31 days before the term ends; raised 30 days before; raised 60 days after; not 61 days after', async () => {
    const early = await term(await customer(), { end: '2026-12-10' });
    expect((await run('2026-11-09')).raised).toBe(0); // 31 days before
    expect(await openBells(early, '2026-12-10')).toHaveLength(0);
    expect((await run('2026-11-10')).raised).toBe(1); // 30 days before
    expect(await openBells(early, '2026-12-10')).toHaveLength(1);

    const late = await term(await customer(), { end: '2026-08-01' });
    expect((await run('2026-09-30')).raised).toBe(1); // 60 days after
    expect(await openBells(late, '2026-08-01')).toHaveLength(1);
    const tooLate = await term(await customer(), { end: '2026-07-31' });
    expect((await run('2026-09-30')).raised).toBe(0); // 61 days after
    expect(await openBells(tooLate, '2026-07-31')).toHaveLength(0);
  });

  test('a renewal_pending term is raised; an unpaid first year and a refunded year are not', async () => {
    const pending = await term(await customer(), { status: 'renewal_pending' });
    const firstYear = await term(await customer(), { status: 'payment_pending', invoiceId: await invoice(await customer(), 'sent') });
    const refunded = await term(await customer(), { status: 'refunded' });
    expect((await run()).raised).toBe(1);
    expect(await openBells(pending)).toHaveLength(1);
    expect(await openBells(firstYear)).toHaveLength(0);
    expect(await openBells(refunded)).toHaveLength(0);
  });

  test('a renew decision alone (status renewed) stays open', async () => {
    const id = await term(await customer(), { status: 'renewed', decision: 'renew' });
    await run();
    expect(await openBells(id)).toHaveLength(1);
    expect(await run()).toMatchObject({ closed: 0 });
    expect(await openBells(id)).toHaveLength(1);
  });

  test('a later term that is paid and live closes the bell, and nothing is raised again', async () => {
    const owner = await customer();
    const id = await term(owner);
    await run();
    expect(await openBells(id)).toHaveLength(1);
    await term(owner, { status: 'payment_pending', start: '2026-11-25', end: '2027-11-24', invoiceId: await invoice(owner, 'paid') });
    expect(await run()).toEqual({ raised: 0, closed: 1 });
    expect(await openBells(id)).toHaveLength(0);
    expect(await run()).toEqual({ raised: 0, closed: 0 });
  });

  test('a later term already live (active) also closes it', async () => {
    const owner = await customer();
    const id = await term(owner);
    await run();
    await term(owner, { status: 'active', start: '2026-11-25', end: '2027-11-24' });
    expect((await run()).closed).toBe(1);
    expect(await openBells(id)).toHaveLength(0);
  });

  test('a later term that is NOT paid keeps the bell open', async () => {
    const owner = await customer();
    const id = await term(owner);
    await term(owner, { status: 'payment_pending', start: '2026-11-25', end: '2027-11-24', invoiceId: await invoice(owner, 'sent') });
    await run();
    expect(await run()).toEqual({ raised: 0, closed: 0 });
    expect(await openBells(id)).toHaveLength(1);
  });

  test('an EARLIER paid term does not close it', async () => {
    const owner = await customer();
    await term(owner, { start: '2024-11-24', end: '2025-11-24' });
    const id = await term(owner);
    await run();
    expect(await openBells(id)).toHaveLength(1);
  });

  test.each([
    ['a cancel decision', { status: 'cancelled', decision: 'cancel' }],
    ['a switch plan decision', { status: 'switch_plan', decision: 'switch_plan' }],
    ['a cancelled status', { status: 'cancelled' }],
  ])('%s closes it', async (_name, options) => {
    const owner = await customer();
    const id = await term(owner);
    await run();
    expect(await openBells(id)).toHaveLength(1);
    await trx('annual_prepay_terms').where({ id }).update({ status: options.status, renewal_decision: options.decision || null });
    expect((await run()).closed).toBe(1);
    expect(await openBells(id)).toHaveLength(0);
  });

  test('a customer moved to per application closes it and is not raised', async () => {
    const owner = await customer();
    const id = await term(owner);
    await run();
    expect(await openBells(id)).toHaveLength(1);
    await trx('customers').where({ id: owner }).update({ billing_mode: 'per_application' });
    expect(await run()).toEqual({ raised: 0, closed: 1 });
    expect(await openBells(id)).toHaveLength(0);

    const other = await term(await customer({ billing_mode: 'per_application' }));
    expect((await run()).raised).toBe(0);
    expect(await openBells(other)).toHaveLength(0);
  });

  test('a settled term closes a bell raised earlier at any age, even 300 days after the year ended', async () => {
    const owner = await customer();
    const id = await term(owner);
    await run();
    await trx('annual_prepay_terms').where({ id }).update({ status: 'cancelled', renewal_decision: 'cancel' });
    expect((await run('2027-09-20')).closed).toBe(1); // 300 days after 2026-11-24
    expect(await openBells(id)).toHaveLength(0);
  });

  test('a bell whose year end moved closes, and the moved year end gets its own bell', async () => {
    const id = await term(await customer());
    await run();
    expect(await openBells(id)).toHaveLength(1);
    await trx('annual_prepay_terms').where({ id }).update({ term_end: '2026-12-05' });
    expect(await run()).toEqual({ raised: 1, closed: 1 });
    expect(await openBells(id)).toHaveLength(0);
    expect(await openBells(id, '2026-12-05')).toHaveLength(1);
  });

  test('a bell whose term became a termite plan closes', async () => {
    const id = await term(await customer());
    await run();
    await trx('annual_prepay_terms').where({ id }).update({ annual_plan_version: 'v3' });
    expect((await run()).closed).toBe(1);
    expect(await openBells(id)).toHaveLength(0);
  });

  test('time passing alone never closes an unsettled bell', async () => {
    const id = await term(await customer());
    await run();
    await run('2027-02-01'); // 69 days after: no new bell, the old one stays
    await run('2027-06-01');
    expect(await openBells(id)).toHaveLength(1);
  });

  test('a termite term (annual_plan_version set) is never raised', async () => {
    const id = await term(await customer(), { planVersion: 'v3' });
    expect((await run()).raised).toBe(0);
    expect(await bells(id)).toHaveLength(0);
  });

  test('a deleted customer is not raised, and an open bell closes', async () => {
    const gone = await customer({ deleted_at: new Date('2026-10-01T12:00:00Z') });
    const goneTerm = await term(gone);
    expect((await run()).raised).toBe(0);
    expect(await bells(goneTerm)).toHaveLength(0);

    const owner = await customer();
    const id = await term(owner);
    await run();
    expect(await openBells(id)).toHaveLength(1);
    await trx('customers').where({ id: owner }).update({ deleted_at: new Date('2026-11-02T12:00:00Z') });
    expect((await run()).closed).toBe(1);
    expect(await openBells(id)).toHaveLength(0);
  });

  test('two runs leave one open bell', async () => {
    const id = await term(await customer());
    expect(await run()).toEqual({ raised: 1, closed: 0 });
    expect(await run()).toEqual({ raised: 0, closed: 0 });
    expect(await bells(id)).toHaveLength(1);
    expect(await openBells(id)).toHaveLength(1);
  });

  test('a term whose only visit is not an ongoing series: the plan stops booking', async () => {
    const owner = await customer();
    const id = await term(owner);
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: owner, annual_prepay_term_id: id, service_type: 'Quarterly Pest Control', status: 'confirmed',
      scheduled_date: '2026-12-01', is_recurring: false, recurring_ongoing: false,
    });
    await run();
    const [bell] = await openBells(id);
    expect(bell.body).toBe('Prepaid year ends Nov 24; if nobody acts, the plan stops booking.');
  });
});
