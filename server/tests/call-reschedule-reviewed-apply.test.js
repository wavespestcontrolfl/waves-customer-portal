jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-dispatch', () => ({ applySeriesMoveEffects: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn().mockResolvedValue({}) }));

const { applyReviewedCallReschedule, planRescheduleFromCall } = require('../services/call-reschedule-apply');
const AppointmentReminders = require('../services/appointment-reminders');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');

const NOW = new Date('2026-09-12T16:00:00Z');
const CALL_ID = 'call-reviewed';
const CUSTOMER_ID = 'customer-reviewed';
const VISIT_ID = 'visit-reviewed';
const ACTOR_ID = 'staff-reviewed';
const OPERATION_KEY = 'reschedule-proposal:card-reviewed:preview-reviewed';

const call = { id: CALL_ID, customer_id: CUSTOMER_ID, direction: 'inbound', from_phone: '+15555550101',
  created_at: new Date('2026-09-12T15:00:00Z'), transcription: 'Caller: Could you come at two instead?' };
const customer = { id: CUSTOMER_ID, phone: '+15555550199', secondary_phone: '+15555550101' };
const extraction = { meta: { is_spam: false, is_voicemail: false }, caller: { decision_maker_present: true },
  consent: { do_not_contact_request: false }, scheduling: { status: 'reschedule_requested', proposed_start_at: '2026-09-15T14:00:00-04:00' },
  property: {} };

function visit(overrides = {}) {
  return {
    id: VISIT_ID,
    customer_id: CUSTOMER_ID,
    property_id: 'property-reviewed',
    service_id: 'service-reviewed',
    service_type: 'Quarterly Pest Control Service',
    catalog_service_name: 'Quarterly Pest Control Service',
    scheduled_date: '2026-09-14',
    window_start: '09:00:00',
    window_end: '10:00:00',
    estimated_duration_minutes: 60,
    status: 'confirmed',
    source_action: null,
    visit_id: null,
    is_recurring: false,
    customer_confirmed: true,
    self_booking_id: null,
    service_address_line1: '100 Example Street',
    service_address_line2: null,
    service_address_city: 'Bradenton',
    service_address_zip: '34205',
    ...overrides,
  };
}

function makeConn({ lockedVisit = visit(), offers = [], portalRequest = null } = {}) {
  const events = [];
  const inserts = [];
  const updates = [];
  const builder = (table) => {
    const state = { update: null, excludedStatuses: [] };
    const query = {
      where() { return query; },
      whereNotIn(column, values) {
        if (table === 'service_requests' && column === 'status') state.excludedStatuses = values;
        return query;
      },
      whereNull() { return query; },
      forShare() { events.push(`${table}:share`); return query; },
      forUpdate() { events.push(`${table}:update-lock`); return query; },
      select() { if (table === 'reschedule_log') events.push('reschedule_log:select'); return query; },
      first() {
        if (table === 'customers') return Promise.resolve(customer);
        if (table === 'call_log') return Promise.resolve(call);
        if (table === 'scheduled_services') return Promise.resolve(lockedVisit);
        if (table === 'service_requests') {
          events.push('service_requests:select');
          return Promise.resolve(portalRequest && !state.excludedStatuses.includes(portalRequest.status)
            ? portalRequest : undefined);
        }
        return Promise.resolve(undefined);
      },
      update(arg) { state.update = arg; updates.push({ table, arg }); return query; },
      insert(row) { inserts.push({ table, row }); events.push(`${table}:insert`); return Promise.resolve([row]); },
      then(resolve, reject) {
        if (table === 'reschedule_log') return Promise.resolve(offers).then(resolve, reject);
        if (state.update) return Promise.resolve(1).then(resolve, reject);
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return query;
  };
  const conn = (table) => builder(table);
  conn.raw = () => { events.push('triage-call:lock'); return Promise.resolve(); };
  conn.transaction = (fn) => fn(conn);
  conn.events = events;
  conn.inserts = inserts;
  conn.updates = updates;
  return conn;
}

function mover(conn, result = {}) {
  return { reschedule: jest.fn(async (_id, _date, _window, _reason, _initiatedBy, options) => {
    await options.beforeMove(conn);
    await options.moveGuard({ trx: conn, service: { stale_outer_snapshot: true } });
    return result;
  }) };
}

function applyArgs(conn, rebooker, guard = jest.fn(async () => { conn.events.push('proposal:guard'); })) {
  return { conn, call, v2: extraction, customer, candidates: [visit()], visitId: VISIT_ID, actorId: ACTOR_ID,
    operationKey: OPERATION_KEY, guard, now: NOW, rebooker };
}

describe('applyReviewedCallReschedule', () => {
  beforeEach(() => {
    AppointmentReminders.handleReschedule.mockClear().mockResolvedValue({});
    emitDispatchJobUpdate.mockClear().mockResolvedValue({});
  });

  test('locks identity rows in order, applies the guarded move, and resyncs without an immediate send', async () => {
    const conn = makeConn();
    const rebooker = mover(conn, { warnings: ['Both appointments remain on the calendar.'] });
    const result = await applyReviewedCallReschedule(applyArgs(conn, rebooker));

    expect(result).toMatchObject({ outcome: 'applied', visitId: VISIT_ID, newDate: '2026-09-15', warnings: ['Both appointments remain on the calendar.'] });
    expect(conn.events.slice(0, 5)).toEqual([
      'customers:share',
      'customer_properties:share',
      'triage-call:lock',
      'call_log:update-lock',
      'scheduled_services:update-lock',
    ]);
    const options = rebooker.reschedule.mock.calls[0][5];
    expect(options).toMatchObject({ pendingConfirmation: true, notifyRequested: false, skipCallFollowUpShift: true,
      adminWindowRules: true, overlapAdvisory: true,
      sourceSurface: 'call_reschedule', operationKey: OPERATION_KEY, expect: { customer_id: CUSTOMER_ID,
        scheduled_date: '2026-09-14', status: 'confirmed', visit_id: null } });
    expect(conn.events.indexOf('proposal:guard')).toBeLessThan(conn.events.indexOf('activity_log:insert'));
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith(
      VISIT_ID,
      '2026-09-15T14:00',
      { sendNotification: false, expectSchedule: { date: '2026-09-15', windowStart: '14:00' } },
    );
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: VISIT_ID, actorId: ACTOR_ID });
  });

  test('a newly joined group member is refused before any member moves or the card resolves', async () => {
    const conn = makeConn();
    const guard = jest.fn();
    const rebooker = { reschedule: jest.fn(async (...args) => {
      await args[5].memberGuard({ members: [visit(), visit({ id: 'new-member' })] });
      await args[5].moveGuard({ trx: conn });
    }) };
    await expect(applyReviewedCallReschedule(applyArgs(conn, rebooker, guard))).rejects.toThrow('visit group changed');
    expect(guard).not.toHaveBeenCalled();
    expect(conn.inserts).toHaveLength(0);
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
  });

  test('uses the locked source row rather than the mover outer snapshot for the full visit fence', async () => {
    const conn = makeConn({ lockedVisit: visit({ customer_confirmed: false }) });
    const rebooker = mover(conn);
    const guard = jest.fn();

    await expect(applyReviewedCallReschedule(applyArgs(conn, rebooker, guard))).rejects.toMatchObject({ status: 409 });
    expect(guard).not.toHaveBeenCalled();
    expect(conn.inserts).toHaveLength(0);
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
  });

  test('a rejected proposal guard leaves the move side effects unwritten', async () => {
    const conn = makeConn();
    const rebooker = mover(conn);
    const guard = jest.fn(async () => { throw Object.assign(new Error('proposal changed'), { status: 409 }); });

    await expect(applyReviewedCallReschedule(applyArgs(conn, rebooker, guard))).rejects.toThrow('proposal changed');
    expect(conn.inserts).toHaveLength(0);
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
  });

  test('an actionable SMS offer is checked under the selected visit lock', async () => {
    const offer = { id: 'offer-1', notes: JSON.stringify({ option1: { date: '2026-09-16', window: { start: '08:00', end: '09:00' } } }) };
    const conn = makeConn({ offers: [offer] });
    const rebooker = mover(conn);
    const guard = jest.fn();

    await expect(applyReviewedCallReschedule(applyArgs(conn, rebooker, guard))).rejects.toThrow('text-message reschedule offer');
    expect(conn.events.indexOf('scheduled_services:update-lock')).toBeLessThan(conn.events.indexOf('reschedule_log:select'));
    expect(guard).not.toHaveBeenCalled();
    expect(conn.inserts).toHaveLength(0);
  });

  test('an open portal request is refused under the selected visit lock before proposal mutation', async () => {
    const conn = makeConn({ portalRequest: { id: 'request-1', status: 'new' } });
    const rebooker = mover(conn);
    const guard = jest.fn();

    await expect(applyReviewedCallReschedule(applyArgs(conn, rebooker, guard))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('portal reschedule request'),
    });
    expect(conn.events.indexOf('scheduled_services:update-lock')).toBeLessThan(conn.events.indexOf('service_requests:select'));
    expect(guard).not.toHaveBeenCalled();
    expect(conn.inserts).toHaveLength(0);
  });

  test('a resolved portal request is history and does not block a reviewed no-op', async () => {
    const alreadyThere = visit({ scheduled_date: '2026-09-15', window_start: '14:00:00', window_end: '15:00:00' });
    const conn = makeConn({ lockedVisit: alreadyThere, portalRequest: { id: 'request-1', status: 'resolved' } });
    const guard = jest.fn(async () => { conn.events.push('proposal:guard'); });

    const result = await applyReviewedCallReschedule({ ...applyArgs(conn, mover(conn), guard), candidates: [alreadyThere] });
    expect(result).toEqual({ outcome: 'noop', visitId: VISIT_ID });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(conn.inserts.map(({ table }) => table)).toEqual(['activity_log']);
  });

  test('reviewed destinations must fit the canonical admin appointment window', () => {
    const candidate = visit({ estimated_duration_minutes: 60 });
    const late = { ...extraction, scheduling: { ...extraction.scheduling, proposed_start_at: '2026-09-15T20:00:00-04:00' } };

    expect(() => planRescheduleFromCall({ v2: late, call, customer, candidates: [candidate], now: NOW,
      humanOverride: { visitId: VISIT_ID } })).toThrow('end by 20:00');
  });

  test.each([
    ['pending', false],
    ['pending', true],
    ['confirmed', true],
  ])('office-review source stays in the schedule editor when %s and customer_confirmed=%s', async (status, customerConfirmed) => {
    const candidate = visit({ status, customer_confirmed: customerConfirmed, source_action: 'voice_agent' });
    const plan = planRescheduleFromCall({ v2: extraction, call, customer, candidates: [candidate], now: NOW,
      humanOverride: { visitId: VISIT_ID } });
    expect(plan).toMatchObject({ action: 'skip', reason: 'office_review_unconfirmed', visitId: VISIT_ID });
  });
});
