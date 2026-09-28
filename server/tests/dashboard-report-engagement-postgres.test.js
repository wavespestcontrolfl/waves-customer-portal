// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
//
// get_report_engagement's mocked unit test (dashboard-report-engagement.test.js)
// asserts SQL shape and JS-side parsing; it cannot prove the date-window math
// used by reserviceWithin14Days (1-14 days, same customer, same line, and the
// right-censoring cutoff) since it never touches a real Postgres date. This
// suite proves that math against the real schema.
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

const { randomUUID } = require('node:crypto');
const { executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools');
const { etDateString, addETDays } = require('../utils/datetime-et');

postgres('get_report_engagement reserviceWithin14Days against migrated PostgreSQL', () => {
  let database;
  let trx;
  const FROM = '2026-08-01';
  const TO = '2026-08-31';

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
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function customer() {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
      active: true, pipeline_stage: 'active_customer', monthly_rate: 0,
    });
    return id;
  }

  // A completed, sent, service_report_v1 visit — makes its line appear in
  // by_service_line so the reservice/question fields have somewhere to land.
  async function sentVisit({ customerId, date, line, isCallback = false, serviceKeySnapshot = null }) {
    const [sched] = await trx('scheduled_services').insert({
      customer_id: customerId, scheduled_date: date, service_type: 'Test Visit', status: 'completed',
      is_callback: isCallback, service_key_snapshot: serviceKeySnapshot,
    }).returning('*');
    const [rec] = await trx('service_records').insert({
      customer_id: customerId, service_date: date, service_type: 'Test Visit', status: 'completed',
      scheduled_service_id: sched.id, service_line: line, report_template_version: 'service_report_v1',
    }).returning('*');
    await trx('service_report_deliveries').insert({
      service_record_id: rec.id, customer_id: customerId, channel: 'email',
      status: 'sent', sent_at: `${date}T12:00:00Z`,
    });
    return { scheduled: sched, record: rec };
  }

  // A plain completed visit with no report sent — used for reservice-only
  // fixtures where the visit itself need not show up as a "sent" report.
  async function completedVisit({ customerId, date, line, isCallback = false, serviceKeySnapshot = null }) {
    const [sched] = await trx('scheduled_services').insert({
      customer_id: customerId, scheduled_date: date, service_type: 'Test Visit', status: 'completed',
      is_callback: isCallback, service_key_snapshot: serviceKeySnapshot,
    }).returning('*');
    if (line) {
      await trx('service_records').insert({
        customer_id: customerId, service_date: date, service_type: 'Test Visit', status: 'completed',
        scheduled_service_id: sched.id, service_line: line,
      });
    }
    return sched;
  }

  function pestLine(res) { return res.by_service_line.find((r) => r.service_line === 'pest'); }

  test('a same-customer same-line re-service 10 days later counts as reserviced', async () => {
    const cust = await customer();
    const { scheduled: visit } = await sentVisit({ customerId: cust, date: '2026-08-05', line: 'pest' });
    expect(visit.id).toBeTruthy();
    await completedVisit({ customerId: cust, date: '2026-08-15', line: 'pest', serviceKeySnapshot: 'pest_re_service' });

    const res = await executeDashboardTool('get_report_engagement', { date_from: FROM, date_to: TO });
    expect(pestLine(res).reserviceWithin14Days).toEqual({ visits: 1, reserviced: 1, rate: 1 });
  });

  test('a same-customer same-line re-service 20 days later does not count', async () => {
    const cust = await customer();
    await sentVisit({ customerId: cust, date: '2026-08-01', line: 'pest' });
    await completedVisit({ customerId: cust, date: '2026-08-21', line: 'pest', serviceKeySnapshot: 'pest_re_service' });

    const res = await executeDashboardTool('get_report_engagement', { date_from: FROM, date_to: TO });
    expect(pestLine(res).reserviceWithin14Days).toEqual({ visits: 1, reserviced: 0, rate: 0 });
  });

  test('a re-service on the other line does not count', async () => {
    const cust = await customer();
    await sentVisit({ customerId: cust, date: '2026-08-05', line: 'pest' });
    // Same customer, 5 days later, but it's a LAWN re-service.
    await completedVisit({ customerId: cust, date: '2026-08-10', line: 'lawn', serviceKeySnapshot: 'lawn_re_service' });

    const res = await executeDashboardTool('get_report_engagement', { date_from: FROM, date_to: TO });
    expect(pestLine(res).reserviceWithin14Days).toEqual({ visits: 1, reserviced: 0, rate: 0 });
  });

  test('a re-service visit is not itself counted as a visit', async () => {
    const cust = await customer();
    // The ONLY completed pest-line row in the window is the re-service
    // itself — it must not inflate the visits denominator.
    await sentVisit({ customerId: cust, date: '2026-08-05', line: 'pest', serviceKeySnapshot: 'pest_re_service' });

    const res = await executeDashboardTool('get_report_engagement', { date_from: FROM, date_to: TO });
    expect(pestLine(res).reserviceWithin14Days).toEqual({ visits: 0, reserviced: 0, rate: null });
  });

  test('right-censoring: a visit inside the last 14 days is excluded even with a re-service; one outside it counts', async () => {
    const cust = await customer();
    // Visit A: 5 days ago — its 14-day follow-up window hasn't closed yet,
    // so it must be excluded from visits (and so from reserviced) even
    // though a re-service landed 3 days after it.
    const dateA = etDateString(addETDays(new Date(), -5));
    await sentVisit({ customerId: cust, date: dateA, line: 'pest' });
    const reserviceADate = etDateString(addETDays(new Date(), -2));
    await completedVisit({ customerId: cust, date: reserviceADate, line: 'pest', serviceKeySnapshot: 'pest_re_service' });

    // Visit B: 20 days ago — fully closed, and its re-service 10 days later
    // (day -10) is within the 1-14 day range. Same customer as A: the two
    // re-services only pair with the visit whose date range they fall in
    // (-2 falls in (-5, 9], not (-20, -6], so it never spuriously matches B).
    const dateB = etDateString(addETDays(new Date(), -20));
    await sentVisit({ customerId: cust, date: dateB, line: 'pest' });
    const reserviceBDate = etDateString(addETDays(new Date(), -10));
    await completedVisit({ customerId: cust, date: reserviceBDate, line: 'pest', serviceKeySnapshot: 'pest_re_service' });

    const res = await executeDashboardTool('get_report_engagement', {}); // default: last 30 ET days ending today
    // Only visit B counts: 1 visit, 1 reserviced. Visit A never appears —
    // not as an uncounted zero, not as a false reservice match.
    expect(pestLine(res).reserviceWithin14Days).toEqual({ visits: 1, reserviced: 1, rate: 1 });
  });
});
