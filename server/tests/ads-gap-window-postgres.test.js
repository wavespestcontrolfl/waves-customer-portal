// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// The gap rule's per-day stop count (BudgetManager.getGapWindow) counts PHYSICAL
// stops the way the dispatcher does: a visit_id group is one stop, a legacy
// null-visit_id co-visit (same customer, same window) is one stop, two windows
// for one customer are two stops, and a windowless placeholder still counts.
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
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
const { randomUUID } = require('node:crypto');
const BudgetManager = require('../services/ads/budget-manager');
const { etDateString, addETDays } = require('../utils/datetime-et');

postgres('gap window stop count against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let otherCustomerId;
  const now = new Date();
  const day = etDateString(addETDays(now, 1)); // the window starts tomorrow
  const settings = { ...BudgetManager.GAP_RULE_DEFAULTS, window_days: 1 };

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    jest.spyOn(BudgetManager, 'getTechCountForArea').mockResolvedValue(1);
    customerId = await customer();
    otherCustomerId = await customer();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  async function customer() {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    return id;
  }
  async function visitGroup(forCustomer) {
    const id = randomUUID();
    await trx('service_visits').insert({ id, customer_id: forCustomer, scheduled_date: day,
      stop_base_key: `fixture-${id}`, created_by: 'test' });
    return id;
  }
  async function row(overrides = {}) {
    const [r] = await trx('scheduled_services').insert({ id: randomUUID(), customer_id: customerId,
      service_type: 'Quarterly Pest Control Service', status: 'pending', scheduled_date: day, ...overrides }).returning('*');
    return r;
  }
  async function stops() {
    const win = await BudgetManager.getGapWindow(now, settings);
    expect(win.days).toHaveLength(1);
    expect(win.days[0].date).toBe(day);
    return win.days[0].stops;
  }

  test('two rows of one visit_id group are one stop', async () => {
    const visitId = await visitGroup(customerId);
    await row({ visit_id: visitId, window_start: '09:00', window_end: '11:00' });
    await row({ visit_id: visitId, window_start: '09:00', window_end: '11:00', service_type: 'Lawn Care Service' });
    expect(await stops()).toBe(1);
  });

  test('same customer, same window, no visit_id is one stop', async () => {
    await row({ window_start: '09:00', window_end: '11:00' });
    await row({ window_start: '09:00', window_end: '11:00', service_type: 'Lawn Care Service' });
    expect(await stops()).toBe(1);
  });

  test('same customer in two different windows is two stops', async () => {
    await row({ window_start: '09:00', window_end: '11:00' });
    await row({ window_start: '13:00', window_end: '15:00' });
    expect(await stops()).toBe(2);
  });

  test('different customers in the same window are separate stops', async () => {
    await row({ window_start: '09:00', window_end: '11:00' });
    await row({ customer_id: otherCustomerId, window_start: '09:00', window_end: '11:00' });
    expect(await stops()).toBe(2);
  });

  test('a windowless placeholder still counts as one stop', async () => {
    await row({ window_start: null, window_end: null });
    expect(await stops()).toBe(1);
  });

  test('a cancelled row and an expired reservation count for nothing', async () => {
    await row({ status: 'cancelled', window_start: '09:00', window_end: '11:00' });
    await row({ customer_id: otherCustomerId, window_start: '09:00', window_end: '11:00',
      reservation_expires_at: new Date(Date.now() - 60 * 60 * 1000) });
    expect(await stops()).toBe(0);
  });

  test('a reservation that has not expired still counts', async () => {
    await row({ window_start: '09:00', window_end: '11:00', reservation_expires_at: new Date(Date.now() + 60 * 60 * 1000) });
    expect(await stops()).toBe(1);
  });
});
