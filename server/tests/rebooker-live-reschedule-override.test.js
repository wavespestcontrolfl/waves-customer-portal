jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));
const mockIoEmit = jest.fn();
const mockIoTo = jest.fn(() => ({ emit: mockIoEmit }));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: mockIoTo })),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { clearTechCurrentJob } = require('../services/tech-status');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

// reschedule() rejects past target dates against the REAL clock, so fixture
// dates must be dynamic — hardcoded ones time-bomb the suite when the
// calendar catches up (this file died on 2026-07-01 for exactly that).
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const BASE = dayOffset(10); // anchor's original date
const TARGET = dayOffset(12); // reschedule target (+2 days)
const SIB1 = dayOffset(17); // weekly sibling 1 (BASE + 7)
const SIB1_SHIFTED = dayOffset(19); // sibling 1 recomputed from the new anchor (TARGET + 7)
const SIB2 = dayOffset(24); // weekly sibling 2 (BASE + 14)
const SIB2_SHIFTED = dayOffset(26); // sibling 2 recomputed (TARGET + 14)

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      // Grouped-where callbacks receive the builder both as `this` AND as
      // the first arg (knex passes the sub-builder as the parameter).
      if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    }),
    orWhere: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(),
    count: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
  });
  return Object.assign(builder, overrides);
}

function rawFactory(label) {
  return jest.fn((sql, bindings) => ({ label, sql, bindings }));
}

function liveService(status) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    scheduled_date: BASE,
    window_start: '09:00:00',
    window_end: '11:00:00',
    status,
  };
}

// Wire db/trx mocks for a full single-job reschedule pass.
function wireRescheduleMocks(service) {
  const serviceLookup = chain({ first: jest.fn().mockResolvedValue(service) });
  const updateQuery = chain({ update: jest.fn().mockResolvedValue(1) });
  const historyInsert = chain();
  const logInsert = chain();
  // Post-commit best-effort shift of a call-created follow-up child.
  const followupShift = chain({ update: jest.fn().mockResolvedValue(0) });
  const logCount = chain({ first: jest.fn().mockResolvedValue({ count: '1' }) });

  const trx = jest.fn((table) => {
    if (table === 'scheduled_services') return updateQuery;
    if (table === 'job_status_history') return historyInsert;
    if (table === 'reschedule_log') return logInsert;
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = rawFactory('trx.raw');
  db.transaction = jest.fn(async (callback) => callback(trx));
  db.fn = { now: jest.fn(() => 'NOW()') };

  const dbQueries = [serviceLookup, followupShift, logCount];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return dbQueries.shift();
    if (table === 'reschedule_log') return dbQueries.shift();
    throw new Error(`Unexpected db table ${table}`);
  });

  return { updateQuery, historyInsert, followupShift };
}

describe('live-status reschedule override (allowLive)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = rawFactory('db.raw');
    db.transaction = undefined;
  });

  test.each(['en_route', 'on_site'])(
    'without allowLive a %s job still 409s',
    async (status) => {
      const serviceLookup = chain({ first: jest.fn().mockResolvedValue(liveService(status)) });
      db.mockImplementation(() => serviceLookup);

      await expect(SmartRebooker.reschedule(
        'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      )).rejects.toMatchObject({
        message: `Cannot reschedule a ${status} job`,
        statusCode: 409,
      });
      expect(db.transaction).toBeUndefined();
    },
  );

  test.each(['en_route', 'on_site'])(
    'with allowLive a %s job reschedules, rewinds the tracker lifecycle, and frees the tech',
    async (status) => {
      const { updateQuery, historyInsert } = wireRescheduleMocks(liveService(status));

      await expect(SmartRebooker.reschedule(
        'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
        { allowLive: true },
      )).resolves.toEqual({
        success: true,
        originalDate: BASE,
        newDate: TARGET,
      });

      // Atomic guard widened to include the live statuses.
      expect(updateQuery.whereIn).toHaveBeenCalledWith(
        'status',
        expect.arrayContaining(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']),
      );

      const payload = updateQuery.update.mock.calls[0][0];
      expect(payload).toMatchObject({
        scheduled_date: TARGET,
        status: 'confirmed',
        track_state: 'scheduled',
        en_route_at: null,
        arrived_at: null,
        actual_start_time: null,
        check_in_time: null,
        track_sms_sent_at: null,
      });

      // Live → confirmed is audited.
      expect(historyInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        job_id: 'svc-1',
        from_status: status,
        to_status: 'confirmed',
      }));

      // tech_status pointer released so the tech goes idle.
      expect(clearTechCurrentJob).toHaveBeenCalledWith({
        tech_id: 'tech-1',
        current_job_id: 'svc-1',
        status: 'idle',
      });

      // Open TrackPage / customer portal gets the post-commit refresh.
      expect(mockIoTo).toHaveBeenCalledWith('customer:cust-1');
      expect(mockIoEmit).toHaveBeenCalledWith('customer:job_update', expect.objectContaining({
        job_id: 'svc-1',
        status: 'confirmed',
        eta: null,
        tech_first_name: null,
      }));
    },
  );

  test('a non-live reschedule does not touch tracker lifecycle or tech_status', async () => {
    const { updateQuery } = wireRescheduleMocks(liveService('confirmed'));

    await SmartRebooker.reschedule(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin',
      { allowLive: true },
    );

    const payload = updateQuery.update.mock.calls[0][0];
    expect(payload).not.toHaveProperty('track_state');
    expect(payload).not.toHaveProperty('track_sms_sent_at');
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  test('a successful reschedule delta-shifts the pending call-created follow-up child', async () => {
    const { followupShift } = wireRescheduleMocks(liveService('confirmed'));

    await expect(SmartRebooker.reschedule(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin',
      { allowLive: true },
    )).resolves.toMatchObject({ success: true });

    // Narrow filter: only the call pipeline's pending, never-confirmed child.
    expect(followupShift.where).toHaveBeenCalledWith({
      parent_service_id: 'svc-1',
      source_action: 'ai_call_pipeline_followup',
      status: 'pending',
      customer_confirmed: false,
    });
    // Delta math runs in SQL off the normalized original/new date strings.
    const payload = followupShift.update.mock.calls[0][0];
    expect(payload.scheduled_date).toMatchObject({
      label: 'db.raw',
      bindings: [TARGET, BASE],
    });
  });

  test('a failed follow-up shift is swallowed — the reschedule still succeeds', async () => {
    const { followupShift } = wireRescheduleMocks(liveService('confirmed'));
    followupShift.update.mockRejectedValue(new Error('boom'));

    await expect(SmartRebooker.reschedule(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'admin',
      { allowLive: true },
    )).resolves.toMatchObject({ success: true });
  });

  test.each(['completed', 'cancelled', 'skipped'])(
    'allowLive never permits rescheduling a %s job',
    async (status) => {
      const serviceLookup = chain({ first: jest.fn().mockResolvedValue(liveService(status)) });
      db.mockImplementation(() => serviceLookup);

      await expect(SmartRebooker.reschedule(
        'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
        { allowLive: true },
      )).rejects.toMatchObject({
        message: `Cannot reschedule a ${status} job`,
        statusCode: 409,
      });
    },
  );

  test('rescheduleSeries on a live job 409s with a single-occurrence hint (strict callers)', async () => {
    const serviceLookup = chain({ first: jest.fn().mockResolvedValue(liveService('on_site')) });
    db.mockImplementation(() => serviceLookup);

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
    )).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('reschedule this appointment only'),
    });
  });

  // Wire db/trx mocks for a series reschedule pass. The anchor doubles as
  // the recurring parent (recurring_parent_id null, weekly pattern).
  function wireSeriesMocks(anchorStatus, siblings) {
    const anchor = {
      ...liveService(anchorStatus),
      recurring_parent_id: null,
      is_recurring: true,
      recurring_pattern: 'weekly',
      recurring_nth: null,
      recurring_weekday: null,
      recurring_interval_days: null,
    };
    const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
    const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
    const updates = siblings.map(() => chain({ update: jest.fn().mockResolvedValue(1) }));
    const historyInsert = chain();
    const logInsert = chain();

    const scheduledQueue = [siblingsQuery, ...updates];
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return scheduledQueue.shift();
      if (table === 'job_status_history') return historyInsert;
      if (table === 'reschedule_log') return logInsert;
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));

    const dbQueries = [anchorLookup, parentLookup];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      throw new Error(`Unexpected db table ${table}`);
    });

    return { updates, historyInsert, logInsert };
  }

  test('rescheduleSeries with allowLive moves the live anchor with a lifecycle rewind and shifts confirmed siblings', async () => {
    const { updates, historyInsert } = wireSeriesMocks('on_site', [
      { id: 'svc-1', status: 'on_site', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00' },
      { id: 'svc-2', status: 'confirmed', scheduled_date: SIB1, window_start: '09:00:00', window_end: '11:00:00' },
    ]);

    const result = await SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      { allowLive: true },
    );

    expect(result.success).toBe(true);
    expect(result.occurrencesRescheduled).toBe(2);

    // Anchor: new date + full tracker rewind back to a fresh confirmed appt.
    const anchorPayload = updates[0].update.mock.calls[0][0];
    expect(anchorPayload).toMatchObject({
      scheduled_date: TARGET,
      status: 'confirmed',
      track_state: 'scheduled',
      en_route_at: null,
      arrived_at: null,
      actual_start_time: null,
      check_in_time: null,
      track_sms_sent_at: null,
    });

    // Sibling: cadence-shifted (weekly from the new anchor), NO rewind fields.
    const siblingPayload = updates[1].update.mock.calls[0][0];
    expect(siblingPayload).toMatchObject({
      scheduled_date: SIB1_SHIFTED,
      status: 'confirmed',
    });
    expect(siblingPayload).not.toHaveProperty('track_state');

    // on_site -> confirmed audited for the anchor only.
    expect(historyInsert.insert).toHaveBeenCalledTimes(1);
    expect(historyInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      job_id: 'svc-1',
      from_status: 'on_site',
      to_status: 'confirmed',
    }));

    // Tech freed + customer tracker refreshed, same as the single path.
    expect(clearTechCurrentJob).toHaveBeenCalledWith({
      tech_id: 'tech-1',
      current_job_id: 'svc-1',
      status: 'idle',
    });
    expect(mockIoTo).toHaveBeenCalledWith('customer:cust-1');
    expect(mockIoEmit).toHaveBeenCalledWith('customer:job_update', expect.objectContaining({
      job_id: 'svc-1',
      status: 'confirmed',
    }));
  });

  test('rescheduleSeries with allowLive still skips a live NON-anchor sibling', async () => {
    const { updates } = wireSeriesMocks('on_site', [
      { id: 'svc-1', status: 'on_site', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00' },
      { id: 'svc-2', status: 'en_route', scheduled_date: SIB1, window_start: '09:00:00', window_end: '11:00:00' },
      { id: 'svc-3', status: 'confirmed', scheduled_date: SIB2, window_start: '09:00:00', window_end: '11:00:00' },
    ]);

    const result = await SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      { allowLive: true },
    );

    // Anchor + svc-3 moved; the live svc-2 left alone (still counted for
    // cadence: svc-3 lands at the +2-week mark, not +1).
    expect(result.occurrencesRescheduled).toBe(2);
    expect(updates[0].update.mock.calls[0][0].scheduled_date).toBe(TARGET);
    expect(updates[1].update.mock.calls[0][0].scheduled_date).toBe(SIB2_SHIFTED);
    expect(updates[2].update).not.toHaveBeenCalled();
  });

  test('rescheduleSeries live anchor is status-guarded — a concurrent completion aborts the whole trx', async () => {
    const { updates, historyInsert } = wireSeriesMocks('on_site', [
      { id: 'svc-1', status: 'on_site', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00' },
      { id: 'svc-2', status: 'confirmed', scheduled_date: SIB1, window_start: '09:00:00', window_end: '11:00:00' },
    ]);
    // Tech completes the job between the sibling SELECT and the UPDATE —
    // the status-guarded write matches 0 rows.
    updates[0].update.mockResolvedValue(0);

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      { allowLive: true },
    )).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('transitioned to a non-reschedulable state concurrently'),
    });

    // Anchor write carried the status guard; nothing after it ran.
    expect(updates[0].where).toHaveBeenCalledWith({ status: 'on_site' });
    expect(updates[1].update).not.toHaveBeenCalled();
    expect(historyInsert.insert).not.toHaveBeenCalled();
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  test('rescheduleSeries aborts when the live anchor vanished from the sibling set (raced to terminal)', async () => {
    // Anchor read as on_site, but completed/cancelled before the in-trx
    // sibling SELECT — the non-terminal filter excludes it. The series
    // must not shift off startIdx 0, and no cleanup may fire.
    const { updates, historyInsert, logInsert } = wireSeriesMocks('on_site', [
      { id: 'svc-2', status: 'confirmed', scheduled_date: SIB1, window_start: '09:00:00', window_end: '11:00:00' },
    ]);

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      { allowLive: true },
    )).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('transitioned to a non-reschedulable state concurrently'),
    });

    expect(updates[0].update).not.toHaveBeenCalled();
    expect(historyInsert.insert).not.toHaveBeenCalled();
    expect(logInsert.insert).not.toHaveBeenCalled();
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  test('rescheduleSeries aborts when the live anchor raced to skipped (present but not movable)', async () => {
    // 'skipped' is non-terminal for cadence math, so the raced anchor IS
    // in the sibling set — but a no-show drop must not be revived to
    // confirmed with a tracker rewind.
    const { updates, historyInsert, logInsert } = wireSeriesMocks('on_site', [
      { id: 'svc-1', status: 'skipped', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00' },
      { id: 'svc-2', status: 'confirmed', scheduled_date: SIB1, window_start: '09:00:00', window_end: '11:00:00' },
    ]);

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      { allowLive: true },
    )).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('transitioned to a non-reschedulable state concurrently'),
    });

    expect(updates[0].update).not.toHaveBeenCalled();
    expect(updates[1].update).not.toHaveBeenCalled();
    expect(historyInsert.insert).not.toHaveBeenCalled();
    expect(logInsert.insert).not.toHaveBeenCalled();
    expect(clearTechCurrentJob).not.toHaveBeenCalled();
    expect(mockIoEmit).not.toHaveBeenCalled();
  });

  test('rescheduleSeries allowLive never permits a terminal anchor', async () => {
    const serviceLookup = chain({ first: jest.fn().mockResolvedValue(liveService('completed')) });
    db.mockImplementation(() => serviceLookup);

    await expect(SmartRebooker.rescheduleSeries(
      'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      { allowLive: true },
    )).rejects.toMatchObject({
      statusCode: 409,
      message: 'Cannot reschedule a completed job',
    });
  });
});
