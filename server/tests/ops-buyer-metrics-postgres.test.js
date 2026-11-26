// Work and routes against real PostgreSQL (one rolled-back transaction per test): the real SQL on the migrated
// schema. Owner versus other technician, a grouped visit counting one stop, callbacks and included follow-ups,
// the gross-margin-tile revenue basis, route days from work days, closed holidays and absences, and what a
// scheduled stop is. All names and numbers are synthetic. No network, no spend, no customer.
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
// twilio.js pulls in the SDK and routes: only its owner-phone test is used here.
jest.mock('../services/twilio', () => ({ isKnownOwnerPhone: (phone) => phone === '+19415550100' }));

const { randomUUID } = require('node:crypto');
const svc = require('../services/ops-buyer-metrics');

jest.setTimeout(60000);
// Thursday 2037-11-26, 10 AM ET (Thanksgiving; 2037 has the 2026 calendar). The year is far from any other suite's rows: the
// shared CI database keeps their visits (some referenced by other tables), so nothing here deletes, and every window below
// holds only this test's fixtures. Windows: 12 months from 2036-11-27, 90 days from 2037-08-29,
// 4 weeks from 2037-10-30, 12 weeks from 2037-09-04, next 28 days 2037-11-26 to 2037-12-23.
const NOW = new Date('2037-11-26T15:00:00Z');
const OWNER_PHONE = '+19415550100';
const GATE = 'GATE_TECH_WORK_DAYS';
const DRIVE_KEY = 'global_drive_time';

postgres('ops buyer metrics (live Postgres)', () => {
  let database;
  let trx;
  let customerId;
  let owner;
  let other;
  const OLD_GATE = process.env[GATE];
  const pricingConstants = require('../services/pricing-engine/constants');
  const OLD_DRIVE = pricingConstants.GLOBAL.DRIVE_TIME;

  const technician = async (fields) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name: `Sample ${id.slice(0, 4)}`, active: true, employment_status: 'active', field_dispatchable: true, ...fields,
    });
    return id;
  };
  // A service_records row; `scheduled` makes its scheduled_services row too (callback flag, included follow-up, group).
  const record = async (date, fields = {}, scheduled = null) => {
    let scheduledServiceId = null;
    if (scheduled) {
      scheduledServiceId = randomUUID();
      await trx('scheduled_services').insert({
        id: scheduledServiceId, customer_id: customerId, scheduled_date: date, service_type: 'Pest Control Visit', status: 'completed', ...scheduled,
      });
    }
    await trx('service_records').insert({
      id: randomUUID(), customer_id: customerId, service_date: date, service_type: 'Pest Control Visit', status: 'completed',
      scheduled_service_id: scheduledServiceId, ...fields,
    });
  };
  const group = async (date) => {
    const id = randomUUID();
    await trx('service_visits').insert({ id, customer_id: customerId, scheduled_date: date, stop_base_key: `sample:${id}`, created_by: 'test' });
    return id;
  };
  const shift = (technicianId, clockIn, minutes, fields = {}) => trx('time_entries').insert({
    technician_id: technicianId, entry_type: 'shift', status: 'completed', clock_in: clockIn, duration_minutes: minutes, ...fields,
  });
  const upcoming = (date, fields = {}) => trx('scheduled_services').insert({
    customer_id: customerId, scheduled_date: date, service_type: 'Pest Control Visit', status: 'pending', ...fields,
  });
  // The configured Average Drive Time job-costing reads (pricing_config global_drive_time), set inside the transaction and
  // loaded by the same refresh job-costing runs (the sync is due once the cache is invalidated).
  const setDrive = async (minutes) => {
    await trx('pricing_config').insert({ config_key: DRIVE_KEY, name: 'Average drive time', category: 'global', data: JSON.stringify({ value: minutes }) })
      .onConflict('config_key').merge(['data']);
    require('../services/pricing-engine').invalidatePricingConfigCache();
  };
  const setting = (key, value) => trx.raw(
    'INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value],
  );

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
    // Only this test's technicians count: any seeded one is set aside inside the rolled-back transaction.
    await trx('technicians').update({ role: 'technician', employment_status: 'inactive' });
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Customer', phone: '+19415550143' });
    delete process.env[GATE];
    await setDrive(20);
    owner = await technician({ role: 'admin', phone: OWNER_PHONE });
    other = await technician({ role: 'technician', work_days: [1, 2, 3, 4] });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE;
    pricingConstants.GLOBAL.DRIVE_TIME = OLD_DRIVE;
    require('../services/pricing-engine').invalidatePricingConfigCache();
  });

  // Owner: 11-02 two pest stops (100, 120), 11-03 one lawn stop (80), 11-06 an included follow-up ($0).
  // Other: 11-04 one stop (150), 11-05 a grouped visit of two services (60 + 40) = ONE stop, 11-06 a callback ($0),
  // 06-01 one stop (200; inside 12 months, outside 90 days). Nobody: 11-09 (50). Left out: a cancelled record and a
  // record from before the 12 months.
  const seedYear = async () => {
    await record('2037-11-02', { technician_id: owner, revenue: 100 });
    await record('2037-11-02', { technician_id: owner, revenue: 120 });
    await record('2037-11-03', { technician_id: owner, revenue: 80, service_type: 'Lawn Care Visit' });
    await record('2037-11-06', { technician_id: owner, revenue: 0 }, { followup_included: true });
    await record('2037-11-04', { technician_id: other, revenue: 150 });
    const visitId = await group('2037-11-05');
    await record('2037-11-05', { technician_id: other, revenue: 60 }, { visit_id: visitId });
    await record('2037-11-05', { technician_id: other, revenue: 40 }, { visit_id: visitId });
    await record('2037-11-06', { technician_id: other, revenue: 0, is_callback: true });
    await record('2037-06-01', { technician_id: other, revenue: 200 });
    await record('2037-11-09', { technician_id: null, revenue: 50 });
    await record('2037-11-10', { technician_id: other, revenue: null, status: 'cancelled' });
    await record('2036-11-20', { technician_id: other, revenue: 999 });
  };

  describe('owner reliance', () => {
    it('hours come from the owner time-clock shifts, completed or edited only, never another technician or a voided shift', async () => {
      await shift(owner, '2037-11-02T14:00:00Z', 480);
      await shift(owner, '2037-11-03T14:00:00Z', 480, { status: 'edited' });
      await shift(owner, '2037-09-15T14:00:00Z', 600); // inside 12 weeks, outside 4
      await shift(owner, '2037-11-04T14:00:00Z', 480, { status: 'voided' });
      await shift(owner, '2037-11-05T14:00:00Z', 480, { entry_type: 'break' });
      await shift(other, '2037-11-02T14:00:00Z', 480);
      await shift(owner, '2037-08-01T14:00:00Z', 480); // before the 12 weeks
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      const hours = ownerReliance.ownerFieldHoursPerWeek;
      expect(hours.sources).toEqual({ last4Weeks: 'time_clock', last12Weeks: 'time_clock' });
      expect(hours.last4Weeks).toBe(4); // 960 min / 60 / 4
      expect(hours.last12Weeks).toBe(2.2); // 1560 min / 60 / 12 = 2.17
    });

    it('each window picks its own source: a 12-week shift with none in the last 4 weeks leaves the 4 weeks on the stop estimate', async () => {
      await shift(owner, '2037-09-15T14:00:00Z', 600); // inside 12 weeks, outside 4
      await record('2037-11-02', { technician_id: owner, revenue: 100 });
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      const hours = ownerReliance.ownerFieldHoursPerWeek;
      expect(hours.sources).toEqual({ last4Weeks: 'stops_standard', last12Weeks: 'time_clock' });
      expect(hours.last4Weeks).toBe(0.2); // one pest stop: 25 + 20 = 45 minutes / 60 / 4 = 0.19
      expect(hours.last12Weeks).toBe(0.8); // 600 minutes / 60 / 12 = 0.83: the 12-week window has the shift
    });

    it('with no owner shifts the hours are estimated from completed stops at the standard minutes plus drive', async () => {
      await seedYear();
      const { ownerReliance, errors } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(errors).toEqual({});
      const hours = ownerReliance.ownerFieldHoursPerWeek;
      expect(hours.sources).toEqual({ last4Weeks: 'stops_standard', last12Weeks: 'stops_standard' });
      // 4 owner stops: pest 25 + pest 25 + lawn 20 + pest 25 = 95, plus 4 x 20 drive = 175 minutes
      expect(hours.stopsStandard.last4Weeks).toBe(0.7); // 175 / 60 / 4
      expect(hours.stopsStandard.last12Weeks).toBe(0.2); // 175 / 60 / 12
      expect(hours.last4Weeks).toBe(0.7);
    });

    it('the estimate sums every service of a grouped owner visit and adds the drive once per stop', async () => {
      const visitId = await group('2037-11-10');
      await record('2037-11-10', { technician_id: owner, revenue: 60 }, { visit_id: visitId });
      await record('2037-11-10', { technician_id: owner, revenue: 40, service_type: 'Lawn Care Visit' }, { visit_id: visitId });
      await record('2037-11-11', { technician_id: owner, revenue: 90 });
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      // Grouped stop: pest 25 + lawn 20 + one drive 20 = 65. Plain stop: pest 25 + drive 20 = 45. Total 110 minutes.
      expect(ownerReliance.ownerFieldHoursPerWeek.stopsStandard).toEqual({ last4Weeks: 0.5, last12Weeks: 0.2 });
    });

    it('the drive minutes are the configured Average Drive Time, shown in the basis', async () => {
      await setDrive(30);
      await seedYear();
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      const hours = ownerReliance.ownerFieldHoursPerWeek;
      expect(hours.driveMinutesPerStop).toBe(30);
      // 4 owner stops: 95 on-site + 4 x 30 drive = 215 minutes
      expect(hours.stopsStandard).toEqual({ last4Weeks: 0.9, last12Weeks: 0.3 });
      expect(hours.basis).toContain('30 minutes now');
    });

    it('the non-owner share counts a grouped visit once and leaves unassigned stops out', async () => {
      await seedYear();
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(ownerReliance.nonOwnerStopShare).toMatchObject({ ownerStops: 4, otherStops: 4, unassignedStops: 1, share: 0.5 });
    });

    it('a grouped stop the owner worked on in any record is an owner stop, whatever order the records were written in', async () => {
      const first = await group('2037-11-10');
      await record('2037-11-10', { technician_id: owner, revenue: 50 }, { visit_id: first });
      await record('2037-11-10', { technician_id: other, revenue: 50 }, { visit_id: first });
      const second = await group('2037-11-11');
      await record('2037-11-11', { technician_id: other, revenue: 50 }, { visit_id: second });
      await record('2037-11-11', { technician_id: owner, revenue: 50 }, { visit_id: second });
      await record('2037-11-12', { technician_id: other, revenue: 50 }); // another technician alone: an other stop
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(ownerReliance.nonOwnerStopShare).toMatchObject({ ownerStops: 2, otherStops: 1, share: 0.3333 });
    });

    it('with no stops the share is null and the hours are 0', async () => {
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(ownerReliance.nonOwnerStopShare.share).toBeNull();
      expect(ownerReliance.ownerFieldHoursPerWeek.last4Weeks).toBe(0);
    });

    it('an owner that cannot be identified makes both owner numbers unavailable, never 0 hours or a 100% share', async () => {
      await trx('technicians').where({ id: owner }).update({ phone: '+19415550111' });
      await seedYear();
      const { ownerReliance, errors } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(errors).toEqual({});
      expect(ownerReliance.ownerFieldHoursPerWeek).toBeNull();
      expect(ownerReliance.nonOwnerStopShare).toBeNull();
      expect(ownerReliance.unavailableReason).toMatch(/No active field technician/);
    });

    it('two admin field technicians with an owner phone cannot be told apart: unavailable', async () => {
      await technician({ role: 'admin', phone: OWNER_PHONE });
      await seedYear();
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(ownerReliance.nonOwnerStopShare).toBeNull();
      expect(ownerReliance.unavailableReason).toMatch(/More than one/);
    });

    it('an office admin who is not a field technician, or an admin without an owner phone, does not make the owner ambiguous', async () => {
      await technician({ role: 'admin', phone: OWNER_PHONE, field_dispatchable: false });
      await technician({ role: 'admin', phone: '+19415550122' });
      await seedYear();
      const { ownerReliance } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(ownerReliance.nonOwnerStopShare).toMatchObject({ ownerStops: 4, otherStops: 4 });
    });
  });

  describe('revenue per route day', () => {
    it('is the tile-basis revenue over distinct technician-date pairs with a completed stop', async () => {
      await seedYear();
      const { revenuePerRouteDay: out } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      // Revenue: every record with a revenue figure inside the window, the cancelled one has none.
      // 12 months: 100+120+80+0+150+60+40+0+200+50 = 800. 90 days: 600 (the 06-01 visit is older).
      // Route days (completed, with a technician): owner 11-02, 11-03, 11-06; other 11-04, 11-05, 11-06, 06-01.
      expect(out.last12Months).toMatchObject({ revenue: 800, routeDays: 7, revenuePerRouteDay: 114.29 });
      expect(out.last90Days).toMatchObject({ revenue: 600, routeDays: 6, revenuePerRouteDay: 100 });
    });

    it('no completed stops is null, never a division by zero', async () => {
      const { revenuePerRouteDay: out } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(out.last12Months).toMatchObject({ revenue: 0, routeDays: 0, revenuePerRouteDay: null });
      expect(out.last90Days.revenuePerRouteDay).toBeNull();
    });
  });

  describe('return-visit rate', () => {
    it('counts callbacks and included follow-ups over every completed stop, a grouped visit once', async () => {
      await seedYear();
      const { returnVisitRate } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      // 9 stops: owner 4, other 4 (the group is one), unassigned 1. Return visits: the follow-up and the callback.
      expect(returnVisitRate).toMatchObject({ completedStops: 9, returnVisits: 2, rate: 0.2222 });
      expect(returnVisitRate.window).toEqual({ from: '2036-11-27', to: '2037-11-26' });
    });

    it('a callback flagged only on the scheduled visit counts too', async () => {
      await record('2037-11-03', { technician_id: other, revenue: 0 }, { is_callback: true });
      await record('2037-11-04', { technician_id: other, revenue: 90 });
      const { returnVisitRate } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(returnVisitRate).toMatchObject({ completedStops: 2, returnVisits: 1, rate: 0.5 });
    });

    it('a flagless catalog re-service counts, by the catalog key or by the service type, as production share does', async () => {
      await record('2037-11-03', { technician_id: other, revenue: 0 }, { service_key_snapshot: 'pest_re_service' }); // key only, no flag
      await record('2037-11-04', { technician_id: other, revenue: 0, service_type: 'Lawn Care Re-Service' }); // name only, no flag
      await record('2037-11-05', { technician_id: other, revenue: 90 });
      await record('2037-11-06', { technician_id: other, revenue: 90, service_type: 'Pest Control Visit' }, { service_key_snapshot: 'rodent_trap_check_additional' }); // paid extra check: not a return
      const { returnVisitRate } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(returnVisitRate).toMatchObject({ completedStops: 4, returnVisits: 2, rate: 0.5 });
    });

    it('no stops is null', async () => {
      const { returnVisitRate } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(returnVisitRate).toMatchObject({ completedStops: 0, returnVisits: 0, rate: null });
    });
  });

  describe('route fill', () => {
    beforeEach(async () => {
      await technician({ employment_status: 'inactive' }); // a left technician: no route days
      await technician({ field_dispatchable: false }); // office staff: no route days
      await setting('schedule_weekly_days_off', '[0,6]');
      await setting('schedule_holiday_closures', '["thanksgiving"]');
    });

    const seedFillStops = async () => {
      await upcoming('2037-11-26', { status: 'completed', technician_id: owner });
      await upcoming('2037-11-27', { technician_id: owner });
      await upcoming('2037-12-01', { status: 'confirmed', technician_id: other });
      await upcoming('2037-12-23', { technician_id: other });
      const visitId = await group('2037-12-02');
      await upcoming('2037-12-02', { visit_id: visitId, technician_id: other });
      await upcoming('2037-12-02', { visit_id: visitId, technician_id: other, service_type: 'Lawn Care Visit' });
      await upcoming('2037-12-03', { technician_id: null });
      await upcoming('2037-12-04', { status: 'cancelled' });
      await upcoming('2037-12-04', { status: 'skipped' });
      await upcoming('2037-12-04', { status: 'no_show' });
      await upcoming('2037-12-02', { status: 'rescheduled' });
      await upcoming('2037-11-25'); // before the window
      await upcoming('2037-12-24'); // after it
    };

    it('route days: every open day for each technician, minus closed days and uncleared absences; stops: not cancelled, grouped once', async () => {
      // Window 11-26 to 12-23 holds 20 weekdays and 8 weekend days. Weekends are the weekly days off and Thanksgiving
      // (Thu 11-26) is closed: 19 open days. Two technicians, and the work-days list of `other` is ignored (the setting is off).
      await trx('technician_absences').insert({ technician_id: other, absence_date: '2037-12-01', reason: 'other' }); // out: -1
      await trx('technician_absences').insert({ technician_id: other, absence_date: '2037-12-02', reason: 'other', cleared_at: trx.fn.now() }); // cleared: counts
      await seedFillStops();
      const { routeFill, errors } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(errors).toEqual({});
      expect(routeFill).toMatchObject({
        window: { from: '2037-11-26', to: '2037-12-23' },
        scheduledStops: 6,
        routeDaysAvailable: 37, // 19 + 19 - 1
        activeTechnicians: 2,
        label: 'planning only, not a pay target',
      });
      expect(routeFill.fillRatio).toBe(0.0135); // 6 / (37 x 12)
      expect(routeFill.closedDays).toContain('2037-11-26');
      expect(routeFill.closedDays).toContain('2037-11-28');
    });

    it('placement follows stops-ahead: a windowless row waiting on a pick-by or dispatch date is not a stop; a placed or legacy date-only row is', async () => {
      await upcoming('2037-12-01', { technician_id: owner, window_start: null, customer_pick_by: new Date('2037-11-30T00:00:00Z') }); // waiting: out
      await upcoming('2037-12-02', { technician_id: owner, window_start: null, recurring_dispatch_due_date: '2037-11-29' }); // waiting: out
      await upcoming('2037-12-03', { technician_id: owner, window_start: null }); // legacy date-only: in
      await upcoming('2037-12-04', { technician_id: owner, window_start: '09:00', customer_pick_by: new Date('2037-11-30T00:00:00Z') }); // placed: in
      await upcoming('2037-12-07', { technician_id: owner, window_start: '09:00', recurring_dispatch_due_date: '2037-11-29' }); // placed: in
      await upcoming('2037-12-08', { technician_id: owner, track_state: 'cancelled' }); // a cancelled track: out
      const { routeFill } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(routeFill.scheduledStops).toBe(3);
    });

    it('ungrouped siblings of one slot (same technician, customer, date and window) count once; another window or technician is another stop', async () => {
      await upcoming('2037-12-01', { technician_id: owner, window_start: '09:00' });
      await upcoming('2037-12-01', { technician_id: owner, window_start: '09:00', service_type: 'Lawn Care Visit' }); // sibling: same stop
      await upcoming('2037-12-01', { technician_id: owner, window_start: '11:00' }); // another window
      await upcoming('2037-12-01', { technician_id: other, window_start: '09:00' }); // another technician
      await upcoming('2037-12-02', { technician_id: owner }); // no window, same slot twice
      await upcoming('2037-12-02', { technician_id: owner, service_type: 'Lawn Care Visit' });
      const { routeFill } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(routeFill.scheduledStops).toBe(4);
    });

    it('two unassigned appointments for one customer at different properties in the same slot are two stops', async () => {
      const homes = [randomUUID(), randomUUID()];
      for (const [i, propertyId] of homes.entries()) {
        await trx('customer_properties').insert({
          id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: i === 0,
          address_line1: `${100 + i} Example Lane`, city: 'Lakewood Ranch', zip: '34211', active: true, address_key: randomUUID(),
        });
      }
      await upcoming('2037-12-01', { technician_id: null, window_start: '09:00', property_id: homes[0] });
      await upcoming('2037-12-01', { technician_id: null, window_start: '09:00', property_id: homes[1] }); // another home: another stop
      await upcoming('2037-12-01', { technician_id: null, window_start: '09:00', property_id: homes[1], service_type: 'Lawn Care Visit' }); // sibling
      const { routeFill } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(routeFill.scheduledStops).toBe(2);
    });

    it('an assigned appointment and its add-on line are one stop even when only the appointment carries a property', async () => {
      const home = randomUUID();
      await trx('customer_properties').insert({
        id: home, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
        address_line1: '120 Example Lane', city: 'Lakewood Ranch', zip: '34211', active: true, address_key: randomUUID(),
      });
      await upcoming('2037-12-01', { technician_id: owner, window_start: '09:00', property_id: home });
      await upcoming('2037-12-01', { technician_id: owner, window_start: '09:00', property_id: null, service_type: 'Lawn Care Visit' }); // add-on line
      const { routeFill } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(routeFill.scheduledStops).toBe(1);
    });

    it('an unclaimed estimate slot hold is not a stop, live or expired; claiming it adds exactly one stop', async () => {
      await upcoming('2037-12-01', { technician_id: owner }); // a real stop
      const hold = randomUUID();
      await trx('scheduled_services').insert({
        id: hold, customer_id: null, scheduled_date: '2037-12-02', service_type: 'Pest Control Visit', status: 'pending', technician_id: owner,
        reservation_expires_at: trx.raw("NOW() + INTERVAL '10 minutes'"),
      });
      await trx('scheduled_services').insert({
        customer_id: null, scheduled_date: '2037-12-03', service_type: 'Pest Control Visit', status: 'pending', technician_id: owner,
        reservation_expires_at: trx.raw("NOW() - INTERVAL '1 hour'"),
      });
      expect((await svc.buildOpsBuyerMetrics({ db: trx, now: NOW })).routeFill.scheduledStops).toBe(1);
      await trx('scheduled_services').where({ id: hold }).update({ customer_id: customerId }); // claimed by a customer
      expect((await svc.buildOpsBuyerMetrics({ db: trx, now: NOW })).routeFill.scheduledStops).toBe(2);
    });

    it('with GATE_TECH_WORK_DAYS on, a technician work-days list takes off the days it leaves out, like the scheduler', async () => {
      process.env[GATE] = 'true';
      await trx('technician_absences').insert({ technician_id: other, absence_date: '2037-12-01', reason: 'other' });
      const { routeFill } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      // other works Monday to Thursday: its 4 open Fridays (11-27, 12-04, 12-11, 12-18) drop out: 19 + 15 - 1
      expect(routeFill.routeDaysAvailable).toBe(33);
    });

    it('a one-off closed date takes a day from every technician', async () => {
      await trx('schedule_blackout_dates').insert({ date: '2037-12-07', reason: 'Sample closure' });
      const { routeFill } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(routeFill.routeDaysAvailable).toBe(36); // 18 + 18
      expect(routeFill.scheduledStops).toBe(0);
      expect(routeFill.fillRatio).toBe(0);
    });

    it('no active technician is null fill, never a division by zero', async () => {
      await trx('technicians').update({ employment_status: 'inactive' });
      const { routeFill } = await svc.buildOpsBuyerMetrics({ db: trx, now: NOW });
      expect(routeFill).toMatchObject({ routeDaysAvailable: 0, fillRatio: null });
    });
  });
});
