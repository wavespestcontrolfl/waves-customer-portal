const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
/**
 * ACCEPTING a make-room hold (GATE_BOOKING_MAKE_ROOM = true) on real PostgreSQL, with every real collaborator: the hold
 * is the proof's own chain for a new customer at 9 AM on a day where B (9), C (10) and D (11) move one hour later.
 * commitReservation moves the stops inside the caller's transaction, writes one reschedule_log row per moved stop
 * (booking_make_room), graduates the hold and sends nothing; a stop whose 24-hour reminder was already sent refuses the
 * accept with nothing moved. Synthetic rows on a far-future day, one transaction that always rolls back, and it refuses
 * any database but a private QA one or CI's.
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
const DAY = '2097-06-10';
const HQ = { lat: 27.4330885, lng: -82.4056801 };
// GATE_REMINDER_72H_EMAIL_FIRST is cleared too: these fixture visits are one-time, and under it their 72-hour reminder
// goes by email, so they would never move.
const GATES = ['GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_NIGHT_TOLD_LOCK', 'GATE_DAY_ONLY_PROMISE', 'GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_TECH_START_POINTS', 'GATE_REMINDER_72H_EMAIL_FIRST', 'GATE_SLOT_TRAVEL_GAP'];

maybeDescribe('make-room accept on real PostgreSQL', () => {
  let database;
  let techId;
  let visits;
  let newCustomerId;
  let estimate;
  const saved = {};

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    for (const key of [...GATES, 'GATE_BOOKING_MAKE_ROOM']) saved[key] = process.env[key];
  });

  afterAll(async () => {
    if (database) await database.destroy();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  beforeEach(async () => {
    Object.values(mockOutbound).forEach((fn) => fn.mockClear && fn.mockClear());
    for (const key of GATES) delete process.env[key];
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    process.env.GATE_BOOKING_MAKE_ROOM = 'true';
    mockConn = await database.transaction();
    // The booking-window config cache reads through the pool once; warm it inside the test transaction.
    await require('../services/scheduling/customer-windows').refreshCustomerBookingWindowConfig(mockConn);

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
        id: v.customerId, first_name: `Room${v.name}zq`, last_name: 'Fixturezq', email: `${v.customerId}@example.invalid`,
        phone: `+1941555${String(2000 + i).padStart(4, '0')}`, address_line1: `${200 + i} Room Test Lane`, city: 'Test City', zip: '00000',
        active: true, pipeline_stage: 'active_customer',
      });
      await mockConn('scheduled_services').insert({
        id: v.id, customer_id: v.customerId, technician_id: techId, scheduled_date: DAY, service_type: 'Quarterly Pest Control Service',
        status: 'pending', window_start: `${pad(v.hour)}:00`, window_end: `${pad(v.hour + 1)}:00`, estimated_duration_minutes: 60,
        lat: HQ.lat + v.dLat, lng: HQ.lng + v.dLng, route_order: i + 1,
      });
    }
    newCustomerId = randomUUID();
    await mockConn('customers').insert({
      id: newCustomerId, first_name: 'Roomnewzq', last_name: 'Fixturezq', email: `${newCustomerId}@example.invalid`,
      phone: '+19415552999', address_line1: '299 Room Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    estimate = {
      id: randomUUID(), token: randomUUID().replace(/-/g, ''), status: 'sent', customer_name: 'Synthetic Room', address: '299 Room Test Lane',
      service_interest: 'Pest Control', expires_at: mockConn.raw("NOW() + INTERVAL '7 days'"),
      estimate_data: JSON.stringify({ result: { recurring: { services: [{ service: 'pest_control', visitsPerYear: 4 }] } } }),
    };
    await mockConn('estimates').insert(estimate);
  });

  afterEach(async () => {
    await mockConn.rollback();
  });

  const visitOf = (name) => visits.find((v) => v.name === name);
  const PIN = { lat: HQ.lat + 0.005, lng: HQ.lng + 0.2 };
  const idsOf = () => visits.map((v) => v.id);
  const rowsNow = async () => Object.fromEntries((await mockConn('scheduled_services').whereIn('id', idsOf()).select('id', 'window_start', 'window_end')).map((r) => [r.id, `${String(r.window_start).slice(0, 5)}-${String(r.window_end).slice(0, 5)}`]));
  const sentAnything = () => Object.entries(mockOutbound).filter(([, fn]) => fn.mock && fn.mock.calls.length > 0).map(([name]) => name);

  // The hold, with the chain the page's proof builds for the 9 AM hour (the same call reserveSlot makes).
  async function holdForNine() {
    const proof = await require('../services/estimate-slot-availability').verifyMakeRoomOffer({
      conn: mockConn, estimate, coords: PIN, date: DAY, windowStart: '09:00:00', techId, durationMinutes: 60, candidateExpectedMinutes: null,
    });
    expect(proof.moves).toBeTruthy();
    const holdId = randomUUID();
    await mockConn('scheduled_services').insert({
      id: holdId, source_estimate_id: estimate.id, customer_id: null, technician_id: techId, scheduled_date: DAY,
      window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60, service_type: 'Pest Control', status: 'pending',
      lat: PIN.lat, lng: PIN.lng, reservation_expires_at: mockConn.raw("NOW() + INTERVAL '15 minutes'"),
      make_room_moves: JSON.stringify({ v: 1, date: DAY, techId, shiftMin: proof.shiftMin, moves: proof.moves.map(({ id, from, to, widthMin }) => ({ id, from, to, widthMin })) }),
    });
    return holdId;
  }

  const accept = (holdId) => require('../services/slot-reservation').commitReservation({
    scheduledServiceId: holdId, customerId: newCustomerId, estimate: { ...estimate, estimate_data: JSON.parse(estimate.estimate_data) },
    serviceMode: 'recurring', selectedFrequency: 'quarterly', trx: mockConn,
  });

  test('a real accept moves B, C and D one hour later, writes one booking_make_room log row each, graduates the hold, and sends nothing', async () => {
    const holdId = await holdForNine();
    const before = await rowsNow();
    const result = await accept(holdId);
    expect(result).toMatchObject({ id: holdId, customer_id: newCustomerId, reservation_expires_at: null });
    const after = await rowsNow();
    expect(after[visitOf('a').id]).toBe(before[visitOf('a').id]);
    expect(after[visitOf('b').id]).toBe('10:00-11:00');
    expect(after[visitOf('c').id]).toBe('11:00-12:00');
    expect(after[visitOf('d').id]).toBe('12:00-13:00');
    expect(after[visitOf('e').id]).toBe(before[visitOf('e').id]);
    const log = await mockConn('reschedule_log').whereIn('scheduled_service_id', idsOf()).select('scheduled_service_id', 'initiated_by', 'reason_code', 'original_date', 'new_date');
    expect(log).toHaveLength(3);
    expect(log.every((l) => l.initiated_by === 'booking_make_room' && l.reason_code === 'booking_make_room')).toBe(true);
    expect(new Set(log.map((l) => l.scheduled_service_id))).toEqual(new Set([visitOf('b').id, visitOf('c').id, visitOf('d').id]));
    const held = await mockConn('scheduled_services').where({ id: holdId }).first('customer_id', 'reservation_expires_at', 'make_room_moves');
    expect(held.customer_id).toBe(newCustomerId);
    expect(held.reservation_expires_at).toBeNull();
    expect(held.make_room_moves).toBeTruthy();
    expect(sentAnything()).toEqual([]);
  });

  test('a moved stop whose 24-hour reminder was sent refuses the accept: the slot-taken answer, nothing moved, no log row', async () => {
    const holdId = await holdForNine();
    await mockConn('appointment_reminders').insert({
      scheduled_service_id: visitOf('c').id, customer_id: visitOf('c').customerId, appointment_time: new Date('2097-06-10T14:00:00Z'),
      service_type: 'Quarterly Pest Control Service', source: 'admin_manual', confirmation_sent: true, reminder_72h_sent: true, reminder_24h_sent: true,
    });
    const before = await rowsNow();
    await expect(accept(holdId)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(await rowsNow()).toEqual(before);
    expect(await mockConn('reschedule_log').whereIn('scheduled_service_id', idsOf())).toHaveLength(0);
    const held = await mockConn('scheduled_services').where({ id: holdId }).first('customer_id');
    expect(held.customer_id).toBeNull();
    expect(sentAnything()).toEqual([]);
  });

  test('an unrelated customer booked into the destination hour after the hold: the accept is refused and the moves roll back with it', async () => {
    const holdId = await holdForNine();
    await mockConn('scheduled_services').insert({
      id: randomUUID(), customer_id: visitOf('a').customerId, technician_id: techId, scheduled_date: DAY, service_type: 'Quarterly Pest Control Service',
      status: 'pending', window_start: '12:00', window_end: '13:00', estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng,
    });
    const before = await rowsNow();
    await expect(accept(holdId)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(await rowsNow()).toEqual(before);
    expect(await mockConn('reschedule_log').whereIn('scheduled_service_id', idsOf())).toHaveLength(0);
  });
});
