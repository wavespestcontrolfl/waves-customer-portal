/**
 * IB move_stops_to_day guards.
 *
 * The mover previously accepted any target date and moved ANY row —
 * including completed/cancelled visits (resurrecting them onto a new day)
 * and en_route/on_site rows (carrying stale arrival timestamps onto the new
 * date). These pin:
 *   - past/garbage target-date refusal (ET calendar dates)
 *   - terminal rows are refused and reported (skipped_terminal), never moved
 *   - a reschedule_log audit row per moved stop (initiated_by 'admin_ib')
 *   - the rebooker's LIVE_LIFECYCLE_RESET on en_route/on_site rows
 *   - live moves carry the rebooker-parity side effects
 *     (applyLiveMoveSideEffects): job_status_history append, tech_status
 *     release, customer tracker refresh — non-live moves don't
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
// Partial mock: real ET helpers, but sameDayWindowElapsed is a spy so the
// same-day elapsed-window bucketing is deterministic regardless of the clock.
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  return { ...actual, sameDayWindowElapsed: jest.fn(actual.sameDayWindowElapsed) };
});

const db = require('../models/db');
const { clearTechCurrentJob } = require('../services/tech-status');
const datetimeEt = require('../utils/datetime-et');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

const actualElapsed = jest.requireActual('../utils/datetime-et').sameDayWindowElapsed;
const TODAY_ET = jest.requireActual('../utils/datetime-et').etDateString();

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(),
    ...overrides,
  });
  return builder;
}

function stop(id, status, extra = {}) {
  return {
    id,
    customer_id: `cust-${id}`,
    status,
    first_name: 'Ada',
    last_name: 'Lovelace',
    city: 'Bradenton',
    service_type: 'Pest Control',
    scheduled_date: '2026-05-20',
    window_start: '09:00:00',
    window_end: '10:00:00',
    notes: null,
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  // Default to the real ET comparison so future-date tests resolve to false;
  // the same-day test overrides this with a deterministic keyed impl.
  datetimeEt.sameDayWindowElapsed.mockImplementation(actualElapsed);
});

test('refuses a garbage target date before touching the DB', async () => {
  const result = await executeScheduleTool('move_stops_to_day', {
    service_ids: ['svc-1'], new_date: 'someday', confirmed: true,
  });
  expect(result.error).toMatch(/valid YYYY-MM-DD/);
  expect(db).not.toHaveBeenCalled();
});

test('refuses a past target date (ET)', async () => {
  const result = await executeScheduleTool('move_stops_to_day', {
    service_ids: ['svc-1'], new_date: '2000-01-01', confirmed: true,
  });
  expect(result.error).toMatch(/not in the past/);
  expect(db).not.toHaveBeenCalled();
});

test('refuses an impossible calendar date (2099-02-31) before touching the DB', async () => {
  // A shape-only regex passed 2099-02-31 / 2099-99-99 straight to the DATE
  // update (raw PG cast error). The shared strict validator rejects them.
  for (const bad of ['2099-02-31', '2099-99-99', '2099-13-01']) {
    const result = await executeScheduleTool('move_stops_to_day', {
      service_ids: ['svc-1'], new_date: bad, confirmed: true,
    });
    expect(result.error).toMatch(/valid YYYY-MM-DD/);
  }
  expect(db).not.toHaveBeenCalled();
});

test('all-terminal selection errors instead of resurrecting finished visits', async () => {
  db.mockImplementation(() => chain({
    select: jest.fn().mockResolvedValue([stop('svc-1', 'completed'), stop('svc-2', 'cancelled')]),
  }));
  const result = await executeScheduleTool('move_stops_to_day', {
    service_ids: ['svc-1', 'svc-2'], new_date: '2099-01-15', confirmed: true,
  });
  expect(result.error).toMatch(/terminal status/);
});

test('mixed selection moves only non-terminal rows, reports skipped, logs each move', async () => {
  const listChain = chain({
    select: jest.fn().mockResolvedValue([
      stop('svc-live', 'en_route', { technician_id: 'tech-1' }),
      stop('svc-ok', 'confirmed'),
      stop('svc-done', 'completed'),
    ]),
  });
  const updates = [chain(), chain()];
  const logInserts = [chain(), chain()];
  const historyChain = chain();
  let updateIdx = 0;
  let logIdx = 0;
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      if (listChain.select.mock.calls.length === 0) return listChain;
      return updates[updateIdx++];
    }
    if (table === 'reschedule_log') return logInserts[logIdx++];
    if (table === 'job_status_history') return historyChain;
    throw new Error(`Unexpected db('${table}') call`);
  });

  const result = await executeScheduleTool('move_stops_to_day', {
    service_ids: ['svc-live', 'svc-ok', 'svc-done'],
    new_date: '2099-01-15',
    reason: 'route overload',
    confirmed: true,
  });

  expect(result).toMatchObject({ success: true, moved_count: 2, new_date: '2099-01-15' });
  expect(result.skipped_terminal).toEqual([{ id: 'svc-done', status: 'completed' }]);

  // First update (en_route row) carries the live-lifecycle rewind AND is
  // landed back on 'confirmed' — never left live on a future date.
  expect(updates[0].update.mock.calls[0][0]).toMatchObject({
    scheduled_date: '2099-01-15',
    track_state: 'scheduled',
    en_route_at: null,
    arrived_at: null,
    track_sms_sent_at: null,
    arrival_sms_sent_at: null,
    status: 'confirmed',
  });
  // Second update (confirmed row) does NOT rewind or restamp status.
  expect(updates[1].update.mock.calls[0][0]).not.toHaveProperty('track_state');
  expect(updates[1].update.mock.calls[0][0]).not.toHaveProperty('status');

  // The live stop ALONE carries the rebooker-parity side effects:
  // exactly one history append (en_route → confirmed)…
  expect(historyChain.insert).toHaveBeenCalledTimes(1);
  expect(historyChain.insert).toHaveBeenCalledWith(expect.objectContaining({
    job_id: 'svc-live',
    from_status: 'en_route',
    to_status: 'confirmed',
  }));
  // …one tech_status release…
  expect(clearTechCurrentJob).toHaveBeenCalledTimes(1);
  expect(clearTechCurrentJob).toHaveBeenCalledWith({
    tech_id: 'tech-1',
    current_job_id: 'svc-live',
    status: 'idle',
  });
  // …and one customer tracker refresh.
  expect(mockIoEmit).toHaveBeenCalledTimes(1);
  expect(mockIoEmit).toHaveBeenCalledWith('customer:job_update', expect.objectContaining({
    job_id: 'svc-live',
    status: 'confirmed',
  }));

  // One audit row per moved stop, rebooker conventions.
  expect(logInserts[0].insert.mock.calls[0][0]).toMatchObject({
    scheduled_service_id: 'svc-live',
    customer_id: 'cust-svc-live',
    new_date: '2099-01-15',
    reason_code: 'admin',
    initiated_by: 'admin_ib',
    notes: 'route overload',
  });
  expect(logInserts[1].insert.mock.calls[0][0]).toMatchObject({
    scheduled_service_id: 'svc-ok',
    initiated_by: 'admin_ib',
  });
});

test('a same-day move buckets stops whose window already elapsed (skipped_elapsed) and moves only the rest', async () => {
  // Move TO today: a stop whose window already passed in ET can't be served —
  // it goes to skipped_elapsed, per-stop, while a still-future-window stop
  // moves. Keyed impl: the 08:00 stop is elapsed, the 10:00 stop is not.
  datetimeEt.sameDayWindowElapsed.mockImplementation((dateStr, cutoff) => cutoff === '08:00:00');

  const listChain = chain({
    select: jest.fn().mockResolvedValue([
      stop('svc-late', 'confirmed', { window_end: '08:00:00' }),
      stop('svc-ok', 'confirmed', { window_end: '10:00:00' }),
    ]),
  });
  const updateChain = chain();
  const logChain = chain();
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      if (listChain.select.mock.calls.length === 0) return listChain;
      return updateChain;
    }
    if (table === 'reschedule_log') return logChain;
    throw new Error(`Unexpected db('${table}') call`);
  });

  const result = await executeScheduleTool('move_stops_to_day', {
    service_ids: ['svc-late', 'svc-ok'],
    new_date: TODAY_ET,
    confirmed: true,
  });

  expect(result).toMatchObject({ success: true, moved_count: 1, new_date: TODAY_ET });
  expect(result.stops.map((s) => s.id)).toEqual(['svc-ok']);
  expect(result.skipped_elapsed).toEqual([{ id: 'svc-late', status: 'confirmed' }]);
  // Only the still-serviceable stop was written.
  expect(updateChain.update).toHaveBeenCalledTimes(1);
});

test('a same-day move whose every stop has already elapsed errors and reports them', async () => {
  datetimeEt.sameDayWindowElapsed.mockImplementation((dateStr, cutoff) => cutoff === '08:00:00');
  db.mockImplementation(() => chain({
    select: jest.fn().mockResolvedValue([
      stop('svc-late', 'confirmed', { window_end: '08:00:00' }),
    ]),
  }));

  const result = await executeScheduleTool('move_stops_to_day', {
    service_ids: ['svc-late'], new_date: TODAY_ET, confirmed: true,
  });

  expect(result.error).toMatch(/already passed today/);
  expect(result.skipped_elapsed).toEqual([{ id: 'svc-late', status: 'confirmed' }]);
});

test('proposal (unconfirmed) lists only movable stops and flags the terminal ones', async () => {
  db.mockImplementation(() => chain({
    select: jest.fn().mockResolvedValue([stop('svc-ok', 'pending'), stop('svc-done', 'no_show')]),
  }));
  const result = await executeScheduleTool('move_stops_to_day', {
    service_ids: ['svc-ok', 'svc-done'], new_date: '2099-01-15',
  });
  expect(result.proposal).toBe(true);
  expect(result.stop_count).toBe(1);
  expect(result.stops.map((s) => s.id)).toEqual(['svc-ok']);
  expect(result.skipped_terminal).toEqual([{ id: 'svc-done', status: 'no_show' }]);
});
