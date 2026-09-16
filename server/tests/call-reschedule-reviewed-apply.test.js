jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn() }));

const { applyReviewedCallReschedule, planRescheduleFromCall } = require('../services/call-reschedule-apply');
const reminders = require('../services/appointment-reminders');
const canonicalMover = require('../services/rebooker');

const NOW = new Date('2026-09-12T16:00:00Z');
const call = { id: 'call-reviewed', customer_id: 'customer-reviewed', direction: 'inbound',
  from_phone: '+15555550101', created_at: NOW };
const customer = { id: call.customer_id, phone: '+15555550101' };
const extraction = { meta: {}, caller: {}, consent: {}, property: {},
  scheduling: { status: 'reschedule_requested', proposed_start_at: '2026-09-15T14:00:00-04:00' } };

function visit(overrides = {}) {
  return {
    id: 'visit-reviewed', customer_id: customer.id, property_id: 'property-reviewed',
    service_id: 'service-reviewed', service_type: 'Quarterly Pest Control Service',
    scheduled_date: '2026-09-14', window_start: '09:00:00', window_end: '10:00:00',
    estimated_duration_minutes: 60, status: 'confirmed', source_action: null, visit_id: null,
    is_recurring: false, customer_confirmed: true, self_booking_id: null,
    service_address_line1: '100 Example Street', service_address_line2: null,
    service_address_city: 'Bradenton', service_address_state: 'FL', service_address_zip: '34205',
    internal_notes: 'Existing staff note',
    ...overrides,
  };
}

function makeConn({ lockedVisit = visit(), portalRequest = null } = {}) {
  const events = [];
  const inserts = [];
  const updates = [];
  const builder = (table) => {
    const state = { update: false, scheduledIds: null };
    const query = {
      where() { return query; },
      whereNull() { return query; },
      whereNot() { return query; },
      whereNotIn() { return query; },
      whereIn(column, values) {
        if (table === 'scheduled_services' && column === 'id') state.scheduledIds = values.map(String);
        return query;
      },
      orderBy() { return query; },
      forShare() { events.push(`${table}:share`); return query; },
      forUpdate() { events.push(`${table}:update-lock`); return query; },
      select() { return query; },
      first() {
        if (table === 'customers') return Promise.resolve(customer);
        if (table === 'call_log') return Promise.resolve(call);
        if (table === 'service_requests') {
          events.push('service_requests:select');
          return Promise.resolve(portalRequest || undefined);
        }
        if (table === 'triage_items') return Promise.resolve(undefined);
        return Promise.resolve(undefined);
      },
      update(value) { state.update = true; updates.push({ table, value }); return query; },
      insert(row) { inserts.push({ table, row }); events.push(`${table}:insert`); return Promise.resolve([row]); },
      then(resolve, reject) {
        if (table === 'scheduled_services' && state.scheduledIds) return Promise.resolve([lockedVisit]).then(resolve, reject);
        if (table === 'reschedule_log' || table === 'customer_properties') return Promise.resolve([]).then(resolve, reject);
        if (state.update) return Promise.resolve(1).then(resolve, reject);
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return query;
  };
  const conn = (table) => builder(table);
  conn.raw = (_sql, bindings) => {
    events.push(String(bindings?.[0] || '').startsWith('customer-comms:') ? 'customer-comms:lock' : 'triage-call:lock');
    return Promise.resolve();
  };
  conn.transaction = (fn) => fn(conn);
  Object.assign(conn, { events, inserts, updates });
  return conn;
}

function args(conn, rebooker, candidates = [visit()]) {
  return { conn, call, v2: extraction, customer, candidates, visitId: 'visit-reviewed', actorId: 'staff-reviewed',
    operationKey: 'proposal:card:hash', guard: jest.fn(async () => { conn.events.push('proposal:guard'); }),
    now: NOW, rebooker };
}

function mover(conn) {
  return { reschedule: jest.fn(async (...params) => {
    const options = params[5];
    await options.beforeMove(conn);
    await options.moveGuard({ trx: conn });
    return {};
  }) };
}

describe('reviewed call reschedule', () => {
  beforeEach(() => reminders.handleReschedule.mockClear().mockResolvedValue({}));

  test('takes the customer fence before identity rows and preserves current internal notes', async () => {
    const conn = makeConn({ lockedVisit: visit({ internal_notes: 'New staff note written before Apply' }) });
    const rebooker = mover(conn);
    await expect(applyReviewedCallReschedule(args(conn, rebooker))).resolves.toMatchObject({
      outcome: 'applied', visitId: 'visit-reviewed', newDate: '2026-09-15',
    });
    expect(conn.events.slice(0, 5)).toEqual([
      'customer-comms:lock', 'customers:share', 'customer_properties:share', 'triage-call:lock', 'call_log:update-lock',
    ]);
    expect(conn.updates.filter(({ table }) => table === 'scheduled_services')).toEqual([]);
    expect(rebooker.reschedule.mock.calls[0][5]).toMatchObject({
      skipCallFollowUpShift: true, notifyRequested: false, pendingConfirmation: true, operationKey: 'proposal:card:hash',
    });
    expect(reminders.handleReschedule).toHaveBeenCalledWith('visit-reviewed', '2026-09-15T14:00',
      { sendNotification: false, expectSchedule: { date: '2026-09-15', windowStart: '14:00' } });
  });

  test('refuses an open portal request after locking the selected visit and before proposal mutation', async () => {
    const conn = makeConn({ portalRequest: { id: 'request-open' } });
    await expect(applyReviewedCallReschedule(args(conn, mover(conn)))).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('portal reschedule request'),
    });
    expect(conn.events.indexOf('scheduled_services:update-lock')).toBeLessThan(conn.events.indexOf('service_requests:select'));
    expect(conn.inserts).toEqual([]);
  });

  test('uses the canonical mover when no test injection is supplied', async () => {
    const conn = makeConn();
    canonicalMover.reschedule.mockImplementationOnce(async (...params) => {
      await params[5].beforeMove(conn);
      await params[5].moveGuard({ trx: conn });
      return {};
    });
    await expect(applyReviewedCallReschedule(args(conn, null))).resolves.toMatchObject({ outcome: 'applied' });
    expect(canonicalMover.reschedule).toHaveBeenCalledTimes(1);
  });

  test('does not invoke the mover for a confirmed dispatch-owned visit', async () => {
    const protectedVisit = visit({ source_action: 'ai_call_pipeline_followup', status: 'confirmed' });
    const conn = makeConn({ lockedVisit: protectedVisit });
    const rebooker = mover(conn);

    await expect(applyReviewedCallReschedule(args(conn, rebooker, [protectedVisit]))).resolves.toEqual({
      outcome: 'skipped',
      reason: 'dispatch_owned_workflow',
    });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(conn.events).toEqual([]);
  });

  test.each([
    ['agent commitment', { agent_committed_booking: true }, 'agent_committed_booking'],
    ['confirmed time', { confirmed_start_at: '2026-09-15T14:00:00-04:00' }, 'confirmed_start_supersedes_proposal'],
  ])('refuses a request-only proposal superseded by %s', (_label, scheduling, reason) => {
    const v2 = { ...extraction, scheduling: { ...extraction.scheduling, ...scheduling } };
    expect(planRescheduleFromCall({ v2, call, customer, candidates: [visit()], now: NOW,
      humanOverride: { visitId: 'visit-reviewed' } })).toMatchObject({ action: 'skip', reason });
  });
});
