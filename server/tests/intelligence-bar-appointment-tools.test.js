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
 *     like the canonical admin create path, and logs ids only (no PII);
 *     a WINDOWLESS create registers at the canonical date+08:00 slot time
 *     but with both reminder windows pre-closed (closeReminderWindows) so
 *     the cron never texts "at 8:00 AM" for a time nobody chose
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
// Partial mock: real ET helpers throughout, but sameDayWindowElapsed is a spy
// so the same-day elapsed-window guard is deterministic regardless of the wall
// clock (existing future-date tests still resolve to false via the real impl).
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  return { ...actual, sameDayWindowElapsed: jest.fn(actual.sameDayWindowElapsed) };
});

const db = require('../models/db');
const logger = require('../services/logger');
const { clearTechCurrentJob } = require('../services/tech-status');
const AppointmentReminders = require('../services/appointment-reminders');
const datetimeEt = require('../utils/datetime-et');
const { executeTool } = require('../services/intelligence-bar/tools');

// Real ET "today" — the date a same-day move targets.
const TODAY_ET = jest.requireActual('../utils/datetime-et').etDateString();

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
    // A REAL start time was given, so the reminder windows stay armed.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'appt-1', 'cust-1', '2099-01-15T09:00', 'Pest Control', 'admin_ib',
      { sendConfirmation: false, closeReminderWindows: false },
    );
  });

  test('windowless create registers at the canonical 08:00 slot time with BOTH reminder windows pre-closed', async () => {
    // The 08:00 appointment_time is the slot convention every reminder writer
    // COALESCEs on (DB sync trigger, self-heal, same-slot dedup) — but the
    // 72h/24h texts render that clock time, so an ARMED windowless row would
    // promise "at 8:00 AM" for a time the operator never chose.
    // closeReminderWindows pre-closes both windows; the sync trigger re-arms
    // them from the real start if a window is set later. (Skipping
    // registration instead would not help — selfHealMissingReminderRows
    // registers any row-less future visit at 08:00 ARMED within 15 minutes.)
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L' }) })],
      scheduled_services: [chain()],
    });
    await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
    });
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'appt-1', 'cust-1', '2099-01-15T08:00', 'Pest Control', 'admin_ib',
      { sendConfirmation: false, closeReminderWindows: true },
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

  test('a today target whose window already elapsed in ET is rejected before the insert', async () => {
    // validScheduleDate accepts today, but a window already past in ET lands
    // the visit where no route can serve it — rejected with a clear tool error,
    // no scheduled_services insert.
    datetimeEt.sameDayWindowElapsed.mockReturnValueOnce(true);
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L' }) })],
      // No scheduled_services queue — an insert would throw Unexpected db().
    });

    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: TODAY_ET, service_type: 'Pest Control',
      time_window: '9:00 AM',
    });

    expect(result.error).toMatch(/already passed today/);
  });

  test('a today target with a still-future window is created normally', async () => {
    datetimeEt.sameDayWindowElapsed.mockReturnValueOnce(false);
    const insertChain = chain();
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L' }) })],
      scheduled_services: [insertChain],
    });

    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: TODAY_ET, service_type: 'Pest Control',
      time_window: '9:00 AM',
    });

    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ scheduled_date: TODAY_ET, window_start: '09:00' });
  });

  test('a 23:30 start is rejected before any DB call — the flat-60 end would cross midnight', async () => {
    // The old modulo-24h derivation accepted 23:30 and inserted a wrapped
    // 23:30–00:30 same-day block: a non-positive span invisible to every
    // overlap predicate and nonsense to the elapsed guard.
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
      time_window: '11:30 PM',
    });

    expect(result.error).toMatch(/cross midnight/);
    expect(db).not.toHaveBeenCalled();
  });

  test('a 4:00 PM start still derives the flat-60 17:00 end (no midnight rejection)', async () => {
    const insertChain = chain();
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L' }) })],
      scheduled_services: [insertChain],
    });

    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
      time_window: '4:00 PM',
    });

    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({
      window_start: '16:00',
      window_end: '17:00',
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

  test('a history-append failure never fails the move AND the post-commit cleanup still runs', async () => {
    // P1-3: the audit-history insert is best-effort for the (non-transactional)
    // IB mover — a failure there must NOT skip the operational cleanup
    // (tech_status release + tracker refresh), or the tech stays pinned to the
    // moved job while the tool reports success.
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
    // Audit failure logged, but the cleanup survived it.
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('live-move history append failed'));
    expect(clearTechCurrentJob).toHaveBeenCalledWith({
      tech_id: 'tech-1', current_job_id: 'svc-1', status: 'idle',
    });
    expect(mockIoEmit).toHaveBeenCalledWith('customer:job_update', expect.objectContaining({
      job_id: 'svc-1', status: 'confirmed',
    }));
  });

  test('a today target whose window already elapsed in ET is rejected before the move', async () => {
    datetimeEt.sameDayWindowElapsed.mockReturnValueOnce(true);
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: TODAY_ET, new_time_window: '9:00 AM',
    });

    expect(result.error).toMatch(/already passed today/);
    expect(updateChain.update).not.toHaveBeenCalled();
  });

  test('a today target with a still-future window moves normally', async () => {
    datetimeEt.sameDayWindowElapsed.mockReturnValueOnce(false);
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: TODAY_ET, new_time_window: '9:00 AM',
    });

    expect(result).toMatchObject({ success: true, new_date: TODAY_ET });
    expect(updateChain.update).toHaveBeenCalled();
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

  test('a 23:30 start is rejected — the preserved 60-min duration would cross midnight; nothing moves', async () => {
    // baseAppt spans 09:00–10:00 (60 min): 23:30 + 60 wraps past midnight.
    // The old modulo-24h derivation would have persisted a 23:30–00:30
    // inverted block. The update chain is queued to prove it is never used.
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '11:30 PM',
    });

    expect(result.error).toMatch(/cross midnight/);
    expect(updateChain.update).not.toHaveBeenCalled();
  });

  test('a 4:00 PM start on a 60-min visit still derives the 17:00 end and moves normally', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '4:00 PM',
    });

    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(updateChain.update.mock.calls[0][0]).toMatchObject({
      window_start: '16:00',
      window_end: '17:00',
    });
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

  test('a concurrent ordinary move (stale date/window snapshot) is refused by the field CAS — the newer move is not clobbered', async () => {
    // Two ordinary moves of the same confirmed row: the second one's snapshot
    // is stale. Status alone matched both, so the later write silently
    // overwrote the newer date/window and logged from the stale snapshot. The
    // CAS now carries the observed scheduled_date + window_start + window_end
    // (the UPDATE always writes window_end from the pre-read — verbatim on a
    // date-only move, via the preserved-duration derivation on a timed one —
    // so a concurrent END-only resize must also make it miss): the stale
    // writer matches zero rows and must not write, log, or fire side effects.
    const updateChain = chain({ update: jest.fn().mockResolvedValue(0) });
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      // No reschedule_log queue — an audit insert for a move that did not
      // happen would throw Unexpected db().
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15',
    });

    expect(result.error).toMatch(/changed concurrently/);
    // The CAS carried the full observed snapshot — status AND the complete
    // schedule triple (date + start + END).
    expect(updateChain.where).toHaveBeenCalledWith('status', 'confirmed');
    expect(updateChain.where).toHaveBeenCalledWith({
      scheduled_date: '2026-07-01', window_start: '09:00:00', window_end: '10:00:00',
    });
    // No side effects for a refused move.
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  test('a windowless visit CASes on null start/end (object-form IS NULL contract) and moves date-only', async () => {
    // A windowless row's observed window fields are null — the object-form
    // predicate renders them as IS NULL (never `= NULL`, which matches
    // nothing), so a date-only move of a windowless visit still commits while
    // a concurrently-windowed copy would miss.
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue({ ...baseAppt, window_start: null, window_end: null }) }),
        updateChain,
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });

    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15',
    });

    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(updateChain.where).toHaveBeenCalledWith({
      scheduled_date: '2026-07-01', window_start: null, window_end: null,
    });
    // The date-only move preserves the (absent) window rather than inventing one.
    expect(updateChain.update.mock.calls[0][0]).toMatchObject({
      scheduled_date: '2099-01-15', window_start: null, window_end: null,
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
