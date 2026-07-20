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
 *     and the rebooker's LIVE_LIFECYCLE_RESET on en_route/on_site rows
 *   - create registers the durable reminder row (registration only, no SMS)
 *     like the canonical admin create path, and logs ids only (no PII)
 *   - live moves carry the rebooker-parity side effects
 *     (applyLiveMoveSideEffects): job_status_history append, tech_status
 *     release, customer tracker refresh
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));
const mockIoEmit = jest.fn();
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: mockIoEmit })) })),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue({ id: 'rem-1' }),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { clearTechCurrentJob } = require('../services/tech-status');
const AppointmentReminders = require('../services/appointment-reminders');
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

  test('registers the durable reminder row with the insert — registration only, no confirmation SMS', async () => {
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace' }) })],
      scheduled_services: [chain()],
    });

    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
      time_window: '9:00 AM',
    });

    expect(result.success).toBe(true);
    // Canonical admin-create semantics: durable row for the 72h/24h cron,
    // sendConfirmation:false so NO SMS goes out (sends stay operator-initiated).
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'appt-1', 'cust-1', '2099-01-15T09:00', 'Pest Control', 'admin_ib',
      { sendConfirmation: false },
    );
  });

  test('windowless create registers the reminder at the 08:00 default (canonical admin convention)', async () => {
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L' }) })],
      scheduled_services: [chain()],
    });
    await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
    });
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'appt-1', 'cust-1', '2099-01-15T08:00', 'Pest Control', 'admin_ib',
      { sendConfirmation: false },
    );
  });

  test('a reminder-registration failure never fails the already-committed create', async () => {
    AppointmentReminders.registerAppointment.mockRejectedValueOnce(new Error('reminders down'));
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L' }) })],
      scheduled_services: [chain()],
    });
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
    });
    expect(result).toMatchObject({ success: true, appointment_id: 'appt-1' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('reminder registration failed'));
  });

  test('success log carries ids only — never the customer name (no-PII-in-logs rule)', async () => {
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace' }) })],
      scheduled_services: [chain()],
    });
    await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
    });
    const logged = logger.info.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes('appt-1') && line.includes('cust-1'))).toBe(true);
    for (const line of logged) {
      expect(line).not.toMatch(/Ada|Lovelace/);
    }
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
    // Start moved 09:00→10:00; the 60-min window length is preserved, so the
    // new end is 11:00 — not the stale stored 10:00 that would collapse it.
    expect(payload).toMatchObject({ scheduled_date: '2099-01-15', window_start: '10:00', window_end: '11:00' });
    expect(payload.track_token_expires_at).toMatchObject({ bindings: ['2099-01-15', '11:00'] });
    // Non-live row: no lifecycle rewind fields, no status flip.
    expect(payload).not.toHaveProperty('track_state');
    expect(payload).not.toHaveProperty('status');

    expect(logChain.insert.mock.calls[0][0]).toMatchObject({
      scheduled_service_id: 'svc-1',
      customer_id: 'cust-1',
      original_date: '2026-07-01',
      new_date: '2099-01-15',
      reason_code: 'admin',
      initiated_by: 'admin_ib',
      notes: 'customer asked',
    });

    // Non-live move: no rebooker live-move side effects fire (no history
    // queue is wired either — an unexpected insert would throw above).
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  test('an en_route row gets the rebooker LIVE_LIFECYCLE_RESET applied AND is flipped to confirmed', async () => {
    const updateChain = chain();
    const historyChain = chain({ insert: jest.fn().mockResolvedValue() });
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue({ ...baseAppt, status: 'en_route', technician_id: 'tech-1' }) }),
        updateChain,
      ],
      job_status_history: [historyChain],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15',
    });

    expect(result.success).toBe(true);
    expect(updateChain.update.mock.calls[0][0]).toMatchObject({
      // Tracker fields rewound...
      track_state: 'scheduled',
      en_route_at: null,
      arrived_at: null,
      actual_start_time: null,
      check_in_time: null,
      track_sms_sent_at: null,
      arrival_sms_sent_at: null,
      // ...and the status is landed back on 'confirmed' in the SAME update,
      // so the moved row is never left en_route/on_site on a future date.
      status: 'confirmed',
    });

    // Rebooker-parity side effects of the live flip: history append…
    expect(historyChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      job_id: 'svc-1',
      from_status: 'en_route',
      to_status: 'confirmed',
    }));
    // …tech_status release…
    expect(clearTechCurrentJob).toHaveBeenCalledWith({
      tech_id: 'tech-1',
      current_job_id: 'svc-1',
      status: 'idle',
    });
    // …and the customer tracker refresh.
    expect(mockIoEmit).toHaveBeenCalledWith('customer:job_update', expect.objectContaining({
      job_id: 'svc-1',
      status: 'confirmed',
    }));
  });

  test('a live-move side-effect failure never fails the already-committed move', async () => {
    const historyChain = chain({ insert: jest.fn().mockRejectedValue(new Error('history table down')) });
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue({ ...baseAppt, status: 'on_site', technician_id: 'tech-1' }) }),
        chain(),
      ],
      job_status_history: [historyChain],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15',
    });
    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('live-move side effects failed'));
  });

  test('a start-only move keeps the original stored window_end when no new time is given', async () => {
    // No new_time_window: window stays 09:00:00–10:00:00, so the token expiry
    // and log must use the original end, not a collapsed/derived one.
    const updateChain = chain();
    const logChain = chain({ insert: jest.fn().mockResolvedValue() });
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [logChain],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15',
    });

    expect(result.success).toBe(true);
    const payload = updateChain.update.mock.calls[0][0];
    expect(payload).toMatchObject({ window_start: '09:00:00', window_end: '10:00:00' });
    expect(payload.track_token_expires_at).toMatchObject({ bindings: ['2099-01-15', '10:00:00'] });
    expect(logChain.insert.mock.calls[0][0]).toMatchObject({ new_window: '09:00:00-10:00:00' });
  });

  test('rejects an impossible calendar date (2099-02-31) with a clear error and never moves the row', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
    });
    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-02-31',
    });
    // Strict round-trip validation: JS Date would normalize this to March 3;
    // it must be refused with the clear tool error, and no UPDATE fires.
    expect(result.error).toMatch(/valid YYYY-MM-DD/);
    expect(updateChain.update).not.toHaveBeenCalled();
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
