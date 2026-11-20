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
// The Pipeline board lists one once staff deliver it, never a plan restart
// quote. Only real rows prove the NULL-aware NOT IN, the JSON path and the
// guarded timestamp cast.
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
    // Real rows are written: only CI's disposable database or a dedicated
    // waves_qa_<32 hex> one, never a shared or forwarded database (codex pre-push P1).
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    const privateQA = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!ciTest && !privateQA) throw new Error('Use the disposable CI database or a dedicated waves_qa_<32 hex> database');
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
      row('service_report_cta', 'viewed'), // an undelivered report-card quote: never counts
      row('plan_start', 'viewed', { deliveryState: { firstDeliveredAt: AT } }), // staff delivered it: counts
      row(null, 'accepted'), // a staff send the customer accepted: counts
      row('plan_start', 'accepted'), // an undelivered self-serve quote the customer accepted
      // Delivered after the customer's portal look: sent, not viewed ...
      row('plan_start', 'viewed', delivered(DELIVERED)),
      row('plan_restart', 'viewed', delivered(DELIVERED)),
      // ... until a view after the send, which counts.
      row('plan_start', 'viewed', delivered(DELIVERED), LATER),
      // An unreadable delivery stamp: a staff send dated by sent_at, its views counted from then
      // (one anchor for both, as win/loss reads it; codex pre-push P1), and no cast error.
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
    expect(delta('viewed')).toBe(5);
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
    expect(rows).toHaveLength(13);
    for (const row of rows) expect(Boolean(row.flag)).toBe(isUndeliveredSelfServe(row.source, row.estimate_data));
    // The six undelivered self-serve rows (two carry an empty or null stamp); a
    // source-NULL row and an unreadable stamp are not among them.
    expect(rows.filter((row) => row.flag)).toHaveLength(6);
  });

  test('the reports read a first delivery only as a complete ISO instant, in SQL and JavaScript alike; the watchers read any real timestamp; no stamp aborts a query (codex pre-push P1)', async () => {
    const { deliveryInstantSql, firstDeliveredAtMs, sentAtSql } = require('../services/self-serve-estimates');
    const iso = ['2005-07-04T15:00:00.000Z', '2005-07-04T15:00:00Z', '2005-07-04T11:00:00.5-04:00', '2005-07-04T15:00:00.123456Z'];
    // Real timestamps PostgreSQL alone reads (JavaScript cannot, or reads
    // them differently): the reports date such a send by sent_at; the watchers read them.
    const pgOnly = ['2005-07-04 15:00:00 America/New_York', '2005-07-04T15:00:00', '2005-07-04', '2005-07-04T24:00:00Z'];
    // No instant for anyone: special literals, a day that does not exist, year 0.
    const none = ['now', 'infinity', 'today', '2005-02-30T15:00:00.000Z', '0000-01-01T00:00:00Z', 'not a date'];
    const stamps = [...iso, ...pgOnly, ...none];
    const { rows } = await trx.raw(`
      SELECT e.stamp, ${deliveryInstantSql('e', 'lastDeliveredAt')} AS last_delivered, ${sentAtSql('e')} AS sent_anchor,
             ${sentAtSql('e')} IS DISTINCT FROM e.sent_at AS report_delivered
      FROM (SELECT s.stamp, 'plan_start'::text AS source, ?::timestamptz AS sent_at,
                   jsonb_build_object('deliveryState', jsonb_build_object('firstDeliveredAt', s.stamp, 'lastDeliveredAt', s.stamp)) AS estimate_data
            FROM jsonb_array_elements_text(?::jsonb) AS s(stamp)) e`, [AT, JSON.stringify(stamps)]);
    expect(rows.map((row) => row.stamp).sort()).toEqual([...stamps].sort());
    for (const row of rows) {
      const js = firstDeliveredAtMs({ deliveryState: { firstDeliveredAt: row.stamp } });
      // One anchor in SQL and JavaScript: the first delivery, else sent_at.
      expect([row.stamp, row.sent_anchor.getTime()]).toEqual([row.stamp, js ?? Date.parse(AT)]);
    }
    const read = (key) => rows.filter((row) => row[key]).map((row) => row.stamp).sort();
    expect(read('report_delivered')).toEqual([...iso].sort());
    expect(stamps.filter((stamp) => firstDeliveredAtMs({ deliveryState: { firstDeliveredAt: stamp } }) != null).sort())
      .toEqual([...iso].sort());
    expect(read('last_delivered')).toEqual([...iso, ...pgOnly].sort());
  });

  test('the dashboard service-line card loads past an unreadable delivery stamp (codex pre-push P1)', async () => {
    const { computeServiceLines } = require('../services/dashboard-service-lines');
    await seed();
    // March: the seeded February sends and views are outside it, so the stamp check runs on every seeded row.
    const result = await computeServiceLines({ from: '2003-03-01', to: '2003-03-31' }, { now: new Date('2003-03-15T12:00:00Z') });
    expect(result.caveats.join(' ')).not.toMatch(/Close rate and open estimates could not be loaded/);
  });

  test('the Pipeline board lists a self-serve quote once staff deliver it, and never a plan restart quote (codex pre-push P1)', async () => {
    const { fetchEstimates } = require('../routes/admin-pipeline').__private;
    await seed();
    const customerId = await insertCustomer();
    const reportCard = (estimateData) => ({
      id: randomUUID(), customer_id: customerId, source: 'service_report_cta', status: 'viewed', sent_at: AT, viewed_at: AT,
      service_interest: SERVICE, monthly_total: 50, onetime_total: 0, estimate_data: estimateData,
    });
    await trx('estimates').insert([reportCard({ deliveryState: { firstDeliveredAt: DELIVERED } }), reportCard({})]);
    const listed = (await fetchEstimates({})).filter((e) => e.service_interest === SERVICE)
      .map((e) => `${e.source}|${e.estimate_data?.deliveryState?.firstDeliveredAt ?? null}|${e.status}`);
    expect(listed.sort()).toEqual([
      'null|null|accepted',
      'null|null|viewed',
      `plan_start|${AT}|viewed`,
      `plan_start|${DELIVERED}|viewed`,
      `plan_start|${DELIVERED}|viewed`,
      // A present but unreadable stamp still records a staff send.
      'plan_start|not a date|viewed',
      `service_report_cta|${DELIVERED}|viewed`,
    ].sort());
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

  test('an acceptance before the send it answers counts as accepted but has no response time (codex pre-push P1)', async () => {
    const funnel = () => executeDashboardTool('get_estimate_funnel', { date_from: '2005-06-01', date_to: '2005-06-30' });
    const before = await funnel();
    expect(before.funnel.accepted).toBe(0);
    const customerId = await insertCustomer();
    const quote = (acceptedAt) => ({
      id: randomUUID(), customer_id: customerId, source: 'plan_start', status: 'accepted',
      sent_at: '2005-06-10T15:00:00Z', accepted_at: acceptedAt, service_interest: SERVICE, monthly_total: 50, onetime_total: 0,
      estimate_data: { deliveryState: { firstDeliveredAt: '2005-06-10T15:00:00Z' } },
    });
    // One accepted in the portal an hour before the staff send stamped its delivery; one a day after.
    await trx('estimates').insert([quote('2005-06-10T14:00:00Z'), quote('2005-06-11T15:00:00Z')]);
    const after = await funnel();
    expect(after.funnel.accepted - before.funnel.accepted).toBe(2);
    expect(after.avg_response_hours).toBe('24.0');
  });

  test('compare_periods counts a churn by its churned_at day, or else by the Eastern day of updated_at, in any session zone (codex pre-push P1)', async () => {
    await trx.raw("SET LOCAL TIME ZONE 'UTC'");
    const churned = async () => {
      const out = await executeDashboardTool('compare_periods', { period_a: '2006-02', period_b: '2006-01', metrics: ['churn'] });
      return [out.period_a.metrics.churned, out.period_b.metrics.churned];
    };
    const before = await churned();
    // No churned_at, last updated 10 PM Eastern on January 31 (3 AM UTC, February 1); and one churned January 31.
    const noDate = await insertCustomer();
    const dated = await insertCustomer();
    await trx('customers').where({ id: noDate }).update({ active: false, churned_at: null, updated_at: '2006-02-01T03:00:00Z' });
    await trx('customers').where({ id: dated }).update({ active: false, churned_at: '2006-01-31', updated_at: '2006-02-15T15:00:00Z' });
    const after = await churned();
    expect([after[0] - before[0], after[1] - before[1]]).toEqual([0, 2]);
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

  test('a delivered self-serve quote counts as viewed at its first known open after delivery; a later open never moves it (codex pre-push P1)', async () => {
    const viewedIn = async (from, to) => (await executeDashboardTool('get_estimate_funnel', { date_from: from, date_to: to })).funnel.viewed;
    const months = async () => [await viewedIn('2006-03-01', '2006-03-31'), await viewedIn('2006-04-01', '2006-04-30')];
    const before = await months();
    const customerId = await insertCustomer();
    const quote = async (viewedAt, lastViewedAt, loggedOpens) => {
      const id = randomUUID();
      await trx('estimates').insert({
        id, customer_id: customerId, source: 'plan_start', status: 'viewed',
        sent_at: '2006-03-01T15:00:00Z', viewed_at: viewedAt, last_viewed_at: lastViewedAt,
        service_interest: SERVICE, monthly_total: 50, onetime_total: 0,
        estimate_data: { deliveryState: { firstDeliveredAt: '2006-03-01T15:00:00Z' } },
      });
      await trx('estimate_views').insert(loggedOpens.map((at) => ({ estimate_id: id, viewed_at: at })));
    };
    // Staff delivered both March 1. One: a portal look Feb 20, then opens March 5 and April 10, all logged.
    await quote('2006-02-20T15:00:00Z', '2006-04-10T15:00:00Z', ['2006-02-20T15:00:00Z', '2006-03-05T15:00:00Z', '2006-04-10T15:00:00Z']);
    // Two: the March 7 open stamped viewed_at but its log insert failed; an April 12 reopen is logged.
    await quote('2006-03-07T15:00:00Z', '2006-04-12T15:00:00Z', ['2006-04-12T15:00:00Z']);
    const after = await months();
    expect([after[0] - before[0], after[1] - before[1]]).toEqual([2, 0]);
  });
});
