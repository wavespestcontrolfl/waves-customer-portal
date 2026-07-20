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
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');

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
      stop('svc-live', 'en_route'),
      stop('svc-ok', 'confirmed'),
      stop('svc-done', 'completed'),
    ]),
  });
  const updates = [chain(), chain()];
  const logInserts = [chain(), chain()];
  let updateIdx = 0;
  let logIdx = 0;
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      if (listChain.select.mock.calls.length === 0) return listChain;
      return updates[updateIdx++];
    }
    if (table === 'reschedule_log') return logInserts[logIdx++];
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
