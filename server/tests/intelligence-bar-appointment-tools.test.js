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
  sendConfirmation: jest.fn().mockResolvedValue(true),
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

// A dues-billed member (explicit monthly lane with a rate). create_appointment
// sets no price, so its billing gate (ADMIN-BUG-R12) only lets through a
// customer whose billing covers an unpriced visit; the create tests below use
// this profile to keep exercising their own guards. The gate's own cases are
// in the ADMIN-BUG-R12 describe.
const MEMBER_BILLING = { billing_mode: 'monthly_membership', monthly_rate: 89 };

// An UPDATE result that resolves to the row count like knex AND answers
// `.returning([...])` with the committed rows (the reschedule writer reads
// the committed technician_id off the CAS row).
function updateResult(count, rows) {
  const p = Promise.resolve(count);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    returning: jest.fn().mockResolvedValue(
      rows ?? (count ? [{ id: 'svc-1', technician_id: 'tech-1' }] : []),
    ),
  };
}

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    // The always-on advisory occupancy probe (findConflictingVisits) runs on
    // every timed create/move — the base chain answers it with "no conflicts"
    // so a plain chain() can serve as the probe slot in a queue.
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    whereILike: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockImplementation(() => updateResult(1)),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'appt-1' }]),
    ...overrides,
  });
  return builder;
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    // The retired-for-sale catalog lookup (quarterly T&S gate, #4786) and the
    // booking's catalog price read: an empty catalog unless a test queues
    // its own rows.
    if (table === 'services' && !queues.services) {
      return { where() { return this; }, whereIn() { return this; }, select: () => Promise.resolve([]) };
    }
    // The member one-off discount lookup (owner 2026-09-27): no member
    // discount rows unless a test queues its own.
    if (table === 'discounts' && !queues.discounts) {
      return { where() { return this; }, orderBy() { return this; }, select: () => Promise.resolve([]) };
    }
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
  // create_appointment's insert rides withCustomerCommsLock (rung 6) — the
  // wrapper opens a transaction and takes the advisory lock before the
  // insert; the stub passes the same queue-backed connection through.
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => db(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    return fn(trx);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
});
// A booking defers its confirmation text past the result (setImmediate), so
// let every test's deferred work finish before the next test clears mocks.
afterEach(async () => { await new Promise((resolve) => setImmediate(resolve)); });

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
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
      scheduled_services: [chain(), insertChain], // leading chain: the always-on advisory probe (clean)
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

  test('registers the durable reminder row with the insert and texts the booking confirmation, as the Schedule screen does (owner 2026-09-27)', async () => {
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
      scheduled_services: [chain(), chain()], // first chain: the always-on advisory probe (clean)
    });

    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
      time_window: '9:00 AM',
    });

    expect(result.success).toBe(true);
    // The Schedule create's own registration: durable row for the 72h/24h
    // cron, the confirmation deferred past the response, the time read from
    // the committed row. A REAL start time was given, so the windows stay armed.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'appt-1', 'cust-1', '2099-01-15T09:00', 'Pest Control', 'admin_ib',
      { sendConfirmation: true, deferConfirmation: true, closeReminderWindows: false, fromCommittedRow: true },
    );
    // ...and the confirmation text goes out after the result is built.
    expect(AppointmentReminders.sendConfirmation).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(AppointmentReminders.sendConfirmation).toHaveBeenCalledWith('appt-1');
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
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
      scheduled_services: [chain()],
    });
    await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
    });
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'appt-1', 'cust-1', '2099-01-15T08:00', 'Pest Control', 'admin_ib',
      { sendConfirmation: true, deferConfirmation: true, closeReminderWindows: true, fromCommittedRow: true },
    );
  });

  test('a reminder-registration failure never fails the already-committed create', async () => {
    AppointmentReminders.registerAppointment.mockRejectedValueOnce(new Error('reminders down'));
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
      scheduled_services: [chain()],
    });
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
    });
    expect(result).toMatchObject({ success: true, appointment_id: 'appt-1' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('reminder registration failed'));
    // No reminder row → no confirmation is attempted.
    await new Promise((resolve) => setImmediate(resolve));
    expect(AppointmentReminders.sendConfirmation).not.toHaveBeenCalled();
  });

  test('success log carries ids only — never the customer name (no-PII-in-logs rule)', async () => {
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
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
        customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
        scheduled_services: [chain(), insertChain], // leading chain: the always-on advisory probe (clean)
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
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
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
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
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
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
      scheduled_services: [chain(), insertChain], // leading chain: the always-on advisory probe (clean)
    });

    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: TODAY_ET, service_type: 'Pest Control',
      time_window: '9:00 AM',
    });

    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ scheduled_date: TODAY_ET, window_start: '09:00' });
  });

  test('an off-hour start is rejected — appointment windows start on the hour (owner rule, r33)', async () => {
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control', time_window: '9:30 AM',
    });
    expect(result.error).toMatch(/on the hour/);
  });

  test('a 23:00 start is rejected before any DB call — the flat-60 end would cross midnight (23:30-style off-hour starts are rejected earlier by the on-the-hour rule)', async () => {
    // The old modulo-24h derivation accepted 23:30 and inserted a wrapped
    // 23:30–00:30 same-day block: a non-positive span invisible to every
    // overlap predicate and nonsense to the elapsed guard.
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control',
      time_window: '11:00 PM',
    });

    expect(result.error).toMatch(/cross midnight/);
    expect(db).not.toHaveBeenCalled();
  });

  test('a 4:00 PM start still derives the flat-60 17:00 end (no midnight rejection)', async () => {
    const insertChain = chain();
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
      scheduled_services: [chain(), insertChain], // leading chain: the always-on advisory probe (clean)
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

describe('create_appointment — shared admin window rules (scheduling/window-rules.js)', () => {
  test('a 7:00 AM start is accepted (no day-start floor) and inserts 07:00-08:00', async () => {
    const insertChain = chain();
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
      scheduled_services: [chain(), insertChain], // leading chain: the always-on advisory probe (clean)
    });
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control', time_window: '7:00 AM',
    });
    expect(result).toMatchObject({ success: true, appointment_id: 'appt-1' });
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ window_start: '07:00', window_end: '08:00' });
  });

  test('an 8:00 PM start (flat-60 end 21:00, past the day end) is refused — no insert', async () => {
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control', time_window: '8:00 PM',
    });
    expect(result.error).toMatch(/end by 20:00/);
    expect(db).not.toHaveBeenCalled();
  });

  test('10:00 AM passes and inserts the normalized 10:00-11:00 window', async () => {
    const insertChain = chain();
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
      scheduled_services: [chain(), insertChain], // leading chain: the always-on advisory probe (clean)
    });
    const result = await executeTool('create_appointment', {
      customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control', time_window: '10:00 AM',
    });
    expect(result).toMatchObject({ success: true, appointment_id: 'appt-1' });
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ window_start: '10:00', window_end: '11:00' });
  });

  test('an overlapping visit BOOKS with an advisory warning (owner ruling 2026-08-25 — never a block)', async () => {
    try {
      const probe = chain({
        whereNotIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([{ id: 'other', scheduled_date: '2099-01-15', window_start: '10:00:00', window_end: '11:00:00', status: 'confirmed' }]),
      });
      const insertChain = chain();
      wireDb({
        customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }),
        chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', first_name: 'Ada', last_name: 'Lovelace', ...MEMBER_BILLING }) }) /* locked liveness re-read inside the booking trx (GH r10 P1) */],
        scheduled_services: [probe, insertChain],
      });
      const result = await executeTool('create_appointment', {
        customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'Pest Control', time_window: '10:00 AM',
      });
      expect(result).toMatchObject({ success: true, appointment_id: 'appt-1' });
      expect(result.warning).toMatch(/2099-01-15/);
      expect(insertChain.insert).toHaveBeenCalled();
    } finally { /* no env to restore — the probe is always on */ }
  });
});

describe('create_appointment — billing gate (ADMIN-BUG-R12)', () => {
  // The executor sets no price. A customer whose billing needs a number ON
  // the visit would get a visit that completes with no invoice, so the
  // booking is refused with the Schedule screen's own billable-amount verdict.
  const customerRow = (billing) => ({ id: 'cust-1', first_name: 'Ada', last_name: 'L', ...billing });
  const book = (serviceType = 'One-Time Pest Control Service') => executeTool('create_appointment', {
    customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: serviceType, time_window: '9:00 AM',
  });
  // Preflight read only: a refused booking never opens the transaction, and
  // no scheduled_services queue exists, so any probe or insert would throw.
  const expectRefusedBeforeAnyLock = (result) => {
    expect(result.error).toMatch(/This visit needs a price/);
    expect(result.error).toMatch(/Nothing was booked/);
    expect(db.transaction).not.toHaveBeenCalled();
  };
  const wireBooking = (preflightRow, lockedRow = preflightRow) => {
    const insertChain = chain();
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue(preflightRow) }),
        chain({ first: jest.fn().mockResolvedValue(lockedRow) })],
      scheduled_services: [chain(), insertChain], // leading chain: the advisory probe (clean)
    });
    return insertChain;
  };

  test('an explicit per-visit customer is refused before any lock or write', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(customerRow({ billing_mode: 'per_visit' })) })] });
    const result = await book();
    expectRefusedBeforeAnyLock(result);
    expect(result.error).toMatch(/propose the booking again with price/);
  });

  test('a one-time customer is refused', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(customerRow({ billing_mode: 'one_time' })) })] });
    expectRefusedBeforeAnyLock(await book());
  });

  test('a lead-shaped row (no billing mode, no tier, no rate) is refused', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(customerRow({})) })] });
    expectRefusedBeforeAnyLock(await book('Waves Assessment'));
  });

  test('a legacy row with a sentinel tier and a rate is refused — completion mints nothing for it', async () => {
    // resolveBillingLane infers per_visit (sentinel tier), and with no
    // create-invoice stamp, no membership tier and no visit price,
    // shouldAutoInvoiceCompletion declines: the monthly_rate is never billed.
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(customerRow({ waveguard_tier: 'One-Time', monthly_rate: 150 })) })] });
    expectRefusedBeforeAnyLock(await book());
  });

  test('annual prepay is refused — an unpriced uncovered visit bills nothing', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(customerRow({ billing_mode: 'annual_prepay', waveguard_tier: 'Gold', monthly_rate: 89 })) })] });
    expectRefusedBeforeAnyLock(await book('Quarterly Pest Control Service'));
  });

  test('an explicit member with no monthly rate is refused', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(customerRow({ billing_mode: 'monthly_membership', monthly_rate: 0 })) })] });
    expectRefusedBeforeAnyLock(await book('Quarterly Pest Control Service'));
  });

  test('per-application with no fee on file is refused, naming the fee remedy', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(customerRow({ billing_mode: 'per_application', per_application_fee: null })) })] });
    const result = await book('Quarterly Pest Control Service');
    expectRefusedBeforeAnyLock(result);
    expect(result.error).toMatch(/or set a per-application fee on the customer profile/);
  });

  test('per-application with a fee on file books (the fee bills the visit)', async () => {
    const insertChain = wireBooking(customerRow({ billing_mode: 'per_application', per_application_fee: 95 }));
    const result = await book('Quarterly Pest Control Service');
    expect(result).toMatchObject({ success: true, appointment_id: 'appt-1' });
    expect(insertChain.insert).toHaveBeenCalledTimes(1);
  });

  test('an inferred member (real tier + rate, no billing mode) books', async () => {
    const insertChain = wireBooking(customerRow({ waveguard_tier: 'Gold', monthly_rate: 89 }));
    const result = await book('Quarterly Pest Control Service');
    expect(result.success).toBe(true);
    expect(insertChain.insert).toHaveBeenCalledTimes(1);
  });

  test('free-by-design visit types book for a per-visit customer', async () => {
    for (const serviceType of ['Pest Control Re-Service', 'Waves Pest Control Appointment Service']) {
      jest.clearAllMocks();
      const insertChain = wireBooking(customerRow({ billing_mode: 'per_visit' }));
      const result = await book(serviceType);
      expect(result.success).toBe(true);
      expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ service_type: serviceType });
    }
  });

  test('a billing change committed after the preflight is refused on the LOCKED row, before the insert', async () => {
    // Preflight reads a member; by the time the booking transaction locks the
    // customer row, the lane is per_visit. The locked verdict governs.
    const insertChain = wireBooking(
      customerRow({ billing_mode: 'monthly_membership', monthly_rate: 89 }),
      customerRow({ billing_mode: 'per_visit', monthly_rate: 89 }),
    );
    const result = await book();
    expect(result.error).toMatch(/This visit needs a price/);
    expect(result.preview_changed).toBe(true);
    expect(insertChain.insert).not.toHaveBeenCalled();
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });
});

describe('create_appointment — the visit carries a price like a Schedule-screen booking (owner 2026-09-27)', () => {
  const ONE_TIME_PEST = {
    id: 'svc-otp', name: 'One-Time Pest Control Service', short_name: null,
    service_key: 'one_time_pest_control', base_price: '250.00', category: 'pest',
  };
  const TERMITE_LIQUID = {
    id: 'svc-tl', name: 'Termite Liquid Treatment Service', short_name: null,
    service_key: 'termite_liquid', base_price: null, category: 'termite',
  };
  const PER_VISIT = { id: 'cust-1', first_name: 'Ada', last_name: 'L', billing_mode: 'per_visit' };
  const catalog = (rows) => chain({ select: jest.fn().mockResolvedValue(rows) });
  // Preflight + locked reads of the customer and the catalog; the insert
  // echoes its price back so the result can report it.
  const wirePriced = ({ customer = PER_VISIT, lockedCustomer = customer, rows, lockedRows = rows }) => {
    const insertChain = chain();
    insertChain.returning.mockImplementation(async () => [{ id: 'appt-1', ...insertChain.insert.mock.calls[0][0] }]);
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue(customer) }), chain({ first: jest.fn().mockResolvedValue(lockedCustomer) })],
      services: [catalog(rows), catalog(lockedRows)],
      scheduled_services: [chain(), insertChain], // leading chain: the advisory probe (clean)
    });
    return insertChain;
  };
  const book = (extra = {}) => executeTool('create_appointment', {
    customer_id: 'cust-1', scheduled_date: '2099-01-15', service_type: 'One-Time Pest Control Service', time_window: '9:00 AM', ...extra,
  });

  test('with no stated price, the catalog price the Schedule screen pre-fills is stamped, with the catalog link and the create-invoice flag', async () => {
    const insertChain = wirePriced({ rows: [ONE_TIME_PEST] });
    const result = await book({ _booking_price: 250, _booking_service_id: 'svc-otp' });
    expect(result).toMatchObject({ success: true, appointment_id: 'appt-1', price: 250 });
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({
      estimated_price: 250,
      primary_line_price: 250,
      create_invoice_on_complete: true,
      service_id: 'svc-otp',
      service_key_snapshot: 'one_time_pest_control',
      service_category_snapshot: 'pest',
    });
  });

  test('the catalog default is the Schedule modal\'s pre-fill: the price range minimum, not the base price', async () => {
    // CreateAppointmentModal addServiceFromCatalog pre-fills
    // price_range_min ?? base_price — a $125-minimum / $175-base service
    // books at $125 on the Schedule screen, so it must here too.
    const ranged = { ...ONE_TIME_PEST, id: 'svc-ranged', price_range_min: '125.00', base_price: '175.00' };
    const insertChain = wirePriced({ rows: [ranged] });
    const result = await book({ _booking_price: 125, _booking_service_id: 'svc-ranged' });
    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ estimated_price: 125, primary_line_price: 125, service_id: 'svc-ranged' });
  });

  test('a shared short name never picks a catalog row: the booking is refused with the candidates, nothing written', async () => {
    // The live catalog shares "Lawn Care" across five services (recurring
    // and one-time) — a first match would price and bill the wrong one.
    const lawn = [
      { id: 'svc-lq', name: 'Quarterly Lawn Care Service', short_name: 'Lawn Care', service_key: 'lawn_care_quarterly', base_price: null, category: 'lawn', billing_type: 'recurring' },
      { id: 'svc-lo', name: 'One-Time Lawn Care Service', short_name: 'Lawn Care', service_key: 'lawn_care_one_time', base_price: '95.00', category: 'lawn', billing_type: 'one_time' },
    ];
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(PER_VISIT) })], services: [catalog(lawn)] });
    const result = await book({ service_type: 'Lawn Care' });
    expect(result.error).toMatch(/names several catalog services \(Quarterly Lawn Care Service, One-Time Lawn Care Service\)/);
    expect(db.transaction).not.toHaveBeenCalled();
    // The exact name still resolves its one row.
    const insertChain = wirePriced({ rows: lawn });
    const ok = await book({ service_type: 'One-Time Lawn Care Service', _booking_price: 95, _booking_service_id: 'svc-lo' });
    expect(ok.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ estimated_price: 95, service_id: 'svc-lo' });
  });

  test('a dues-billed member\'s plan service carries no catalog default — dues cover it, as on the Schedule screen', async () => {
    const foam = {
      id: 'svc-foam', name: 'Recurring Termite Foam Service', short_name: null, service_key: 'foam_recurring',
      price_range_min: '146.00', base_price: '164.00', category: 'termite', billing_type: 'recurring',
    };
    const insertChain = wirePriced({ customer: { ...PER_VISIT, ...MEMBER_BILLING }, rows: [foam] });
    const result = await book({ service_type: foam.name, _booking_price: null, _booking_service_id: 'svc-foam' });
    expect(result.success).toBe(true);
    const payload = insertChain.insert.mock.calls[0][0];
    expect(payload).toMatchObject({ service_id: 'svc-foam' });
    expect(payload).not.toHaveProperty('estimated_price');
    expect(payload).not.toHaveProperty('create_invoice_on_complete');
  });

  test('the same plan service for a per-visit customer carries the catalog default, and a member\'s stated price still stands', async () => {
    const foam = {
      id: 'svc-foam', name: 'Recurring Termite Foam Service', short_name: null, service_key: 'foam_recurring',
      price_range_min: '146.00', base_price: '164.00', category: 'termite', billing_type: 'recurring',
    };
    let insertChain = wirePriced({ rows: [foam] });
    let result = await book({ service_type: foam.name, _booking_price: 146, _booking_service_id: 'svc-foam' });
    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ estimated_price: 146, create_invoice_on_complete: true });
    jest.clearAllMocks();
    insertChain = wirePriced({ customer: { ...PER_VISIT, ...MEMBER_BILLING }, rows: [foam] });
    result = await book({ service_type: foam.name, price: 200, _booking_price: 200, _booking_service_id: 'svc-foam' });
    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ estimated_price: 200, create_invoice_on_complete: true });
  });

  test('a stated price wins over the catalog price', async () => {
    const insertChain = wirePriced({ rows: [ONE_TIME_PEST] });
    const result = await book({ price: 180, _booking_price: 180, _booking_service_id: 'svc-otp' });
    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ estimated_price: 180, primary_line_price: 180, service_id: 'svc-otp' });
  });

  test('a stated price books a service the catalog has no price for — the case that used to be refused', async () => {
    const insertChain = wirePriced({ rows: [TERMITE_LIQUID] });
    const result = await book({ service_type: 'Termite Liquid Treatment Service', price: 1200, _booking_price: 1200, _booking_service_id: 'svc-tl' });
    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0]).toMatchObject({ estimated_price: 1200, create_invoice_on_complete: true, service_id: 'svc-tl' });
  });

  describe('a member\'s one-off carries the WaveGuard member discount (owner 2026-09-27: "members or recurring customers get 15% off")', () => {
    const MEMBER = { ...PER_VISIT, ...MEMBER_BILLING, waveguard_tier: 'Gold', active: true };
    const GENERIC = {
      id: 'disc-member', discount_key: 'waveguard_member', name: 'WaveGuard Member Discount', discount_type: 'percentage',
      amount: '15.00', requires_waveguard_tier: 'Bronze', service_key_filter: null, is_active: true, show_in_invoices: true, max_discount_dollars: null,
    };
    const WDO_FREE = {
      id: 'disc-wdo', discount_key: 'waveguard_member_wdo', name: 'WaveGuard Member Discount (Termite Inspection)', discount_type: 'percentage',
      amount: '100.00', requires_waveguard_tier: 'Bronze', service_key_filter: 'wdo_inspection', is_active: true, show_in_invoices: true, max_discount_dollars: null,
    };
    // Preflight + locked reads: the member-row list, then the builder's own
    // load of the picked row (resolveLineDiscount → loadInvoiceDiscount).
    const listing = (rows) => chain({ orderBy: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue(rows) });
    const discountsQueue = (listed, picked) => [
      listing(listed), chain({ first: jest.fn().mockResolvedValue(picked) }),
      listing(listed), chain({ first: jest.fn().mockResolvedValue(picked) }),
    ];
    const LINE_DISCOUNT_COLS = {
      line_discount_id: {}, line_discount_name: {}, line_discount_type: {}, line_discount_amount: {}, line_discount_dollars: {},
    };
    const wireMember = ({ rows, listed, picked, customer = MEMBER }) => {
      const insertChain = chain();
      insertChain.returning.mockImplementation(async () => [{ id: 'appt-1', ...insertChain.insert.mock.calls[0][0] }]);
      wireDb({
        customers: [chain({ first: jest.fn().mockResolvedValue(customer) }), chain({ first: jest.fn().mockResolvedValue(customer) })],
        services: [catalog(rows), catalog(rows)],
        discounts: discountsQueue(listed, picked),
        // probe, the stamp helper's column read, then the insert
        scheduled_services: [chain(), chain({ columnInfo: jest.fn().mockResolvedValue(LINE_DISCOUNT_COLS) }), insertChain],
      });
      return insertChain;
    };

    test('15% off the catalog price, stamped as the line discount the Schedule create writes', async () => {
      const insertChain = wireMember({ rows: [ONE_TIME_PEST], listed: [GENERIC], picked: GENERIC });
      const result = await book({ _booking_price: 212.5, _booking_service_id: 'svc-otp' });
      expect(result).toMatchObject({ success: true, price: 212.5 });
      expect(insertChain.insert.mock.calls[0][0]).toMatchObject({
        estimated_price: 212.5,
        primary_line_price: 250,
        create_invoice_on_complete: true,
        line_discount_id: 'disc-member',
        line_discount_name: 'WaveGuard Member Discount',
        line_discount_type: 'percentage',
        line_discount_amount: 15,
        line_discount_dollars: 37.5,
      });
    });

    test('the catalog\'s own member row wins by priority: a WDO inspection is free for members — a real $0, nothing invoiced', async () => {
      const wdo = { ...ONE_TIME_PEST, id: 'svc-wdo', name: 'WDO Inspection Service', service_key: 'wdo_inspection', base_price: '250.00', category: 'termite' };
      const insertChain = wireMember({ rows: [wdo], listed: [WDO_FREE, GENERIC], picked: WDO_FREE });
      const result = await book({ service_type: 'WDO Inspection Service', _booking_price: 0, _booking_service_id: 'svc-wdo' });
      expect(result.success).toBe(true);
      expect(insertChain.insert.mock.calls[0][0]).toMatchObject({
        estimated_price: 0, primary_line_price: 250, create_invoice_on_complete: false, line_discount_id: 'disc-wdo', line_discount_dollars: 250,
      });
    });

    test('a stated price is the operator\'s own number: no member discount is looked up or applied', async () => {
      const insertChain = wirePriced({ customer: MEMBER, rows: [ONE_TIME_PEST] });
      const result = await book({ price: 180, _booking_price: 180, _booking_service_id: 'svc-otp' });
      expect(result.success).toBe(true);
      const payload = insertChain.insert.mock.calls[0][0];
      expect(payload).toMatchObject({ estimated_price: 180 });
      expect(payload).not.toHaveProperty('line_discount_id');
    });

    test('a non-member gets the list price — the member rows fail the discount engine\'s own eligibility', async () => {
      const insertChain = chain();
      insertChain.returning.mockImplementation(async () => [{ id: 'appt-1', ...insertChain.insert.mock.calls[0][0] }]);
      wireDb({
        customers: [chain({ first: jest.fn().mockResolvedValue(PER_VISIT) }), chain({ first: jest.fn().mockResolvedValue(PER_VISIT) })],
        services: [catalog([ONE_TIME_PEST]), catalog([ONE_TIME_PEST])],
        discounts: [listing([GENERIC]), listing([GENERIC])],
        scheduled_services: [chain(), insertChain],
      });
      const result = await book({ _booking_price: 250, _booking_service_id: 'svc-otp' });
      expect(result.success).toBe(true);
      const payload = insertChain.insert.mock.calls[0][0];
      expect(payload).toMatchObject({ estimated_price: 250 });
      expect(payload).not.toHaveProperty('line_discount_id');
    });
  });

  test('the one-time mosquito default comes from the Schedule screen\'s lot ladder, not the flat catalog price', async () => {
    const mosquito = {
      id: 'svc-mq', name: 'One-Time Mosquito Control Service', short_name: null,
      service_key: 'mosquito_one_time', base_price: '156.00', category: 'mosquito',
    };
    const customer = { ...PER_VISIT, lot_sqft: 43560 };
    const expected = (await require('../routes/admin-schedule').buildAppointmentPricing({
      serviceRecord: mosquito, serviceType: mosquito.name, serviceId: mosquito.id, customer,
    })).finalPrice;
    expect(expected).toBeGreaterThan(0);
    expect(expected).not.toBe(156);
    const insertChain = wirePriced({ customer, rows: [mosquito] });
    const result = await book({ service_type: mosquito.name, _booking_price: expected, _booking_service_id: 'svc-mq' });
    expect(result.success).toBe(true);
    expect(insertChain.insert.mock.calls[0][0].estimated_price).toBe(expected);
  });

  test('a price that differs from the one the card showed is refused before any lock or write', async () => {
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue(PER_VISIT) })],
      services: [catalog([ONE_TIME_PEST])],
    });
    const result = await book({ _booking_price: 200, _booking_service_id: 'svc-otp' });
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.error).toMatch(/price or catalog service changed since the card was shown/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a priced booking with no card pin is refused — no card ever showed that price', async () => {
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue(PER_VISIT) })],
      services: [catalog([ONE_TIME_PEST])],
    });
    const result = await book();
    expect(result).toMatchObject({ preview_changed: true });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a catalog price that changes under the lock is refused, and nothing is inserted', async () => {
    const insertChain = wirePriced({ rows: [ONE_TIME_PEST], lockedRows: [{ ...ONE_TIME_PEST, base_price: '275.00' }] });
    const result = await book({ _booking_price: 250, _booking_service_id: 'svc-otp' });
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.error).toMatch(/price or catalog service changed since the card was shown/);
    expect(insertChain.insert).not.toHaveBeenCalled();
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });

  test('a free visit type never carries a price: a stated one is refused', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(PER_VISIT) })] });
    const result = await book({ service_type: 'Pest Control Re-Service', price: 99 });
    expect(result.error).toMatch(/free visit type/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a stated price needs a real catalog service — an invented service type is refused, nothing written', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(PER_VISIT) })], services: [catalog([ONE_TIME_PEST])] });
    const result = await book({ service_type: 'Spider web sweep', price: 150, _booking_price: 150, _booking_service_id: null });
    expect(result.error).toMatch(/is not a catalog service/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a catalog row only matches the service the operator named — no partial match prices a different service', async () => {
    wireDb({ customers: [chain({ first: jest.fn().mockResolvedValue(PER_VISIT) })], services: [catalog([ONE_TIME_PEST])] });
    const result = await book({ service_type: 'Pest Control' });
    expect(result.error).toMatch(/This visit needs a price/);
    expect(db.transaction).not.toHaveBeenCalled();
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
        chain(), // always-on advisory probe (clean)
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
        chain(), // always-on advisory probe (clean)
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
        chain(), // always-on advisory probe (clean)
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
        chain(), // always-on advisory probe (clean)
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
        chain(), // always-on advisory probe (clean)
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

  test('a 23:00 start is rejected — the preserved 60-min duration would cross midnight; nothing moves', async () => {
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
      appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '11:00 PM',
    });

    expect(result.error).toMatch(/cross midnight/);
    expect(updateChain.update).not.toHaveBeenCalled();
  });

  test('a 4:00 PM start on a 60-min visit still derives the 17:00 end and moves normally', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        chain(), // always-on advisory probe (clean)
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
    const updateChain = chain({ update: jest.fn().mockImplementation(() => updateResult(0)) });
    wireDb({
      scheduled_services: [
        chain({ first: jest.fn().mockResolvedValue(baseAppt) }),
        chain(), // always-on advisory probe (clean)
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
      scheduled_date: '2026-07-01', window_start: '09:00:00', window_end: '10:00:00', visit_id: null,
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
      scheduled_date: '2026-07-01', window_start: null, window_end: null, visit_id: null,
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
        chain(), // always-on advisory probe (clean)
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

describe('reschedule_appointment — shared admin window rules', () => {
  const appt = {
    id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2026-07-01',
    window_start: '09:00:00', window_end: '10:00:00', notes: null, service_type: 'Pest Control',
  };

  test('a 7:00 AM new start is accepted (no day-start floor) — updated to 07:00-08:00', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(appt) }), chain(), updateChain], // middle chain: advisory probe (clean)
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    const result = await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '7:00 AM' });
    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(updateChain.update.mock.calls[0][0]).toMatchObject({ window_start: '07:00', window_end: '08:00' });
  });

  test('an 8:00 PM new start on a 60-min visit (end 21:00) is refused — nothing updated', async () => {
    const updateChain = chain();
    wireDb({ scheduled_services: [chain({ first: jest.fn().mockResolvedValue(appt) }), updateChain] });
    const result = await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '8:00 PM' });
    expect(result.error).toMatch(/end by 20:00/);
    expect(updateChain.update).not.toHaveBeenCalled();
  });

  test('a date-only move validates the STORED window against the day END only (a 07:00 row moves; a 19:00 end-less 120-min row is refused)', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...appt, window_start: '07:00:00', window_end: '08:00:00' }) }), chain(), updateChain],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'L' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    let result = await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15' });
    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(updateChain.update).toHaveBeenCalled();
    wireDb({ scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...appt, window_start: '19:00:00', window_end: null, estimated_duration_minutes: 120 }) }), chain()] });
    result = await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15' });
    expect(result.error).toMatch(/end by 20:00/);
  });
});

describe('reschedule_appointment — always-on advisory slot-overlap probe', () => {
  // The move used to be a bare non-transactional CAS update, so the gated
  // occupancy guard could not fence it and the IB could park a visit on an
  // occupied slot. The update now runs inside db.transaction with rung 1
  // (date lock + tech-blind probe) taken first, like the create path.
  const appt = {
    id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2026-07-01',
    window_start: '09:00:00', window_end: '10:00:00', notes: null, service_type: 'Pest Control',
  };
  const probeHit = () => chain({
    whereNotIn: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([{ id: 'other', scheduled_date: '2099-01-15', window_start: '10:00:00', window_end: '11:00:00', status: 'confirmed' }]),
  });


  test('gate ON: an overlapping visit MOVES with an advisory warning (owner ruling 2026-08-25 — never a block)', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(appt) }), probeHit(), updateChain],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'Lovelace' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '10:00 AM',
    });
    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(result.warning).toMatch(/2099-01-15/);
    expect(updateChain.update).toHaveBeenCalled();
  });

  test('gate ON: a clear slot moves normally and the probe excludes the moving visit', async () => {
    const updateChain = chain();
    const probeMiss = chain({ whereNotIn: jest.fn().mockReturnThis(), orderBy: jest.fn().mockResolvedValue([]) });
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(appt) }), probeMiss, updateChain],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'Lovelace' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '10:00 AM',
    });
    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(updateChain.update).toHaveBeenCalled();
    // The moving row must not conflict with itself.
    expect(probeMiss.whereNotIn).toHaveBeenCalledWith('id', ['svc-1']);
  });

  test('the probe always runs (no gate): a clean slot moves with no warning key', async () => {
    const updateChain = chain();
    const probe = chain();
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(appt) }), probe, updateChain],
      customers: [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'Lovelace' }) })],
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    const result = await executeTool('reschedule_appointment', {
      appointment_id: 'svc-1', new_date: '2099-01-15', new_time_window: '10:00 AM',
    });
    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(result.warning).toBeUndefined();
    expect(probe.orderBy).toHaveBeenCalled();
    expect(updateChain.update).toHaveBeenCalled();
  });
});

describe('reschedule_appointment — end-less rows: probe the DERIVED block, CAS the duration it came from', () => {
  // A row with a start and a NULL end still occupies start +
  // estimated_duration_minutes. Keying the overlap probe off the PERSISTED
  // end skipped the check entirely on those rows (gate on, occupied
  // destination, no refusal) — the probe now uses the validator's derived
  // pair while the persisted end stays null.
  const nullEndAppt = {
    id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2026-07-01',
    window_start: '09:00:00', window_end: null, estimated_duration_minutes: 60,
    notes: null, service_type: 'Pest Control',
  };
  const customersQ = () => [chain({ first: jest.fn().mockResolvedValue({ first_name: 'Ada', last_name: 'Lovelace' }) })];


  test('gate ON: a DATE-ONLY move of a null-end row onto an occupied slot still PROBES (derived block) and moves with a warning', async () => {
    const updateChain = chain();
    const probeHit = chain({
      whereNotIn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockResolvedValue([{ id: 'other', scheduled_date: '2099-01-15', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed' }]),
    });
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(nullEndAppt) }), probeHit, updateChain],
      customers: customersQ(),
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    const result = await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15' });
    expect(result).toMatchObject({ success: true });
    expect(result.warning).toMatch(/2099-01-15/);
    expect(updateChain.update).toHaveBeenCalled();
  });

  test('gate ON: the probed block is the DERIVED 09:00-10:00 span, and the persisted end stays null', async () => {
    const updateChain = chain();
    const probeMiss = chain({ whereNotIn: jest.fn().mockReturnThis(), orderBy: jest.fn().mockResolvedValue([]) });
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(nullEndAppt) }), probeMiss, updateChain],
      customers: customersQ(),
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    const result = await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15' });
    expect(result).toMatchObject({ success: true });
    // The derived span went to the probe (whereRaw bindings carry the block)…
    const rawBindings = probeMiss.whereRaw.mock.calls.map((c) => c[1]).filter(Boolean).flat();
    expect(rawBindings).toEqual(expect.arrayContaining(['10:00', '09:00']));
    // …but the row keeps its null end (the derivation is probe-only).
    expect(updateChain.update.mock.calls[0][0]).toMatchObject({ window_start: '09:00:00', window_end: null });
  });

  test('the duration the derivation used is in the CAS: a concurrent duration edit makes the write miss', async () => {
    // Zero rows matched = the row changed under us (here: its duration, so
    // the block this move computed is stale) → the tool's retry error.
    const updateChain = chain({ update: jest.fn().mockImplementation(() => updateResult(0)) });
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(nullEndAppt) }), chain(), updateChain],
      customers: customersQ(),
    });
    const result = await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15' });
    expect(result.error).toMatch(/changed concurrently/);
    const casObject = updateChain.where.mock.calls.map((c) => c[0]).find((a) => a && typeof a === 'object' && 'scheduled_date' in a);
    expect(casObject).toMatchObject({
      scheduled_date: '2026-07-01', window_start: '09:00:00', window_end: null,
      estimated_duration_minutes: 60,
    });
  });

  test('unchanged duration → the move lands normally', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue(nullEndAppt) }), chain(), updateChain],
      customers: customersQ(),
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    const result = await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15' });
    expect(result).toMatchObject({ success: true, new_date: '2099-01-15' });
    expect(updateChain.update).toHaveBeenCalled();
  });

  test('a row with a real stored span does NOT pin the duration column (it never read it)', async () => {
    const updateChain = chain();
    wireDb({
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ ...nullEndAppt, window_end: '10:00:00' }) }), chain(), updateChain],
      customers: customersQ(),
      reschedule_log: [chain({ insert: jest.fn().mockResolvedValue() })],
    });
    await executeTool('reschedule_appointment', { appointment_id: 'svc-1', new_date: '2099-01-15' });
    const casObject = updateChain.where.mock.calls.map((c) => c[0]).find((a) => a && typeof a === 'object' && 'scheduled_date' in a);
    expect(casObject).not.toHaveProperty('estimated_duration_minutes');
  });
});
