/**
 * IB create_appointment / reschedule_appointment guards.
 *
 * create_appointment previously inserted status:'scheduled' — a value the
 * scheduled_services status CHECK constraint rejects — so EVERY confirmed use
 * threw. It also passed the model's raw time_window ("morning") straight into
 * the TIME column (PG cast error) and accepted past/garbage dates. These pin:
 *   - status 'pending' + flat-60 window_end derivation
 *   - date validation (parseable, not past-ET) with a clear tool error
 *   - time_window parsing per the tool's documented contract
 *   - reschedule_appointment: terminal-status + past-date refusal,
 *     reschedule_log audit row (initiated_by 'admin_ib'), track-token refresh,
 *     and the rebooker's LIVE_LIFECYCLE_RESET on en_route/on_site rows.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { executeTool } = require('../services/intelligence-bar/tools');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereILike: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'appt-1' }]),
    ...overrides,
  });
  return builder;
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
});

describe('create_appointment', () => {
  test('rejects a garbage date with a clear tool error before any DB call', async () => {
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: 'next tuesday', service_type: 'Pest Control',
    });
    expect(result.error).toMatch(/valid YYYY-MM-DD/);
    expect(db).not.toHaveBeenCalled();
  });

  test('rejects a past date (ET)', async () => {
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2000-01-01', service_type: 'Pest Control',
    });
    expect(result.error).toMatch(/not in the past/);
    expect(db).not.toHaveBeenCalled();
  });

  test('rejects garbage time_window with a clear tool error instead of a PG cast error', async () => {
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
      time_window: 'whenever works',
    });
    expect(result.error).toMatch(/Unrecognized time_window/);
    expect(db).not.toHaveBeenCalled();
  });

  test('inserts status pending with flat-60 window_end from a 12-hour time', async () => {
    const insertChain = chain();
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace' }) })],
      scheduled_services: [insertChain],
    });

    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
      time_window: '9:00 AM',
    });

    expect(result).toMatchObject({ success: true, appointment_id: 'appt-1', date: '2099-01-15' });
    const payload = insertChain.insert.mock.calls[0][0];
    expect(payload).toMatchObject({
      status: 'pending',
      scheduled_date: '2099-01-15',
      window_start: '09:00',
      window_end: '10:00',
    });
  });

  test('"morning"/"afternoon" map to the documented window starts', async () => {
    for (const [word, start, end] of [['morning', '08:00', '09:00'], ['afternoon', '12:00', '13:00']]) {
      const insertChain = chain();
      wireDb({
        customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L' }) })],
        scheduled_services: [insertChain],
      });
      const result = await executeTool('create_appointment', {
        customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
        time_window: word,
      });
      expect(result.success).toBe(true);
      expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ window_start: start, window_end: end });
    }
  });

  test('no time_window inserts null start/end (still pending)', async () => {
    const insertChain = chain();
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L' }) })],
      scheduled_services: [insertChain],
    });
    await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
    });
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({
      status: 'pending', window_start: null, window_end: null,
    });
  });
});

describe('reschedule_appointment', () => {
  const baseAppt = {
    id: 'svc-1',
    customer_id: 'cust-1',
    status: 'confirmed',
    scheduled_date: '2026-07-01',
    window_start: '09:00:00',
    window_end: '10:00:00',
    notes: null,
    service_type: 'Pest Control',
  };

  test('refuses terminal statuses', async () => {
    for (const status of ['completed', 'cancelled', 'skipped', 'no_show']) {
      wireDb({
        scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...baseAppt, status }) })],
      });
      const result = await executeTool('reschedule_appointment', {
        appointment_id: 'svc-1', new_date: '2099-01-15',
      });
      expect(result.error).toBe(`Cannot reschedule a ${status} appointment`);
    }
  });

  test('refuses a past target date (ET)', async () => {
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(baseAppt) })],
    });
    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2000-01-01',
    });
    expect(result.error).toMatch(/not in the past/);
  });

  test('moves the visit, refreshes the track-token expiry, and writes an admin_ib reschedule_log row', async () => {
    const updateChain = chain();
    const logChain = chain({ insert: jest.fn().mockResolvedValue() });
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'Lovelace' }) })],
      reschedule_log: [logChain],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '10:00', reason: 'customer asked',
    });

    expect(result).toMatchObject({ success: true, new_date: '2099-01-15', old_date: '2026-07-01' });
    const payload = updateChain.update.mock.calls[0][0];
    expect(payload).toMatchObject({ scheduled_date: '2099-01-15', window_start: '10:00' });
    expect(payload.track_token_expires_at).toMatchObject({ bindings: ['2099-01-15', '10:00:00'] });
    // Non-live row: no lifecycle rewind fields.
    expect(payload).not.toHaveProperty('track_state');

    expect(logChain.insert.mock.calls[0][0]).toMatchObject({
      scheduled_service_id: 'svc-1',
      customer_id: 'cust-1',
      original_date: '2026-07-01',
      new_date: '2099-01-15',
      reason_code: 'admin',
      initiated_by: 'admin_ib',
      notes: 'customer asked',
    });
  });

  test('an en_route row gets the rebooker LIVE_LIFECYCLE_RESET applied', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue({ ...baseAppt, status: 'en_route' }) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15',
    });

    expect(result.success).toBe(true);
    expect(updateChain.update.mock.calls[0][0]).toMatchObject({
      track_state: 'scheduled',
      en_route_at: null,
      arrived_at: null,
      actual_start_time: null,
      check_in_time: null,
      track_sms_sent_at: null,
      arrival_sms_sent_at: null,
    });
  });

  test('a failed reschedule_log insert never fails the already-committed move', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockRejectedValue(new Error('log table down')) })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15',
    });
    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
  });
});
