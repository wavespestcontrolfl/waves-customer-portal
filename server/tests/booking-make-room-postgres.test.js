const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
/**
 * The make-room check (GATE_BOOKING_MAKE_ROOM) on real PostgreSQL, with every real collaborator: the day re-plan's
 * day read, rules and full day facts, the reminder settings reader, the time preference reader, the start points,
 * the estimate page's arrival route check, the drive model and the log table. One technician, five synthetic
 * customers on a far-future day: A at 8 AM, B at 9 AM far east, C, D and E in the north at 10 AM, 11 AM and 1 PM,
 * and a new customer next to B. Taking 9 AM moves B, C and D one hour later into the free noon hour, which saves
 * far more than 10 drive minutes over the free noon and 3 PM times, so it is found; a customer in that chain with
 * reminder texts off, or with the 72-hour reminder off, stops it. Nothing may change a visit or send anything: outbound channels are stubbed and
 * asserted never called. The whole test runs inside one transaction that always rolls back, and it refuses any
 * database but a private QA one or CI's.
 */
let mockConn;
jest.mock('../models/db', () => new Proxy(function db() {}, {
  apply: (_t, _this, args) => mockConn(...args),
  get: (_t, prop) => {
    const value = mockConn[prop];
    return typeof value === 'function' ? value.bind(mockConn) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ ...jest.requireActual('../sockets'), getIo: () => null }));

const mockOutbound = {};
const stubModule = (name) => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === '__esModule' || prop === 'then') return undefined;
    mockOutbound[`${name}.${String(prop)}`] = mockOutbound[`${name}.${String(prop)}`] || jest.fn(async () => ({ success: true, sid: 'stub' }));
    return mockOutbound[`${name}.${String(prop)}`];
  },
});
jest.mock('../services/twilio', () => stubModule('twilio'));
jest.mock('../services/email', () => stubModule('email'));
jest.mock('../services/sendgrid-mail', () => stubModule('sendgrid'));
jest.mock('../services/push-notifications', () => stubModule('push'));
jest.mock('../services/fcm', () => stubModule('fcm'));
jest.mock('../services/apns', () => stubModule('apns'));
jest.mock('../services/messaging/send-customer-message', () => ({
  ...jest.requireActual('../services/messaging/send-customer-message'),
  sendCustomerMessage: (mockOutbound['messaging.sendCustomerMessage'] = jest.fn(async () => ({ sent: false }))),
}));

const { randomUUID } = require('node:crypto');

jest.setTimeout(180000);

// A Tuesday far in the future: no real rows, and every stop more than 24 hours away.
const NOW = new Date('2097-06-09T05:00:00Z'); // 01:00 ET on Monday
const DAY = '2097-06-10';
const HQ = { lat: 27.4330885, lng: -82.4056801 };
// GATE_REMINDER_72H_EMAIL_FIRST is cleared too: these fixture visits are one-time, and under it their 72-hour reminder
// goes by email, so they would never move.
const GATES = ['GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_NIGHT_TOLD_LOCK', 'GATE_DAY_ONLY_PROMISE', 'GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_TECH_START_POINTS', 'GATE_REMINDER_72H_EMAIL_FIRST', 'GATE_SLOT_TRAVEL_GAP'];

maybeDescribe('make-room check on real PostgreSQL', () => {
  let database;
  let recordMakeRoomCheck;
  let makeRoomPlacement;
  let techId;
  let visits;
  const saved = {};

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    for (const key of GATES) saved[key] = process.env[key];
    ({ recordMakeRoomCheck } = require('../services/scheduling/booking-make-room'));
    ({ makeRoomPlacement } = require('../services/estimate-slot-availability')._internals);
  });

  afterAll(async () => {
    if (database) await database.destroy();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  beforeEach(async () => {
    Object.values(mockOutbound).forEach((fn) => fn.mockClear && fn.mockClear());
    for (const key of GATES) delete process.env[key];
    // Production's route rules: arrival windows on, staff route insertion on, capacity off.
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    mockConn = await database.transaction();

    techId = randomUUID();
    await mockConn('technicians').insert({ id: techId, name: 'Synthetic room tech', employment_status: 'active', field_dispatchable: true });
    visits = [
      { name: 'a', hour: 8, dLat: 0, dLng: 0.05 },
      { name: 'b', hour: 9, dLat: 0, dLng: 0.2 },
      { name: 'c', hour: 10, dLat: 0.1, dLng: 0 },
      { name: 'd', hour: 11, dLat: 0.12, dLng: 0 },
      { name: 'e', hour: 13, dLat: 0.13, dLng: 0.01 },
    ].map((v) => ({ ...v, id: randomUUID(), customerId: randomUUID() }));
    const pad = (n) => String(n).padStart(2, '0');
    for (const [i, v] of visits.entries()) {
      await mockConn('customers').insert({
        id: v.customerId,
        first_name: `Room${v.name}zq`,
        last_name: 'Fixturezq',
        email: `${v.customerId}@example.invalid`,
        phone: `+1941555${String(2000 + i).padStart(4, '0')}`,
        address_line1: `${200 + i} Room Test Lane`,
        city: 'Test City',
        zip: '00000',
        active: true,
        pipeline_stage: 'active_customer',
      });
      await mockConn('scheduled_services').insert({
        id: v.id,
        customer_id: v.customerId,
        technician_id: techId,
        scheduled_date: DAY,
        service_type: 'Quarterly Pest Control Service',
        status: 'pending',
        window_start: `${pad(v.hour)}:00`,
        window_end: `${pad(v.hour + 1)}:00`,
        estimated_duration_minutes: 60,
        lat: HQ.lat + v.dLat,
        lng: HQ.lng + v.dLng,
        route_order: i + 1,
      });
    }
  });

  afterEach(async () => {
    await mockConn.rollback();
  });

  const visitOf = (name) => visits.find((v) => v.name === name);
  const FREE = () => [{ date: DAY, windowStart: '12:00', techId }, { date: DAY, windowStart: '15:00', techId }];
  const admit = (slot) => slot.date === DAY && slot.windowStart >= '09:00' && slot.windowStart <= '16:00';
  const PIN = { lat: HQ.lat + 0.005, lng: HQ.lng + 0.2 };
  // Each test reads the WHOLE check, so it gets a test-sized budget and must finish. Production's 4-second budget
  // is about a slow page, and it has its own tests (booking-make-room.test.js). CI's database is shared by two suite
  // halves at once: on 2026-11-08 (#7766's run) a busy check ran out of the 4 seconds before the hour under test,
  // and the test read the time-out as a missing reason. An error or a time-out now fails here, by name.
  const run = async () => {
    const estimateId = randomUUID();
    const report = await recordMakeRoomCheck({
      mode: 'shadow', estimateId, pool: FREE(), coords: PIN, durationMinutes: 60, dateFrom: DAY, dateTo: DAY, admit, now: NOW,
      // The page's own placement rules (filterCollidingSlots + the service-line rule), on the same rolled-back rows.
      placement: makeRoomPlacement({ estimateZone: null, coords: PIN, serviceMix: null, candidateExpectedMinutes: null, estimateId, lineRanking: null }),
      budgetMs: 60000,
    });
    expect(report).toMatchObject({ error: null, timedOut: false });
    return report;
  };
  const starts = async () => (await mockConn('scheduled_services').whereIn('id', visits.map((v) => v.id)).orderBy('id').select('id', 'window_start', 'window_end', 'updated_at'));
  const sentAnything = () => Object.entries(mockOutbound).filter(([, fn]) => fn.mock && fn.mock.calls.length > 0).map(([name]) => name);

  test('finds 9 AM by moving B, C and D one hour later, records one row, and changes no visit', async () => {
    const before = await starts();
    const report = await run();
    expect(report.error).toBeNull();
    const nine = report.passed.find((p) => p.start === '09:00');
    expect(nine).toBeTruthy();
    expect(nine.moves).toEqual([
      { id: visitOf('b').id, from: '09:00', to: '10:00' },
      { id: visitOf('c').id, from: '10:00', to: '11:00' },
      { id: visitOf('d').id, from: '11:00', to: '12:00' },
    ]);
    expect(nine.savingMin).toBeGreaterThanOrEqual(10);
    const rows = await mockConn('booking_make_room_checks').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'shadow', surface: 'estimate', fired: true, moved_count: report.passed[0].moves.length });
    expect(rows[0].best_saving_min).toBe(Math.round(report.passed[0].savingMin));
    // Ids, hours and minutes only.
    expect(JSON.stringify(rows[0].report)).not.toMatch(/Fixturezq|Room Test Lane|27\.43/);
    expect(await starts()).toEqual(before);
    expect(await mockConn('reschedule_log').whereIn('scheduled_service_id', visits.map((v) => v.id))).toHaveLength(0);
    expect(sentAnything()).toEqual([]);
  });

  test('travel gap on (production): a new visit that fills its whole hour leaves no turnaround before the moved stop, so the page refuses 9 AM', async () => {
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    const report = await run();
    expect(report.error).toBeNull();
    expect(report.passed.find((p) => p.start === '09:00')).toBeUndefined();
    expect(report.byReason.page_collision).toBeGreaterThanOrEqual(1);
  });

  test('the technician marked out that day is never a candidate (the free-slot finder\'s own absence rule)', async () => {
    await mockConn('technician_absences').insert({ technician_id: techId, absence_date: DAY, reason: 'synthetic test absence' });
    const report = await run();
    expect(report.error).toBeNull();
    expect(report.candidates).toBe(0);
    expect(report.passed).toEqual([]);
    expect(report.byReason.tech_day_closed).toBe(1);
    expect(sentAnything()).toEqual([]);
  });

  // Two reminder facts stop the chain at C, each through its own rule. Texts off: C's 24-hour reminder will not go
  // out, so the re-plan's own lock (day-replan fixedReason, reminder_24h_off) holds C first. The 72-hour reminder off
  // while the 24-hour one still goes out: the re-plan would move C, and the make-room rule (both reminders) holds it.
  test.each([
    ['reminder texts off', { sms_enabled: false }, 'fixed_reminder_24h_off'],
    ['the 72-hour reminder off (the 24-hour one still goes out)', { service_reminder_72h: false }, 'reminders_off'],
  ])('a customer in the chain with %s is never moved', async (_label, prefs, reason) => {
    await mockConn('notification_prefs').insert({ customer_id: visitOf('c').customerId, ...prefs });
    const report = await run();
    expect(report.passed.find((p) => p.start === '09:00')).toBeUndefined();
    // The whole tally on a failure, so the reason that won is named.
    expect(report.byReason).toEqual(expect.objectContaining({ [reason]: expect.any(Number) }));
    expect(sentAnything()).toEqual([]);
  });
});
