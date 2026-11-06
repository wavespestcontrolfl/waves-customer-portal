const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
/**
 * The make-room check (GATE_BOOKING_MAKE_ROOM) on real PostgreSQL, with every real collaborator: the day re-plan's
 * day read, rules and full day facts, the reminder settings reader, the time preference reader, the start points,
 * the estimate page's arrival route check, the drive model and the log table. One technician, five synthetic
 * customers on a far-future day: A at 8 AM, B at 9 AM far east, C, D and E in the north at 10 AM, 11 AM and 1 PM,
 * and a new customer next to B. Taking 9 AM moves B, C and D one hour later into the free noon hour, which saves
 * far more than 10 drive minutes over the free noon and 3 PM times, so it is found; a customer in that chain with
 * reminder texts off stops it. Nothing may change a visit or send anything: outbound channels are stubbed and
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
const GATES = ['GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_STAFF_ROUTE_INSERTION', 'GATE_NIGHT_TOLD_LOCK', 'GATE_DAY_ONLY_PROMISE', 'GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_TECH_START_POINTS', 'GATE_REMINDER_72H_EMAIL_FIRST'];

maybeDescribe('make-room check on real PostgreSQL', () => {
  let database;
  let recordMakeRoomCheck;
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
    process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
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
  const run = () => recordMakeRoomCheck({
    mode: 'shadow', estimateId: randomUUID(), pool: FREE(), coords: { lat: HQ.lat + 0.005, lng: HQ.lng + 0.2 },
    durationMinutes: 60, dateFrom: DAY, dateTo: DAY, admit, now: NOW,
  });
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

  test('the technician marked out that day is never a candidate (the free-slot finder\'s own absence rule)', async () => {
    await mockConn('technician_absences').insert({ technician_id: techId, absence_date: DAY, reason: 'synthetic test absence' });
    const report = await run();
    expect(report.error).toBeNull();
    expect(report.candidates).toBe(0);
    expect(report.passed).toEqual([]);
    expect(report.byReason.tech_day_closed).toBe(1);
    expect(sentAnything()).toEqual([]);
  });

  test('a customer in the chain with reminder texts off is never moved', async () => {
    await mockConn('notification_prefs').insert({ customer_id: visitOf('c').customerId, sms_enabled: false });
    const report = await run();
    expect(report.passed.find((p) => p.start === '09:00')).toBeUndefined();
    expect(report.byReason.reminders_off).toBeGreaterThanOrEqual(1);
    expect(sentAnything()).toEqual([]);
  });
});
