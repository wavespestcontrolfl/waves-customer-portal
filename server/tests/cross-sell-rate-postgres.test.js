// The cross-sell number against real PostgreSQL (one rolled-back transaction per test): the family mapping from the stored
// service key and the service type, the 95-day window (a quarterly customer between visits still counts), cancelled,
// callback and non-recurring visits left out, churned and deleted customers left out, the source split with the added
// service picked by its earliest visit, the pest-only list, the monthly snapshot columns, and the backfill writing only
// its three columns. All names and numbers are synthetic. No network, no spend, no customer.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');
const svc = require('../services/cross-sell-rate');
const snapshot = require('../services/monthly-financial-snapshot');
const backfill = require('../scripts/backfill-cross-sell-snapshots');

jest.setTimeout(60000);
const M = '2026-10-31';

postgres('cross-sell rate (live Postgres)', () => {
  let database;
  let trx;
  let phoneSeq;

  // A customer; the last name orders the pest-only list.
  const customer = async (lastName, fields = {}) => {
    phoneSeq += 1;
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Sample', last_name: lastName, city: 'Parrish', phone: `+1941555${String(phoneSeq).padStart(4, '0')}`, ...fields,
    });
    return id;
  };
  // A scheduled_services row: recurring and not cancelled by default.
  const visit = async (customerId, fields = {}) => {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: M, service_type: 'Sample Visit', status: 'confirmed', is_recurring: true,
      created_at: '2026-01-01T12:00:00Z', ...fields,
    });
    return id;
  };
  const estimate = async (source, customerId) => {
    const id = randomUUID();
    await trx('estimates').insert({ id, customer_id: customerId, status: 'accepted', source });
    return id;
  };
  const counts = async (asOf = M) => {
    const { recurringCustomers, multiServiceCustomers } = await svc.crossSellForMonthEnd(trx, asOf);
    return { recurringCustomers, multiServiceCustomers };
  };
  // Day arithmetic in the test goes through Postgres, so it is the same calendar the query uses.
  const dayFrom = async (anchor, days) => {
    const { rows } = await trx.raw("SELECT to_char(CAST(? AS date) + ?::int, 'YYYY-MM-DD') AS d", [anchor, days]);
    return rows[0].d;
  };

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's: the managed runner sets both marks and names
    // the database after the worktree id. Or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its settings: refuse a URL with a query
    // and build the pool from the parts this guard read.
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
  afterAll(async () => { if (database) await database.destroy(); });

  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    phoneSeq = 0;
    // The QA database may hold rows from other suites' committed fixtures: count only what this test inserts. Every
    // count skips deleted customers, so the older ones are marked deleted inside this rolled-back transaction (a delete
    // of their visits would trip other tables' foreign keys, e.g. series_moves in CI).
    await trx('customers').whereNull('deleted_at').update({ deleted_at: trx.fn.now() });
  });
  afterEach(async () => { await trx.rollback(); });

  describe('the family mapping', () => {
    // [stored key, service type, family or null]. A customer with a pest_general row plus this row has two families only
    // when this row maps to a family other than pest.
    const CASES = [
      ['pest_general_quarterly', 'Pest', 'pest'],
      ['lawn_care_6x', 'Lawn', 'lawn'],
      ['tree_shrub_6x', 'Tree', 'tree_shrub'],
      ['mosquito_monthly', 'Mosquito', 'mosquito'],
      ['termite_bait_monitoring', 'Termite', 'termite'],
      ['rodent_bait_monthly', 'Rodent', 'rodent_bait'],
      // A stored key that maps to nothing is ignored, whatever the service type says.
      ['cockroach_control', 'Lawn Care', null],
      ['flea_tick', 'Mosquito', null],
      ['rodent_trapping', 'Pest Control', null],
      // pest_general% is a prefix, and the underscore is not a wildcard.
      ['pestXgeneral', 'Pest Control', null],
      // No stored key: the service type decides, any case.
      [null, 'LAWN CARE', 'lawn'],
      [null, 'Tree & Shrub', 'tree_shrub'],
      [null, 'Shrub Treatment', 'tree_shrub'],
      [null, 'Mosquito Barrier', 'mosquito'],
      [null, 'Termite Bait Stations', 'termite'],
      [null, 'Bait Stations', 'termite'],
      [null, 'Rodent Bait Station Service', 'rodent_bait'],
      [null, 'Quarterly Pest Control', 'pest'],
      [null, 'Cockroach Control', null],
    ];

    test.each(CASES)('key %p with service type %p is family %p', async (key, type, family) => {
      const c = await customer('Mapping');
      await visit(c, { service_key_snapshot: 'pest_general_quarterly', service_type: 'Pest Control' });
      await visit(c, { service_key_snapshot: key, service_type: type });
      const expectMulti = family != null && family !== 'pest' ? 1 : 0;
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: expectMulti });
    });

    test('a row whose only family is ignored is not a recurring customer at all', async () => {
      const c = await customer('Ignored');
      await visit(c, { service_key_snapshot: 'flea_tick', service_type: 'Flea' });
      expect(await counts()).toEqual({ recurringCustomers: 0, multiServiceCustomers: 0 });
    });
  });

  describe('which visits count', () => {
    const PEST = { service_key_snapshot: 'pest_general_quarterly', service_type: 'Pest Control' };
    const LAWN = { service_key_snapshot: 'lawn_care_6x', service_type: 'Lawn' };

    test('a quarterly customer between visits still counts: a visit within 95 days either side holds the service', async () => {
      const c = await customer('Quarterly');
      await visit(c, { ...PEST, scheduled_date: await dayFrom(M, -60) });
      await visit(c, { ...LAWN, scheduled_date: await dayFrom(M, -95) }); // the edge: in
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 1 });
    });

    test('the window is 95 days before and 95 days after the day, both edges in and one day further out', async () => {
      const after = await customer('After');
      await visit(after, { ...PEST });
      await visit(after, { ...LAWN, scheduled_date: await dayFrom(M, 95) });
      const tooLate = await customer('TooLate');
      await visit(tooLate, { ...PEST });
      await visit(tooLate, { ...LAWN, scheduled_date: await dayFrom(M, 96) });
      const tooEarly = await customer('TooEarly');
      await visit(tooEarly, { ...PEST });
      await visit(tooEarly, { ...LAWN, scheduled_date: await dayFrom(M, -96) });
      expect(await counts()).toEqual({ recurringCustomers: 3, multiServiceCustomers: 1 });
    });

    test('a cancelled visit, a callback and a one-time visit do not count', async () => {
      const c = await customer('Left');
      await visit(c, { ...PEST });
      await visit(c, { ...LAWN, status: 'cancelled' });
      await visit(c, { service_key_snapshot: 'mosquito_monthly', service_type: 'Mosquito', is_callback: true });
      await visit(c, { service_key_snapshot: 'termite_bait_monitoring', service_type: 'Termite', is_recurring: false });
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 0 });
    });

    test('a customer who churned on or before the day does not count; one who churns after it does; a deleted one never does', async () => {
      const onTheDay = await customer('ChurnedOnDay', { churned_at: M });
      const before = await customer('ChurnedBefore', { churned_at: await dayFrom(M, -1) });
      const after = await customer('ChurnsAfter', { churned_at: await dayFrom(M, 1) });
      const deleted = await customer('Deleted', { deleted_at: new Date() });
      for (const id of [onTheDay, before, after, deleted]) {
        await visit(id, { ...PEST });
        await visit(id, { ...LAWN });
      }
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 1 });
    });

    test('a keyed and an unkeyed rodent bait visit are one family, not rodent bait plus termite', async () => {
      const c = await customer('RodentBoth');
      await visit(c, { service_key_snapshot: 'rodent_bait_quarterly', service_type: 'Rodent Bait' });
      await visit(c, { service_key_snapshot: null, service_type: 'Rodent Bait Station Service', scheduled_date: await dayFrom(M, -30) });
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 0 });
    });

    test('a service booked after the day does not count for that day', async () => {
      const c = await customer('BookedLater');
      await visit(c, { ...PEST });
      await visit(c, { ...LAWN, scheduled_date: await dayFrom(M, 20), created_at: '2026-11-05T12:00:00Z' });
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 0 });
      expect(await counts('2026-11-30')).toEqual({ recurringCustomers: 1, multiServiceCustomers: 1 });
    });

    test('a customer who came back after an old churn stamp counts on the visits booked after it', async () => {
      const c = await customer('CameBack', { churned_at: '2026-05-01' });
      await visit(c, { ...PEST, created_at: '2026-01-01T12:00:00Z', scheduled_date: '2026-04-15' });
      await visit(c, { ...PEST, created_at: '2026-08-01T12:00:00Z' });
      await visit(c, { ...LAWN, created_at: '2026-08-02T12:00:00Z' });
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 1 });
    });

    test('a service riding on a plan visit as an add-on counts as its own family', async () => {
      const c = await customer('AddOn');
      const v = await visit(c, { ...PEST });
      await trx('scheduled_service_addons').insert({ id: randomUUID(), scheduled_service_id: v, service_name: 'Termite Bait Monitoring', service_key_snapshot: 'termite_bait', recurring_pattern: 'quarterly', created_at: '2026-02-01T12:00:00Z' });
      const once = await customer('AddOnOnce');
      const v3 = await visit(once, { ...PEST });
      // No pattern of its own: it rides the parent visit's cadence, as the scheduler reads it, so it is held.
      await trx('scheduled_service_addons').insert({ id: randomUUID(), scheduled_service_id: v3, service_name: 'Mosquito Event', service_key_snapshot: 'mosquito_seasonal', created_at: '2026-02-01T12:00:00Z' });
      const plain = await customer('AddOnNoFamily');
      const v2 = await visit(plain, { ...PEST });
      await trx('scheduled_service_addons').insert({ id: randomUUID(), scheduled_service_id: v2, service_name: 'WaveGuard Membership', service_key_snapshot: 'waveguard_membership', created_at: '2026-02-01T12:00:00Z' });
      const marked = await customer('AddOnMarkedOnce');
      const v4 = await visit(marked, { ...PEST });
      await trx('scheduled_service_addons').insert({ id: randomUUID(), scheduled_service_id: v4, service_name: 'Mosquito Event', service_key_snapshot: 'mosquito_seasonal', recurring_pattern: 'one_time', created_at: '2026-02-01T12:00:00Z' });
      const refill = await customer('AddOnSoldOnceKey');
      const v5 = await visit(refill, { ...PEST });
      // A key the scheduler puts only on the visit it was sold on is not held, whatever its pattern says.
      await trx('scheduled_service_addons').insert({ id: randomUUID(), scheduled_service_id: v5, service_name: 'Mosquito Misting Refill', service_key_snapshot: 'mosquito_misting_refill', created_at: '2026-02-01T12:00:00Z' });
      expect(await counts()).toEqual({ recurringCustomers: 5, multiServiceCustomers: 2 });
    });

    test('a retired combined visit counts both of its programs, keyed or read from its label', async () => {
      const keyed = await customer('ComboKeyed');
      await visit(keyed, { service_key_snapshot: 'pest_termite_bait_quarterly', service_type: 'Quarterly Pest + Termite Bait Station Service' });
      const lawn = await customer('ComboLawn');
      await visit(lawn, { service_key_snapshot: 'lawn_tree_shrub_combo', service_type: 'Lawn + Tree & Shrub Service' });
      const label = await customer('ComboLabel');
      await visit(label, { service_key_snapshot: null, service_type: 'Quarterly Pest + Termite Bait Station Service' });
      const solo = await customer('PlainTermite');
      await visit(solo, { service_key_snapshot: null, service_type: 'Termite Bait Monitoring' });
      expect(await counts()).toEqual({ recurringCustomers: 4, multiServiceCustomers: 3 });
    });

    test('a visit cancelled after the day still counts for that day; one cancelled before it, or with no time, does not', async () => {
      const later = await customer('CancelledLater');
      await visit(later, { ...PEST });
      await visit(later, { ...LAWN, status: 'cancelled', cancelled_at: '2026-11-10T15:00:00Z' });
      const before = await customer('CancelledBefore');
      await visit(before, { ...PEST });
      await visit(before, { ...LAWN, status: 'cancelled', cancelled_at: '2026-10-20T15:00:00Z' });
      const noTime = await customer('CancelledNoTime');
      await visit(noTime, { ...PEST });
      await visit(noTime, { ...LAWN, status: 'cancelled', cancelled_at: null });
      expect(await counts()).toEqual({ recurringCustomers: 3, multiServiceCustomers: 1 });
    });

    test("the owner's test accounts never count", async () => {
      const [listedFirst, ...listedLast] = require('../services/internal-test-customers').INTERNAL_TEST_CUSTOMERS[0].split(' ');
      const listed = await customer(listedLast.join(' '), { first_name: listedFirst });
      const shakedown = await customer('Test Two', { first_name: 'Shakedown' });
      const real = await customer('Real');
      for (const id of [listed, shakedown, real]) {
        await visit(id, { ...PEST });
        await visit(id, { ...LAWN });
      }
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 1 });
    });

    test('an annual or twice-a-year service stays held between its visits; a quarterly one does not', async () => {
      const annual = await customer('Annual');
      await visit(annual, { ...PEST });
      await visit(annual, { ...LAWN, recurring_pattern: 'annual', scheduled_date: await dayFrom(M, -200) });
      const semi = await customer('Semiannual');
      await visit(semi, { ...PEST });
      await visit(semi, { ...LAWN, recurring_pattern: 'semiannual', scheduled_date: await dayFrom(M, 150) });
      const quarterly = await customer('QuarterlyFar');
      await visit(quarterly, { ...PEST });
      await visit(quarterly, { ...LAWN, recurring_pattern: 'quarterly', scheduled_date: await dayFrom(M, -150) });
      expect(await counts()).toEqual({ recurringCustomers: 3, multiServiceCustomers: 2 });
    });

    test('a series stopped on or before the day no longer holds its family, even through completed visits', async () => {
      const stopped = await customer('StoppedLawn');
      await visit(stopped, { ...PEST });
      const lawnParent = await visit(stopped, { ...LAWN, status: 'completed' });
      await trx('recurring_plan_alerts').insert({ recurring_parent_id: lawnParent, customer_id: stopped, alert_type: 'plan_lapsed', resolved_at: '2026-10-20T15:00:00Z', resolved_action: 'cancel_series' });
      const laterStop = await customer('StoppedLater');
      await visit(laterStop, { ...PEST });
      const later = await visit(laterStop, { ...LAWN, status: 'completed' });
      await trx('recurring_plan_alerts').insert({ recurring_parent_id: later, customer_id: laterStop, alert_type: 'plan_lapsed', resolved_at: '2026-11-15T15:00:00Z', resolved_action: 'cancel_series' });
      expect(await counts()).toEqual({ recurringCustomers: 2, multiServiceCustomers: 1 });
    });

    test('a series child with no recurring flag still counts', async () => {
      const c = await customer('LegacyChild');
      const parent = await visit(c, { ...PEST, scheduled_date: '2026-01-15' });
      await visit(c, { ...PEST, is_recurring: null, recurring_parent_id: parent });
      // The parent is outside the window; only the flagless child is in it, and it alone makes a recurring customer.
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 0 });
    });

    test('the same family twice is one family, not two', async () => {
      const c = await customer('Twice');
      await visit(c, { ...PEST });
      await visit(c, { ...PEST, service_key_snapshot: 'pest_general_monthly', scheduled_date: await dayFrom(M, 30) });
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 0 });
    });
  });

  describe('where the added service came from', () => {
    const PEST = { service_key_snapshot: 'pest_general_quarterly', service_type: 'Pest Control' };
    const LAWN = { service_key_snapshot: 'lawn_care_6x', service_type: 'Lawn' };
    const added = async (lawnFields) => {
      const c = await customer('Source');
      await visit(c, { ...PEST, created_at: '2025-01-01T12:00:00Z', source: 'admin' });
      await visit(c, { ...LAWN, created_at: '2026-06-01T12:00:00Z', ...lawnFields });
      return c;
    };

    test('each channel lands in its own bucket', async () => {
      await added({ source_estimate_id: await estimate('one_tap_purchase', null) });
      await added({ source_estimate_id: await estimate('plan_start', null) });
      await added({ source_estimate_id: await estimate('service_report_cta', null) });
      await added({ source_estimate_id: await estimate('quote_wizard', null) });
      await added({ source_estimate_id: await estimate('manual', null) });
      await added({ source: 'quote-wizard' });
      await added({ booking_source: 'phone_call' });
      await added({ source: 'rebooking_import_2026_06' });
      await added({ source: 'admin' });
      const result = await svc.crossSellForMonthEnd(trx, M);
      expect(result.multiServiceCustomers).toBe(9);
      expect(result.sources).toEqual({
        app: 2, service_report_card: 1, website_quote: 2, estimate: 1, phone_call: 1, imported: 1, office: 1,
      });
    });

    test('a cancelled first booking still names the channel while later visits of the series are held', async () => {
      const c = await customer('CancelledFirst');
      await visit(c, { ...PEST, created_at: '2025-01-01T12:00:00Z', source: 'admin' });
      await visit(c, { ...LAWN, created_at: '2026-06-01T12:00:00Z', booking_source: 'phone_call', status: 'cancelled', cancelled_at: '2026-06-02T12:00:00Z' });
      // The seeded child copies source, not the phone fields.
      await visit(c, { ...LAWN, created_at: '2026-06-01T12:05:00Z', source: 'admin', scheduled_date: await dayFrom(M, 20) });
      const result = await svc.crossSellForMonthEnd(trx, M);
      expect(result.multiServiceCustomers).toBe(1);
      expect(result.sources).toMatchObject({ phone_call: 1, office: 0 });
    });

    test('a family whose only visits are cancelled is not held', async () => {
      const c = await customer('AllCancelled');
      await visit(c, { ...PEST });
      await visit(c, { ...LAWN, status: 'cancelled', cancelled_at: '2026-06-02T12:00:00Z' });
      expect(await counts()).toEqual({ recurringCustomers: 1, multiServiceCustomers: 0 });
    });

    test('a call log link counts as a phone call', async () => {
      const callId = randomUUID();
      await trx('call_log').insert({ id: callId });
      await added({ source_call_log_id: callId, source: 'admin' });
      expect((await svc.crossSellForMonthEnd(trx, M)).sources.phone_call).toBe(1);
    });

    test('the added service is judged on its earliest visit, not its latest', async () => {
      const c = await customer('Earliest');
      // Lawn was bought through the app first; its later visits were created by the office. Pest is the older family.
      await visit(c, { ...PEST, created_at: '2024-01-01T12:00:00Z', source: 'admin' });
      await visit(c, { ...LAWN, created_at: '2026-03-01T12:00:00Z', source_estimate_id: await estimate('one_tap_purchase', c) });
      await visit(c, { ...LAWN, created_at: '2026-09-01T12:00:00Z', source: 'admin', scheduled_date: await dayFrom(M, 30) });
      const result = await svc.crossSellForMonthEnd(trx, M);
      expect(result.sources).toMatchObject({ app: 1, office: 0 });
    });
  });

  describe('the pest-only list', () => {
    test('names, city and pest key of customers whose only family is pest, sorted by last name', async () => {
      const zed = await customer('Zed', { city: 'Venice' });
      await visit(zed, { service_key_snapshot: 'pest_general_quarterly', service_type: 'Pest Control' });
      const alpha = await customer('Alpha', { city: 'Parrish' });
      await visit(alpha, { service_key_snapshot: null, service_type: 'Quarterly Pest Control' });
      const both = await customer('Both');
      await visit(both, { service_key_snapshot: 'pest_general_quarterly', service_type: 'Pest Control' });
      await visit(both, { service_key_snapshot: 'lawn_care_6x', service_type: 'Lawn' });
      const lawnOnly = await customer('LawnOnly');
      await visit(lawnOnly, { service_key_snapshot: 'lawn_care_6x', service_type: 'Lawn' });
      const churned = await customer('Churned', { churned_at: M });
      await visit(churned, { service_key_snapshot: 'pest_general_quarterly', service_type: 'Pest Control' });
      const rows = await svc.pestOnlyCustomers(trx, M);
      expect(rows).toEqual([
        { id: alpha, firstName: 'Sample', lastName: 'Alpha', city: 'Parrish', pestServiceKey: 'Quarterly Pest Control' },
        { id: zed, firstName: 'Sample', lastName: 'Zed', city: 'Venice', pestServiceKey: 'pest_general_quarterly' },
      ]);
    });
  });

  describe('the monthly snapshot and the backfill', () => {
    const seed = async () => {
      const c = await customer('Snapshot');
      await visit(c, { service_key_snapshot: 'pest_general_quarterly', service_type: 'Pest Control', scheduled_date: '2026-10-15', created_at: '2025-01-01T12:00:00Z' });
      await visit(c, { service_key_snapshot: 'lawn_care_6x', service_type: 'Lawn', scheduled_date: '2026-10-15', created_at: '2026-06-01T12:00:00Z', source: 'quote-wizard' });
      const solo = await customer('Solo');
      await visit(solo, { service_key_snapshot: 'pest_general_quarterly', service_type: 'Pest Control', scheduled_date: '2026-10-15' });
    };

    test('the 2nd-of-month write stores the three columns on the month row', async () => {
      await seed();
      await snapshot.upsertMonthSnapshot('2026-10', trx, new Date('2026-11-02T12:00:00Z'));
      const row = await trx('monthly_financial_snapshots').where({ month: '2026-10-01' }).first();
      expect(row.recurring_customers).toBe(2);
      expect(row.multi_service_customers).toBe(1);
      expect(row.multi_service_sources).toMatchObject({ website_quote: 1, office: 0 });
    });

    test('the summary reads the stored months oldest first, a row from before the columns is left out, and today live', async () => {
      await seed();
      await trx('monthly_financial_snapshots').insert([
        { month: '2026-08-01', recurring_customers: 250, multi_service_customers: 30 },
        { month: '2026-09-01', recurring_customers: 200, multi_service_customers: 20 },
        { month: '2026-07-01' }, // stored before the columns existed
      ]);
      const out = await svc.getCrossSellSummary({ months: 12, db: trx, today: M });
      expect(out.series).toEqual([
        { month: '2026-08-01', recurringCustomers: 250, multiServiceCustomers: 30, share: 0.12 },
        { month: '2026-09-01', recurringCustomers: 200, multiServiceCustomers: 20, share: 0.1 },
      ]);
      expect(out.now).toEqual({ asOf: M, recurringCustomers: 2, multiServiceCustomers: 1, share: 0.5 });
      expect(out.pestOnly.map((r) => r.lastName)).toEqual(['Solo']);
    });

    test('the backfill updates only the three columns of existing rows and never inserts one', async () => {
      await seed();
      const now = new Date('2026-11-26T15:00:00Z');
      await trx('monthly_financial_snapshots').insert([
        { month: '2026-07-01', office_cost: 111.11, paid_stops: 7, cash_revenue: 222.22, net_income: -5, pnl_complete: true },
        { month: '2026-10-01', office_cost: 333.33, paid_stops: 9, cash_revenue: 444.44, net_income: 12, recurring_customers: 1, multi_service_customers: 0 },
        { month: '2026-06-01', office_cost: 1, paid_stops: 1 }, // before 2026-07: not touched
      ]);
      const before = await trx('monthly_financial_snapshots').orderBy('month');

      const dry = await backfill.backfillCrossSell(trx, { apply: false, now });
      expect(dry).toHaveLength(4);
      expect(await trx('monthly_financial_snapshots').orderBy('month')).toEqual(before);

      const lines = [];
      const report = await backfill.backfillCrossSell(trx, { apply: true, now, log: (l) => lines.push(l) });
      expect(lines).toHaveLength(4);
      // October already held a reading: kept. July had none: filled.
      expect(report.filter((r) => r.stored).map((r) => r.month)).toEqual(['2026-07-01']);
      const forced = await backfill.backfillCrossSell(trx, { apply: true, force: true, now });
      expect(forced.filter((r) => r.stored).map((r) => r.month)).toEqual(['2026-07-01', '2026-10-01']);

      const after = await trx('monthly_financial_snapshots').orderBy('month');
      expect(after).toHaveLength(3); // no row inserted
      const THREE = ['recurring_customers', 'multi_service_customers', 'multi_service_sources'];
      const strip = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !THREE.includes(key)));
      expect(after.map(strip)).toEqual(before.map(strip)); // every other column is byte for byte the same
      const october = after.find((r) => String(r.month).includes('Oct'));
      expect(october).toMatchObject({ recurring_customers: 2, multi_service_customers: 1 });
      expect(after[0]).toMatchObject({ recurring_customers: null, multi_service_customers: null }); // 2026-02 untouched
    });
  });
});
