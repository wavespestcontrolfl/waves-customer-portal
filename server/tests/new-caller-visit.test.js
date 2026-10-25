// GATE_NEW_CALLER_BOOKING (owner 2026-10-25): New Appointment's Book saves a
// NEW caller's visit by address, with no customer yet, stamped with the live
// call the office answered (services/booking/new-caller-visit.js). The
// request checks, the picker's call shape, the insert contract and the gate
// wiring run everywhere; the call-picker SQL and the real insert run on
// Postgres (CI's DB-gated step, DATABASE_URL). Fixtures fictitious.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Admin auth passes through here; the route test checks the router runs it before the gate.
const mockAdminAuth = {
  adminAuthenticate: jest.fn((req, res, next) => next()),
  requireAdmin: jest.fn((req, res, next) => next()),
};
jest.mock('../middleware/admin-auth', () => mockAdminAuth);

let mockNewCallerGate = true;
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: (gate) => (gate === 'newCallerBooking' ? mockNewCallerGate : actual.isEnabled(gate)),
  };
});

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const {
  validateNewCallerInput,
  toPickableCall,
  stillPickable,
  bookNewCallerVisit,
} = require('../services/booking/new-caller-visit');
const { completeScheduledServiceInsert } = require('../services/booking/create-scheduled-service');

const ADDRESS = { line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 };
const validInput = (overrides = {}) => ({
  scheduledDate: '2027-01-20',
  windowStart: '10:00',
  serviceId: 'svc-1',
  address: ADDRESS,
  ...overrides,
});

describe('new-caller Book request checks', () => {
  test('a complete request is normalized: trimmed date and time, rounded price, FL default state', () => {
    const v = validateNewCallerInput(validInput({
      scheduledDate: ' 2027-01-20 ', windowStart: '10:00:00', linePrice: '89.999', durationMinutes: '45',
      address: { ...ADDRESS, state: '', line1: '  100 Example Way Apt 2 ' },
      callLogId: '0f8b9d1e-2c3a-4b5d-8e6f-7a8b9c0d1e2f',
    }));
    expect(v).toMatchObject({
      scheduledDate: '2027-01-20', windowStart: '10:00', serviceId: 'svc-1', linePrice: 90, durationMinutes: 45,
      technicianId: null, callLogId: '0f8b9d1e-2c3a-4b5d-8e6f-7a8b9c0d1e2f', createInvoice: true,
    });
    expect(v.address).toEqual({ line1: '100 Example Way Apt 2', line2: '', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 });
  });

  test.each([
    [{ scheduledDate: '1/20/2027' }, 'Pick a date.'],
    [{ windowStart: '10am' }, 'Pick a time.'],
    [{ serviceId: '' }, 'Pick a service from the list.'],
    [{ address: { ...ADDRESS, lat: null } }, "Pick the caller's address from the address suggestions."],
    [{ address: { ...ADDRESS, zip: '342' } }, "Pick the caller's address from the address suggestions."],
    [{ address: { ...ADDRESS, line1: '   ' } }, "Pick the caller's address from the address suggestions."],
    [{ callLogId: 'call-1' }, 'Pick the call again.'],
    [{ linePrice: -1 }, 'The price must be a number from 0 to 100000.'],
    [{ durationMinutes: 0 }, 'The visit length must be between 1 and 720 minutes.'],
    [{ durationMinutes: 30.5 }, 'The visit length must be between 1 and 720 minutes.'],
  ])('%j is refused with a 400: %s', (overrides, message) => {
    expect(() => validateNewCallerInput(validInput(overrides))).toThrow(expect.objectContaining({ status: 400, message }));
  });
});

describe('the call picker shows one call', () => {
  test('an answered inbound call: caller masked to its last four digits, the answering staff name, live', () => {
    expect(toPickableCall({
      id: 'c1', direction: 'inbound', from_phone: '+19415550100', to_phone: '+19415550999', status: 'in-progress',
      created_at: '2027-01-15T15:00:00.000Z',
      metadata: { forward_acceptance: { csr_name: 'Office', answered_by_number: '+19415550123' } },
    })).toEqual({ id: 'c1', direction: 'inbound', caller: '•••-0100', answeredBy: 'Office', startedAt: '2027-01-15T15:00:00.000Z', live: true });
  });

  test('an unmapped staff phone shows its masked number; a metadata string is read too; an ended call is not live', () => {
    expect(toPickableCall({
      id: 'c2', direction: 'inbound', from_phone: '+19415550100', status: 'completed', created_at: '2027-01-15T15:00:00.000Z',
      metadata: JSON.stringify({ forward_acceptance: { csr_name: null, answered_by_number: '+19415550123' } }),
    })).toMatchObject({ answeredBy: '•••-0123', live: false });
  });

  test('an outbound callback shows the dialed number and no answering staff', () => {
    expect(toPickableCall({
      id: 'c3', direction: 'outbound', from_phone: '+19415550999', to_phone: '+19415550177', status: 'initiated', created_at: '2027-01-15T15:00:00.000Z',
    })).toMatchObject({ direction: 'outbound', caller: '•••-0177', answeredBy: null, live: true });
  });
});

describe('an ended call leaves the picker 10 minutes after it ends (call-timeline callEndedAt), whatever touched the row since', () => {
  const now = new Date('2027-01-15T15:30:00.000Z');
  const at = (hhmm) => `2027-01-15T${hhmm}:00.000Z`;
  test.each([
    ['a live call, however old its last write', { status: 'in-progress', created_at: at('15:01'), updated_at: at('15:02') }, true],
    ['stamped as ended 20 minutes ago, row touched 1 minute ago by recording processing', { status: 'completed', created_at: at('15:05'), duration_seconds: 120, updated_at: at('15:29'), metadata: { ended_at: at('15:10') } }, false],
    ['stamped as ended 3 minutes ago, though start + one leg\'s length is 25 minutes ago', { status: 'completed', created_at: at('15:00'), duration_seconds: 300, metadata: { ended_at: at('15:27') } }, true],
    ['no stamp: ended 20 minutes ago by start + length, row touched 1 minute ago', { status: 'completed', created_at: at('15:05'), duration_seconds: 300, updated_at: at('15:29') }, false],
    ['no stamp: ended 2 minutes ago after a 16-minute call', { status: 'completed', created_at: at('15:12'), duration_seconds: 960 }, true],
    ['no stamp: the recording length counts when the call length is not known yet', { status: 'completed', created_at: at('15:06'), duration_seconds: 0, recording_duration_seconds: 900 }, true],
    ['a row inserted after the call, with no stamp, has no known end', { status: 'completed', created_at: at('15:28'), duration_seconds: 600, metadata: { source: 'status_callback', inserted_on_status: 'completed' } }, false],
    ['a callback nobody answered, 5 minutes ago', { status: 'no-answer', created_at: at('15:25'), duration_seconds: 0 }, true],
    ['a callback nobody answered, 15 minutes ago', { status: 'no-answer', created_at: at('15:15'), duration_seconds: 0 }, false],
  ])('%s', (_label, row, pickable) => {
    expect(stillPickable(row, { now, endedMinutes: 10 })).toBe(pickable);
  });
});

describe('the insert contract admits the new-caller shape and nothing looser', () => {
  const cols = { source_action: {}, booking_source: {} };
  const shape = (overrides = {}) => ({
    customer_id: null, scheduled_date: '2027-01-20', source_action: 'admin_new_caller', service_address_line1: '100 Example Way', ...overrides,
  });

  test('customer_id null + admin_new_caller + a service address passes with allowNewCallerVisit', async () => {
    const data = await completeScheduledServiceInsert(shape(), { trx: {}, cols, source: { sourceAction: 'admin_new_caller' }, allowNewCallerVisit: true });
    expect(data).toMatchObject({ customer_id: null, source_action: 'admin_new_caller' });
  });

  test.each([
    ['without the option', shape(), {}],
    ['with a hold expiry', shape({ reservation_expires_at: new Date() }), { allowNewCallerVisit: true }],
    ['under another attribution', shape({ source_action: 'admin_manual' }), { allowNewCallerVisit: true }],
    ['without a service address', shape({ service_address_line1: ' ' }), { allowNewCallerVisit: true }],
    ['with the customer merely omitted', (() => { const s = shape(); delete s.customer_id; return s; })(), { allowNewCallerVisit: true }],
  ])('is refused %s', async (_label, data, opts) => {
    await expect(completeScheduledServiceInsert(data, { trx: {}, cols, source: { sourceAction: 'admin_new_caller' }, ...opts }))
      .rejects.toThrow(/customer_id is required/);
  });
});

describe('GATE_NEW_CALLER_BOOKING wiring', () => {
  function gateWith(value) {
    const saved = process.env.GATE_NEW_CALLER_BOOKING;
    if (value === undefined) delete process.env.GATE_NEW_CALLER_BOOKING; else process.env.GATE_NEW_CALLER_BOOKING = value;
    try {
      let on;
      jest.isolateModules(() => { on = jest.requireActual('../config/feature-gates').isEnabled('newCallerBooking'); });
      return on;
    } finally {
      if (saved === undefined) delete process.env.GATE_NEW_CALLER_BOOKING; else process.env.GATE_NEW_CALLER_BOOKING = saved;
    }
  }

  test('is off unless set, on for true', () => {
    expect(gateWith(undefined)).toBe(false);
    expect(gateWith('false')).toBe(false);
    expect(gateWith('true')).toBe(true);
  });

  test('rides the admin schedule day view to Dispatch, and the route mounts before the main schedule router', () => {
    const day = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(day).toContain("newCallerBooking: isEnabled('newCallerBooking')");
    const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const own = index.indexOf("app.use('/api/admin/schedule/new-caller'");
    const main = index.indexOf("app.use('/api/admin/schedule', require('./routes/admin-schedule'))");
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(main);
  });

  test('Book locks the call row, then takes the recording processor\'s call lock with the same key, before the date lock', () => {
    const lock = "pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['call-recording-schedule',";
    const own = fs.readFileSync(path.join(__dirname, '../services/booking/new-caller-visit.js'), 'utf8');
    const processor = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(processor).toContain(`${lock} callSid]`);
    expect(own).toContain(`${lock} call.twilio_call_sid]`);
    // The call row's id first (an outbound bridge may have no Call SID yet), then the processor's key, then the ownership read.
    const byId = own.indexOf("['new-caller-visit-call', call.id]");
    expect(byId).toBeGreaterThan(-1);
    expect(byId).toBeLessThan(own.indexOf(lock));
    expect(own.indexOf(lock)).toBeLessThan(own.indexOf("linked.where('source_call_log_id', call.id)"));
    expect(own.indexOf(lock)).toBeLessThan(own.indexOf('await probeSlotOverlap('));
  });

  test('a misting refill is refused as the visit itself, before any write (the create route\'s own rule)', async () => {
    const { MISTING_REFILL_CATALOG_KEY } = require('../utils/mosquito-misting-system');
    const saved = process.env.GATE_MOSQUITO_MISTING;
    process.env.GATE_MOSQUITO_MISTING = 'true';
    try {
      const transaction = jest.fn();
      const refill = { id: 'svc-r', service_key: MISTING_REFILL_CATALOG_KEY, name: 'Mosquito Misting System Refill', base_price: 129 };
      const conn = Object.assign((table) => ({ where: () => ({ first: async () => (table === 'services' ? refill : null) }) }), { transaction });
      await expect(bookNewCallerVisit({ input: validInput({ serviceId: 'svc-r' }), conn }))
        .rejects.toMatchObject({ status: 400, code: 'MISTING_REFILL_ADDON_ONLY' });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = saved;
    }
  });

  test('the service refuses with a 404 while the gate is off, before any read', async () => {
    mockNewCallerGate = false;
    try {
      const conn = () => { throw new Error('no query expected'); };
      await expect(bookNewCallerVisit({ input: validInput(), conn })).rejects.toMatchObject({ status: 404 });
    } finally {
      mockNewCallerGate = true;
    }
  });

  test('the routes run admin auth, then answer 404 while the gate is off', async () => {
    const app = express();
    app.use(express.json());
    app.use('/new-caller', require('../routes/admin-schedule-new-caller'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockNewCallerGate = false;
    try {
      const { port } = server.address();
      const calls = await fetch(`http://127.0.0.1:${port}/new-caller/calls`);
      const book = await fetch(`http://127.0.0.1:${port}/new-caller`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect([calls.status, book.status]).toEqual([404, 404]);
      expect(mockAdminAuth.adminAuthenticate).toHaveBeenCalledTimes(2);
      expect(mockAdminAuth.requireAdmin).toHaveBeenCalledTimes(2);
    } finally {
      mockNewCallerGate = true;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('new-caller booking on Postgres', () => {
  let db;
  let service;
  const made = { callIds: [], visitIds: [] };
  const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

  // updated_at defaults to a minute ago on every row: later writes (recording
  // processing, metadata) bump it, and it must never decide whether a call lists.
  async function insertCall({ direction = 'inbound', status = 'in-progress', acceptedMinutesAgo = 5, createdMinutesAgo = 6, durationSeconds = 0, endedMinutesAgo = null, answeredBy = null, accepted = true } = {}) {
    const metadata = {
      ...(accepted && direction === 'inbound' ? { forward_acceptance: { accepted: true, csr_name: 'Office', answered_by_number: '+15555550123', accepted_at: minutesAgo(acceptedMinutesAgo).toISOString() } } : {}),
      // The stamp /call-status writes from Twilio's event time.
      ...(endedMinutesAgo == null ? {} : { ended_at: minutesAgo(endedMinutesAgo).toISOString() }),
    };
    const [row] = await db('call_log').insert({
      direction,
      from_phone: direction === 'inbound' ? '+15555550100' : '+15555550999',
      to_phone: direction === 'inbound' ? '+15555550999' : '+15555550177',
      status,
      answered_by: answeredBy,
      twilio_call_sid: `CA${require('crypto').randomBytes(16).toString('hex')}`,
      duration_seconds: durationSeconds,
      created_at: minutesAgo(createdMinutesAgo),
      updated_at: minutesAgo(1),
      metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    }).returning(['id']);
    made.callIds.push(row.id);
    return row.id;
  }

  beforeAll(() => {
    db = require('../models/db');
    service = require('../services/booking/new-caller-visit');
  });
  afterAll(async () => {
    if (made.visitIds.length) {
      await db('activity_log').where('action', 'new_caller_visit_booked').whereRaw("metadata->>'scheduled_service_id' = ANY(?)", [made.visitIds]).del();
      await db('scheduled_services').whereIn('id', made.visitIds).del();
    }
    if (made.callIds.length) await db('call_log').whereIn('id', made.callIds).del();
    await db.destroy();
  });

  test('lists answered and recent calls, never a voice-agent call, an old answer or a long-ended call', async () => {
    const live = await insertCall();
    const endedJustNow = await insertCall({ status: 'completed', createdMinutesAgo: 6, durationSeconds: 120 });
    const bridge = await insertCall({ direction: 'outbound', status: 'initiated', createdMinutesAgo: 3 });
    const agentHeld = await insertCall({ accepted: false, answeredBy: 'ai_agent' });
    const oldAnswer = await insertCall({ acceptedMinutesAgo: 45, createdMinutesAgo: 46 });
    // Ended 20 minutes ago; its row was touched a minute ago (insertCall's updated_at).
    const endedLongAgo = await insertCall({ status: 'completed', acceptedMinutesAgo: 24, createdMinutesAgo: 25, durationSeconds: 300 });
    // Only the stored stamp says this one ended 3 minutes ago (one leg's length says 24).
    const stampedRecent = await insertCall({ status: 'completed', acceptedMinutesAgo: 24, createdMinutesAgo: 25, durationSeconds: 60, endedMinutesAgo: 3 });
    const ids = (await service.listPickableCalls()).map((call) => call.id);
    expect(ids).toEqual(expect.arrayContaining([live, endedJustNow, bridge, stampedRecent]));
    for (const id of [agentHeld, oldAnswer, endedLongAgo]) expect(ids).not.toContain(id);
  });

  test('Book writes one visit with no customer, the address and the call, and warns on a second booking at the same time', async () => {
    const svc = await db('services').whereNot('service_key', 'mosquito_one_time').whereNotNull('name').first('id', 'name');
    expect(svc).toBeTruthy();
    const callId = await insertCall();
    const input = validInput({ serviceId: svc.id, callLogId: callId, scheduledDate: '2031-03-04', windowStart: '10:00' });
    const first = await service.bookNewCallerVisit({ input, zone: 'bradenton_north' });
    made.visitIds.push(first.visit.id);
    const row = await db('scheduled_services').where({ id: first.visit.id }).first();
    expect(row).toMatchObject({
      customer_id: null, source_action: 'admin_new_caller', source_call_log_id: callId, status: 'pending',
      service_address_line1: '100 Example Way', service_address_zip: '34200', service_type: svc.name, is_recurring: false,
    });
    expect(row.reservation_expires_at).toBeNull();
    expect(row.internal_notes).toContain(`Call ID: ${callId}`);
    expect(first.warnings).toEqual([]);

    const second = await service.bookNewCallerVisit({ input: { ...input, callLogId: null }, zone: 'bradenton_north' });
    made.visitIds.push(second.visit.id);
    expect(second.visit.source_call_log_id).toBeNull();
    expect(second.warnings).toHaveLength(1);
  });

  test('a call that already has a visit is refused with a 409: a repeated Book (the processor stamps its own booking the same way)', async () => {
    const svc = await db('services').whereNot('service_key', 'mosquito_one_time').whereNotNull('name').first('id');
    const callId = await insertCall();
    const input = validInput({ serviceId: svc.id, callLogId: callId, scheduledDate: '2031-03-06', windowStart: '11:00' });
    const first = await service.bookNewCallerVisit({ input });
    made.visitIds.push(first.visit.id);
    await expect(service.bookNewCallerVisit({ input })).rejects.toMatchObject({ status: 409, message: 'This call already has a visit. Find it on Dispatch.' });
    const rows = await db('scheduled_services').where({ source_call_log_id: callId }).count({ n: '*' }).first();
    expect(Number(rows.n)).toBe(1);
  });

  test('a call that is no longer pickable is refused with a 409 and writes nothing', async () => {
    const svc = await db('services').whereNot('service_key', 'mosquito_one_time').whereNotNull('name').first('id');
    const stale = await insertCall({ status: 'completed', acceptedMinutesAgo: 120, createdMinutesAgo: 121, durationSeconds: 300 });
    const before = await db('scheduled_services').where({ source_call_log_id: stale }).count({ n: '*' }).first();
    await expect(service.bookNewCallerVisit({ input: validInput({ serviceId: svc.id, callLogId: stale, scheduledDate: '2031-03-05' }) }))
      .rejects.toMatchObject({ status: 409 });
    const after = await db('scheduled_services').where({ source_call_log_id: stale }).count({ n: '*' }).first();
    expect(Number(after.n)).toBe(Number(before.n));
  });
});
