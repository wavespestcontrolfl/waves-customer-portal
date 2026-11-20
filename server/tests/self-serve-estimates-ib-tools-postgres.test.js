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
// pre-push P1). A delivered one counts as sent at its first delivery, which a
// later suppressed resend never moves (sentAtSql; codex pre-push r16), and as
// viewed only from its delivery on (countableViewAtSql; codex pre-push r15).
// Only real rows prove the NULL-aware NOT IN, the JSON path and the guarded
// timestamp cast.
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

  async function insertCustomer() {
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Fixture', last_name: `Selfserve${customerId.slice(0, 6)}`,
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
      active: true, pipeline_stage: 'active_customer', monthly_rate: 0,
    });
    return customerId;
  }

  async function seed() {
    const customerId = await insertCustomer();
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
      // An unreadable delivery stamp: sent (dated by sent_at), no view counted, and no cast error.
      row('plan_start', 'viewed', delivered('not a date')),
      // An empty or JSON-null stamp is no delivery, in SQL and in JavaScript alike (codex pre-push P1).
      row('plan_start', 'viewed', delivered('')),
      row('plan_restart', 'viewed', delivered(null)),
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

  test('the SQL form of the rule agrees with the row form on every seeded row (the 9 AM Call today push reads the SQL form)', async () => {
    const { undeliveredSelfServeSql, isUndeliveredSelfServe } = require('../services/self-serve-estimates');
    await seed();
    const rows = await trx('estimates as e').where('e.service_interest', SERVICE)
      .select('e.source', 'e.estimate_data', trx.raw(`${undeliveredSelfServeSql('e')} AS flag`));
    expect(rows).toHaveLength(12);
    for (const row of rows) expect(Boolean(row.flag)).toBe(isUndeliveredSelfServe(row.source, row.estimate_data));
    // The five undelivered self-serve rows (two carry an empty or null stamp); a
    // source-NULL row and an unreadable stamp are not among them.
    expect(rows.filter((row) => row.flag)).toHaveLength(5);
  });

  test('a suppressed resend never moves a delivered self-serve quote across a reporting boundary (codex pre-push r16 P1)', async () => {
    // Staff delivered it March 30; a suppressed April 2 resend rewrote sent_at; the customer accepted April 5.
    const funnel = (from, to) => executeDashboardTool('get_estimate_funnel', { date_from: from, date_to: to });
    const sends = async () => {
      const out = await executeDashboardTool('compare_periods', { period_a: '2004-04', period_b: '2004-03', metrics: ['estimates_sent'] });
      return [out.period_a.metrics.estimates_sent, out.period_b.metrics.estimates_sent];
    };
    const marchBefore = await funnel('2004-03-01', '2004-03-31');
    const aprilBefore = await funnel('2004-04-01', '2004-04-30');
    const sendsBefore = await sends();
    // The response time below is this one quote's.
    expect(aprilBefore.funnel.accepted).toBe(0);
    await trx('estimates').insert({
      id: randomUUID(), customer_id: await insertCustomer(), source: 'plan_start', status: 'accepted',
      sent_at: '2004-04-02T15:00:00Z', accepted_at: '2004-04-05T15:00:00Z', service_interest: SERVICE,
      monthly_total: 50, onetime_total: 0,
      estimate_data: { deliveryState: { firstDeliveredAt: '2004-03-30T15:00:00Z', lastDeliveredAt: '2004-03-30T15:00:00Z' } },
    });
    const marchAfter = await funnel('2004-03-01', '2004-03-31');
    const aprilAfter = await funnel('2004-04-01', '2004-04-30');
    expect(marchAfter.funnel.sent - marchBefore.funnel.sent).toBe(1);
    expect(aprilAfter.funnel.sent - aprilBefore.funnel.sent).toBe(0);
    expect(aprilAfter.funnel.accepted - aprilBefore.funnel.accepted).toBe(1);
    // Six days from the delivery, not three from the rewritten sent_at.
    expect(aprilAfter.avg_response_hours).toBe('144.0');
    const sendsAfter = await sends();
    expect([sendsAfter[0] - sendsBefore[0], sendsAfter[1] - sendsBefore[1]]).toEqual([0, 1]);
  });

  test('a send on the last Eastern evening of a month counts in that month, in any session zone (codex pre-push P1)', async () => {
    // A naive date string reads in the session's zone; UTC here, so only real Eastern bounds pass.
    await trx.raw("SET LOCAL TIME ZONE 'UTC'");
    // 2005-02-01T03:00Z is 10 PM on January 31, Eastern.
    const LATE = '2005-02-01T03:00:00Z';
    const funnel = (from, to) => executeDashboardTool('get_estimate_funnel', { date_from: from, date_to: to });
    const compare = () => executeDashboardTool('compare_periods', {
      period_a: '2005-02', period_b: '2005-01', metrics: ['estimates_sent', 'estimates_accepted'],
    });
    const stages = (out) => [out.funnel.sent, out.funnel.accepted];
    const months = async () => ({
      jan: stages(await funnel('2005-01-01', '2005-01-31')),
      feb: stages(await funnel('2005-02-01', '2005-02-28')),
      compare: await compare(),
    });
    const before = await months();
    await trx('estimates').insert({
      id: randomUUID(), customer_id: await insertCustomer(), source: null, status: 'accepted',
      sent_at: LATE, accepted_at: LATE, service_interest: SERVICE, monthly_total: 50, onetime_total: 0,
      estimate_data: {},
    });
    const after = await months();
    expect([after.jan[0] - before.jan[0], after.jan[1] - before.jan[1]]).toEqual([1, 1]);
    expect([after.feb[0] - before.feb[0], after.feb[1] - before.feb[1]]).toEqual([0, 0]);
    const delta = (period, key) => after.compare[period].metrics[key] - before.compare[period].metrics[key];
    expect([delta('period_b', 'estimates_sent'), delta('period_b', 'estimates_accepted')]).toEqual([1, 1]);
    expect([delta('period_a', 'estimates_sent'), delta('period_a', 'estimates_accepted')]).toEqual([0, 0]);
  });
});
