// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or against a local disposable database.
//
// A self-serve quote the customer opened from the portal (plan restart, plan
// start: its sent_at is a mint stamp, nothing was delivered) is not an
// estimate staff sent. The Intelligence Bar's compare_periods send count and
// its estimate funnel (every stage, the sent cohort by service, open
// follow-ups, the accepted value) leave it out unless staff really delivered
// it (deliveryState.firstDeliveredAt). A source-NULL legacy row stays in
// (whereNotUndeliveredSelfServe, services/self-serve-estimates.js; codex
// pre-push P1). A delivered one counts as viewed only from its delivery on
// (countableViewAtSql; codex pre-push r15). Only real rows prove the
// NULL-aware NOT IN, the JSON path and the guarded timestamp cast.
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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

postgres('self-serve quotes in the Intelligence Bar estimate tools against migrated PostgreSQL', () => {
  let database;
  let trx;
  let executeDashboardTool;
  // An old month no migration seed writes estimates in; the assertions are deltas anyway.
  const AT = '2003-02-11T15:00:00Z';
  const DELIVERED = '2003-02-12T15:00:00Z';
  const LATER = '2003-02-13T15:00:00Z';
  const SERVICE = 'Fixture self-serve quote';

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    ({ executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools'));
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function seed() {
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Fixture', last_name: `Selfserve${customerId.slice(0, 6)}`,
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
      active: true, pipeline_stage: 'active_customer', monthly_rate: 0,
    });
    const row = (source, status, estimateData = {}, lastViewedAt = null) => ({
      id: randomUUID(), customer_id: customerId, source, status, sent_at: AT, viewed_at: AT,
      last_viewed_at: lastViewedAt, accepted_at: status === 'accepted' ? AT : null, service_interest: SERVICE,
      monthly_total: 50, onetime_total: 0, estimate_data: estimateData,
    });
    const delivered = (firstDeliveredAt) => ({ deliveryState: { firstDeliveredAt } });
    await trx('estimates').insert([
      row(null, 'viewed'), // a legacy staff send: counts
      row('plan_start', 'viewed'), // undelivered self-serve: never counts
      row('plan_restart', 'viewed'), // undelivered self-serve: never counts
      row('plan_start', 'viewed', { deliveryState: { firstDeliveredAt: AT } }), // staff delivered it: counts
      row(null, 'accepted'), // a staff send the customer accepted: counts
      row('plan_start', 'accepted'), // an undelivered self-serve quote the customer accepted
      // Delivered after the customer's portal look: sent, not viewed ...
      row('plan_start', 'viewed', delivered(DELIVERED)),
      row('plan_restart', 'viewed', delivered(DELIVERED)),
      // ... until a view after the send, which counts.
      row('plan_start', 'viewed', delivered(DELIVERED), LATER),
      // An unreadable delivery stamp: sent, no view counted, and no cast error.
      row('plan_start', 'viewed', delivered('not a date')),
    ]);
  }

  test('the funnel counts only estimates staff delivered, at every stage', async () => {
    const funnel = () => executeDashboardTool('get_estimate_funnel', { date_from: '2003-02-01', date_to: '2003-02-28' });
    const before = await funnel();
    await seed();
    const after = await funnel();
    const delta = (key) => after.funnel[key] - before.funnel[key];
    expect(delta('sent')).toBe(7);
    expect(delta('viewed')).toBe(4);
    expect(delta('accepted')).toBe(1);
    expect(delta('pending')).toBe(6);
    expect(after.total_accepted_value - before.total_accepted_value).toBe(50);
    const service = after.by_service.find((s) => s.service === SERVICE);
    expect(service).toMatchObject({ sent: 7, won: 1, open: 6 });
  });

  test('compare_periods counts the same sends; its accepted count still includes a self-serve acceptance', async () => {
    const compare = () => executeDashboardTool('compare_periods', {
      period_a: '2003-02', period_b: '2003-01', metrics: ['estimates_sent', 'estimates_accepted'],
    });
    const before = await compare();
    await seed();
    const after = await compare();
    const delta = (key) => after.period_a.metrics[key] - before.period_a.metrics[key];
    expect(delta('estimates_sent')).toBe(7);
    expect(delta('estimates_accepted')).toBe(2);
  });
});
