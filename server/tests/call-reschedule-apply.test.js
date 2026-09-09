// Call reschedule apply: the fail-closed planner and the applier's writes
// (rebooker call, access note, activity row, card resolve) against a mocked
// connection. Fixtures are fictitious (555-01xx numbers, synthetic ids).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const {
  planRescheduleFromCall,
  applyCallReschedule,
  MIN_SCHEDULING_CONFIDENCE,
  ACTIVITY_ACTION,
  RESCHEDULE_REASON_CODE,
  INITIATED_BY,
} = require('../services/call-reschedule-apply');

const NOW = new Date('2026-09-08T19:20:00Z'); // 3:20 PM ET
const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const CALL_ID = 'a0000000-0000-4000-8000-000000000001';
const VISIT_ID = '70000000-0000-4000-8000-000000000001';
const PHONE = '+15555550101';

function v2(overrides = {}) {
  const base = {
    meta: { is_spam: false, is_voicemail: false },
    caller: { decision_maker_present: true },
    consent: { do_not_contact_request: false },
    confidence: { scheduling_window: 0.99 },
    scheduling: {
      status: 'reschedule_requested',
      agent_committed_booking: true,
      confirmed_start_at: '2026-09-24T12:00:00-04:00',
    },
    property: { access_notes: 'Caller requested that the interior be serviced as well.' },
  };
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
}

const call = (overrides = {}) => ({
  id: CALL_ID, customer_id: CUSTOMER_ID, direction: 'inbound', from_phone: PHONE, to_phone: '+15555550100',
  created_at: new Date('2026-09-08T19:07:24Z'), ...overrides,
});
const customer = (overrides = {}) => ({ id: CUSTOMER_ID, phone: PHONE, ...overrides });
const visit = (overrides = {}) => ({
  id: VISIT_ID, scheduled_date: new Date('2026-09-24T00:00:00Z'), window_start: '09:00:00', window_end: '10:00:00',
  estimated_duration_minutes: null, status: 'pending', source_action: null, visit_id: null, internal_notes: null, is_recurring: true,
  ...overrides,
});

describe('planRescheduleFromCall', () => {
  test('applies a same-day time move on the single matching visit, keeping the duration', () => {
    const plan = planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit()], now: NOW });
    expect(plan).toMatchObject({
      action: 'apply', visitId: VISIT_ID, dateMove: false, newDate: '2026-09-24',
      newWindow: { start: '12:00', end: '13:00' },
      from: { date: '2026-09-24', start: '09:00', end: '10:00' },
    });
    expect(plan.interiorNote).toMatch(/interior/);
  });

  test('a date move within the span is a dateMove on that visit', () => {
    const plan = planRescheduleFromCall({
      v2: v2({ scheduling: { confirmed_start_at: '2026-09-25T10:00:00-04:00' } }),
      call: call(), customer: customer(), candidates: [visit()], now: NOW,
    });
    expect(plan).toMatchObject({ action: 'apply', dateMove: true, newDate: '2026-09-25', newWindow: { start: '10:00', end: '11:00' } });
  });

  test('reports already_at_requested_time when the visit is where the caller asked', () => {
    const plan = planRescheduleFromCall({
      v2: v2({ scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00' } }),
      call: call(), customer: customer(), candidates: [visit()], now: NOW,
    });
    expect(plan.action).toBe('already_at_requested_time');
  });

  test.each([
    ['not_a_reschedule', { scheduling: { status: 'confirmed' } }],
    ['cancel_not_automated', { scheduling: { status: 'canceled' } }],
    ['agent_did_not_commit', { scheduling: { agent_committed_booking: false } }],
    ['no_confirmed_start', { scheduling: { confirmed_start_at: null } }],
    ['low_scheduling_confidence', { confidence: { scheduling_window: MIN_SCHEDULING_CONFIDENCE - 0.01 } }],
    ['caller_not_decision_maker', { caller: { decision_maker_present: false } }],
    ['do_not_contact_requested', { consent: { do_not_contact_request: true } }],
    ['spam', { meta: { is_spam: true } }],
    ['voicemail', { meta: { is_voicemail: true } }],
    ['confirmed_start_in_past', { scheduling: { confirmed_start_at: '2026-09-01T12:00:00-04:00' } }],
    ['off_grid_start_time', { scheduling: { confirmed_start_at: '2026-09-24T12:10:00-04:00' } }],
    ['unparseable_confirmed_start', { scheduling: { confirmed_start_at: 'noon-ish' } }],
  ])('skips with %s', (reason, overrides) => {
    const plan = planRescheduleFromCall({ v2: v2(overrides), call: call(), customer: customer(), candidates: [visit()], now: NOW });
    expect(plan).toEqual(expect.objectContaining({ action: 'skip', reason }));
  });

  test('skips when the pipeline already created an appointment from this call', () => {
    const plan = planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit()], appointmentCreated: true, now: NOW });
    expect(plan.reason).toBe('pipeline_created_appointment');
  });

  test('identity: unmatched call or a number not on file stays a card', () => {
    expect(planRescheduleFromCall({ v2: v2(), call: call({ customer_id: null }), customer: customer(), candidates: [visit()], now: NOW }).reason).toBe('customer_not_matched');
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: null, candidates: [visit()], now: NOW }).reason).toBe('customer_not_matched');
    expect(planRescheduleFromCall({ v2: v2(), call: call({ from_phone: '+15555550199' }), customer: customer(), candidates: [visit()], now: NOW }).reason).toBe('caller_phone_not_on_file');
    // Outbound: the dialed party is the customer.
    const out = planRescheduleFromCall({ v2: v2(), call: call({ direction: 'outbound', from_phone: '+15555550100', to_phone: PHONE }), customer: customer(), candidates: [visit()], now: NOW });
    expect(out.action).toBe('apply');
  });

  test('visit selection: none, ambiguous, grouped, dispatch-owned pending, far cadence sibling', () => {
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [], now: NOW }).reason).toBe('no_visit_on_books');
    const two = planRescheduleFromCall({
      v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit(), visit({ id: '70000000-0000-4000-8000-000000000002', scheduled_date: '2026-09-30' })],
    });
    expect(two).toMatchObject({ reason: 'ambiguous_visit', candidateIds: [VISIT_ID, '70000000-0000-4000-8000-000000000002'] });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ visit_id: 'v1' })], now: NOW }).reason).toBe('grouped_visit');
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ source_action: 'ai_call_pipeline_followup' })], now: NOW }).reason).toBe('dispatch_owned_pending');
    // The December quarterly sibling is outside the span and does not make the September move ambiguous.
    const withSibling = planRescheduleFromCall({
      v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit(), visit({ id: '70000000-0000-4000-8000-000000000003', scheduled_date: '2026-12-17', window_start: '14:00:00', window_end: '15:00:00' })],
    });
    expect(withSibling).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('duration falls back to estimated_duration_minutes, then 60', () => {
    const p = planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ window_end: null, estimated_duration_minutes: 90 })], now: NOW });
    expect(p.newWindow).toEqual({ start: '12:00', end: '13:30' });
    const q = planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ window_start: null, window_end: null })], now: NOW });
    expect(q.newWindow).toEqual({ start: '12:00', end: '13:00' });
  });
});

// ── applier against a mocked connection ─────────────────────────────────
function makeConn({ owned = true, prior = null, cust = customer(), visits = [visit()], openCards = 1, remaining = 0 } = {}) {
  const writes = { updates: [], inserts: [] };
  const builder = (table) => {
    const state = { table, where: [], whereIn: [], updateArg: null };
    const q = {
      where(...a) { state.where.push(a); return q; },
      whereIn(...a) { state.whereIn.push(a); return q; },
      whereNull() { return q; },
      whereRaw() { return q; },
      orderBy() { return q; },
      count() { return q; },
      select() { return q; },
      update(arg) { state.updateArg = arg; writes.updates.push({ table, arg, where: state.where, whereIn: state.whereIn }); return q; },
      returning() { return Promise.resolve(Array.from({ length: table === 'triage_items' ? openCards : 1 }, (_, i) => ({ id: `card-${i}` }))); },
      insert(row) { writes.inserts.push({ table, row }); return Promise.resolve([{ id: 'act-1' }]); },
      first() {
        if (table === 'call_log') return Promise.resolve(owned ? { id: CALL_ID } : undefined);
        if (table === 'activity_log') return Promise.resolve(prior);
        if (table === 'customers') return Promise.resolve(cust);
        if (table === 'triage_items') return Promise.resolve({ n: remaining });
        return Promise.resolve(undefined);
      },
      then(resolve, reject) {
        if (table === 'scheduled_services' && state.updateArg == null) return Promise.resolve(visits).then(resolve, reject);
        if (state.updateArg != null) return Promise.resolve(1).then(resolve, reject);
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return q;
  };
  const conn = (table) => builder(table);
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.transaction = async (fn) => fn(conn);
  conn.writes = writes;
  return conn;
}

describe('applyCallReschedule', () => {
  test('moves the visit through the rebooker, notes the interior request, logs, resolves cards, sends nothing', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn().mockResolvedValue({ success: true }) };
    const result = await applyCallReschedule({ conn, call: call(), customerId: CUSTOMER_ID, v2: v2(), procGeneration: 3, now: NOW, rebooker });

    expect(result).toMatchObject({ outcome: 'applied', visitId: VISIT_ID, newDate: '2026-09-24', newWindow: { start: '12:00', end: '13:00' }, cardsResolved: 1 });
    expect(rebooker.reschedule).toHaveBeenCalledTimes(1);
    const [id, date, win, reason, by, opts] = rebooker.reschedule.mock.calls[0];
    expect([id, date, win, reason, by]).toEqual([VISIT_ID, '2026-09-24', { start: '12:00', end: '13:00' }, RESCHEDULE_REASON_CODE, INITIATED_BY]);
    expect(opts).toMatchObject({ keepStatus: true, seriesPolicy: 'single', expect: { scheduled_date: '2026-09-24', window_start: '09:00:00', window_end: '10:00:00' } });
    expect(reason.length).toBeLessThanOrEqual(30);
    expect(by.length).toBeLessThanOrEqual(20);

    const noteUpdate = conn.writes.updates.find((u) => u.table === 'scheduled_services');
    expect(noteUpdate.arg.internal_notes).toMatch(/^Call 2026-09-08: Caller requested that the interior/);

    const activity = conn.writes.inserts.find((i) => i.table === 'activity_log');
    expect(activity.row.action).toBe(ACTIVITY_ACTION);
    expect(activity.row.customer_id).toBe(CUSTOMER_ID);
    expect(JSON.parse(activity.row.metadata)).toMatchObject({ call_log_id: CALL_ID, scheduled_service_id: VISIT_ID, to: { date: '2026-09-24', start: '12:00', end: '13:00' } });

    const cardUpdate = conn.writes.updates.find((u) => u.table === 'triage_items');
    expect(cardUpdate.arg).toMatchObject({ status: 'resolved', resolution_source: 'auto' });
    expect(cardUpdate.whereIn[0]).toEqual(['reason_code', ['reschedule_or_cancel', 'existing_appointment_coordination']]);
    const reviewSync = conn.writes.updates.find((u) => u.table === 'call_log');
    expect(reviewSync.arg.review_status).toBe('resolved');
    // Nothing customer-facing is touched.
    expect(conn.writes.inserts.map((i) => i.table)).toEqual(['activity_log']);
  });

  test('a date move does not pin seriesPolicy single (owner cadence ruling applies)', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn().mockResolvedValue({ success: true }) };
    await applyCallReschedule({ conn, call: call(), v2: v2({ scheduling: { confirmed_start_at: '2026-09-25T10:00:00-04:00' } }), now: NOW, rebooker });
    expect(rebooker.reschedule.mock.calls[0][5]).not.toHaveProperty('seriesPolicy');
  });

  test('review_status stays open when other cards remain', async () => {
    const conn = makeConn({ remaining: 2 });
    const rebooker = { reschedule: jest.fn().mockResolvedValue({ success: true }) };
    await applyCallReschedule({ conn, call: call(), v2: v2(), now: NOW, rebooker });
    expect(conn.writes.updates.find((u) => u.table === 'call_log').arg.review_status).toBe('open');
  });

  test('superseded pass and already-applied call both stand down before any write', async () => {
    const rebooker = { reschedule: jest.fn() };
    const lost = makeConn({ owned: false });
    expect(await applyCallReschedule({ conn: lost, call: call(), v2: v2(), procGeneration: 2, now: NOW, rebooker })).toEqual({ outcome: 'skipped', reason: 'superseded_by_newer_pass' });
    const dup = makeConn({ prior: { id: 'act-0' } });
    expect(await applyCallReschedule({ conn: dup, call: call(), v2: v2(), now: NOW, rebooker })).toEqual({ outcome: 'skipped', reason: 'already_applied' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(lost.writes.updates).toHaveLength(0);
    expect(dup.writes.updates).toHaveLength(0);
  });

  test('a skip stamps the open card payload with the reason and leaves it open', async () => {
    const conn = makeConn({ visits: [] });
    const rebooker = { reschedule: jest.fn() };
    const result = await applyCallReschedule({ conn, call: call(), v2: v2(), now: NOW, rebooker });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'no_visit_on_books' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    const stamp = conn.writes.updates.find((u) => u.table === 'triage_items');
    expect(stamp.arg.payload.bindings[0]).toMatch(/"skipped":"no_visit_on_books"/);
    expect(stamp.arg).not.toHaveProperty('status');
  });

  test('a non-reschedule call writes nothing at all', async () => {
    const conn = makeConn();
    const result = await applyCallReschedule({ conn, call: call(), v2: v2({ scheduling: { status: 'confirmed' } }), now: NOW, rebooker: { reschedule: jest.fn() } });
    expect(result.reason).toBe('not_a_reschedule');
    expect(conn.writes.updates).toHaveLength(0);
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('already at the requested time: no move, cards resolved as moot', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn() };
    const result = await applyCallReschedule({ conn, call: call(), v2: v2({ scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00' } }), now: NOW, rebooker });
    expect(result).toMatchObject({ outcome: 'noop', reason: 'already_at_requested_time', cardsResolved: 1 });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a rebooker refusal propagates (the processor step logs it non-blocking) and no activity row is written', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn().mockRejectedValue(Object.assign(new Error('slot taken'), { statusCode: 409 })) };
    await expect(applyCallReschedule({ conn, call: call(), v2: v2(), now: NOW, rebooker })).rejects.toThrow('slot taken');
    expect(conn.writes.inserts).toHaveLength(0);
  });
});
