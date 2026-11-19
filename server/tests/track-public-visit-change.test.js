const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockEnsureCustomerGeocoded = jest.fn();
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: mockEnsureCustomerGeocoded }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn() }));
const mockNextPlanVisitDate = jest.fn();
jest.mock('../services/visit-skip', () => ({ nextPlanVisitDate: mockNextPlanVisitDate }));
const mockDayOnlyVisit = jest.fn();
jest.mock('../services/time-display', () => ({ dayOnlyVisit: mockDayOnlyVisit }));

const trackPublicRouter = require('../routes/track-public');
const {
  buildVisitChange, handoffReasonCode, autoPlacedDayOnly, trackWindow,
  allowsScheduledRouteTracking, publicTrackState,
} = trackPublicRouter._test;

function installLogs(handoff, latest = handoff) {
  const placementLatest = latest && (
    latest.notes === 'customer_pick'
    || latest.reason_code === 'customer_pick'
    || (latest.new_date != null && latest.new_date !== latest.original_date)
    || (latest.new_window != null && latest.new_window !== (latest.original_window || ''))
  ) ? latest : handoff;
  mockDb.mockImplementation((table) => {
    if (table !== 'reschedule_log') throw new Error(`unexpected table ${table}`);
    let handoffOnly = false;
    const chain = {
      where: jest.fn((arg) => {
        if (typeof arg === 'function') {
          handoffOnly = arg.name === 'customerPickLog';
          arg.call(chain);
        }
        return chain;
      }),
      whereNotNull: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      orWhere: jest.fn((arg) => {
        if (typeof arg === 'function') arg.call(chain);
        return chain;
      }),
      orderBy: jest.fn(() => chain),
      first: jest.fn(async () => (handoffOnly ? handoff : placementLatest)),
    };
    return chain;
  });
}

const rainHandoff = (over = {}) => ({
  original_date: '2026-11-18',
  original_window: '09:00:00-11:00:00',
  new_date: '2026-11-26',
  reason_code: 'weather_rain',
  notes: 'customer_pick',
  created_at: '2026-11-18T15:00:00.000Z',
  ...over,
});

describe('public tracker changed-visit recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockReset();
    mockDayOnlyVisit.mockResolvedValue(false);
  });

  test('a waiting Quick Move names the safe reason and links only to authenticated Schedule', async () => {
    installLogs(rainHandoff());

    const result = await buildVisitChange({
      id: 'visit-1',
      scheduled_date: '2026-11-26',
      window_start: null,
      customer_pick_by: '2026-11-19T22:00:00.000Z',
    }, 'scheduled', new Date('2026-11-18T22:00:00.000Z'));

    expect(result).toEqual({
      kind: 'customer_pick',
      stage: 'awaiting_customer',
      nextActor: 'customer',
      reason: 'Rain interrupted the route for this visit.',
      previous: { date: '2026-11-18', windowStart: '09:00' },
      current: null,
      pickBy: '2026-11-19T22:00:00.000Z',
      deadlinePassed: false,
      action: { kind: 'portal_visits', href: '/?tab=schedule', label: 'Open Visits' },
    });
    expect(JSON.stringify(result)).not.toMatch(/reschedule_token|\/reschedule\//);
  });

  test('a chosen replacement shows the booked date and returns no mutation action', async () => {
    installLogs(rainHandoff(), {
      original_date: '2026-11-26',
      new_date: '2026-11-24',
      new_window: '13:00:00-15:00:00',
      reason_code: 'customer_request',
      initiated_by: 'customer_self_serve',
      created_at: '2026-11-18T16:00:00.000Z',
    });
    // Even if the canonical display verdict would hide an automatic hour,
    // this explicit customer selection must bypass it and keep the slot.
    mockDayOnlyVisit.mockResolvedValue(true);

    const service = {
      id: 'visit-1',
      scheduled_date: '2026-11-24',
      window_start: '13:00:00',
      window_end: '15:00:00',
      customer_pick_by: null,
    };
    const result = await buildVisitChange(service, 'scheduled');
    expect(result).toMatchObject({
      kind: 'customer_pick',
      stage: 'booked',
      nextActor: 'none',
      current: { date: '2026-11-24', windowStart: '13:00' },
      action: null,
    });
    expect(trackWindow(service, result)).toEqual({
      date: null, start: '2026-11-24T13:00:00', end: '2026-11-24T15:00:00',
    });
    expect(mockDayOnlyVisit).not.toHaveBeenCalled();
  });

  test('a day-only Auto-Dispatch replacement hides both tracker fields without its best-effort stamp', async () => {
    installLogs(rainHandoff(), {
      original_date: '2026-11-26',
      new_date: '2026-11-25',
      new_window: '08:00:00-10:00:00',
      reason_code: 'auto_dispatch',
      initiated_by: 'auto_dispatch',
      created_at: '2026-11-20T05:00:00.000Z',
    });
    mockDayOnlyVisit.mockResolvedValue(true);
    const service = {
      id: 'visit-1', scheduled_date: '2026-11-25', window_start: '08:00:00', window_end: '10:00:00',
      customer_pick_by: '2026-11-19T22:00:00.000Z', last_auto_dispatch_at: null,
    };
    const result = await buildVisitChange(service, 'scheduled');
    expect(result).toMatchObject({
      kind: 'customer_pick', stage: 'booked', current: { date: '2026-11-25', windowStart: null }, action: null,
    });
    expect(mockDayOnlyVisit).toHaveBeenCalledWith(mockDb, service);
    expect(trackWindow(service, result, false, true)).toEqual({
      date: '2026-11-25', start: null, end: null,
    });
  });

  test('a failed narrative-log read cannot expose a day-only automatic slot at top level', async () => {
    const service = {
      id: 'visit-1', scheduled_date: '2026-11-25', window_start: '08:00:00', window_end: '10:00:00',
      customer_pick_by: '2026-11-19T22:00:00.000Z', last_auto_dispatch_at: null,
    };
    mockDayOnlyVisit.mockResolvedValue(true);
    mockDb.mockImplementation(() => { throw new Error('reschedule_log unavailable'); });

    const dayOnly = await autoPlacedDayOnly(service);
    const result = await buildVisitChange(service, 'scheduled', new Date(), { dayOnlyAutoPlaced: dayOnly });

    expect(result).toBeNull();
    expect(mockDayOnlyVisit).toHaveBeenCalledWith(mockDb, service);
    expect(trackWindow(service, result, false, dayOnly)).toEqual({
      date: '2026-11-25', start: null, end: null,
    });
  });

  test('a failed history read gives an unplaced visit neutral office recovery instead of booked copy', async () => {
    mockDb.mockImplementation(() => { throw new Error('reschedule_log unavailable'); });
    const service = {
      id: 'visit-1', status: 'confirmed', scheduled_date: '2026-11-26', window_start: null,
      customer_pick_by: '2026-11-20T00:00:00Z',
    };

    await expect(buildVisitChange(service, 'scheduled')).resolves.toEqual({
      kind: 'pending_rebook', nextActor: 'office',
    });
    expect(allowsScheduledRouteTracking(service, 'scheduled')).toBe(false);
  });

  test('route tracking rejects both marked parked shapes but preserves a markerless legacy date-only visit', () => {
    const base = { status: 'confirmed', window_start: null };
    expect(allowsScheduledRouteTracking({
      ...base, customer_pick_by: '2026-11-20T00:00:00Z', recurring_dispatch_due_date: null,
    }, 'scheduled')).toBe(false);
    expect(allowsScheduledRouteTracking({
      ...base, customer_pick_by: null, recurring_dispatch_due_date: '2026-11-20',
    }, 'scheduled')).toBe(false);
    expect(allowsScheduledRouteTracking({
      ...base, customer_pick_by: null, recurring_dispatch_due_date: null,
    }, 'scheduled')).toBe(true);
  });

  test('legacy handoff logs decode safely and an unapproved reason exposes no recovery story', async () => {
    expect(handoffReasonCode({ reason_code: 'customer_pick', notes: 'weather_wind' })).toBe('weather_wind');
    installLogs(rainHandoff({ reason_code: 'internal_staff_note' }));
    const result = await buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-11-26', window_start: null, customer_pick_by: '2026-11-20T00:00:00Z',
    }, 'scheduled');
    expect(result).toEqual({ kind: 'pending_rebook', nextActor: 'office' });
    expect(JSON.stringify(result)).not.toContain('internal_staff_note');
  });

  test('the pilot does not translate or activate unrelated Quick Move reasons', async () => {
    installLogs(rainHandoff({ reason_code: 'weather_wind' }));
    await expect(buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-11-26', window_start: null,
      customer_pick_by: '2026-11-20T00:00:00Z',
    }, 'scheduled')).resolves.toEqual({ kind: 'pending_rebook', nextActor: 'office' });
    expect(mockDb).toHaveBeenCalledTimes(1);
  });

  test('an ordinary scheduled poll stops after finding no rain handoff', async () => {
    installLogs(null);
    await expect(buildVisitChange({ id: 'visit-1' }, 'scheduled')).resolves.toBeNull();
    expect(mockDb).toHaveBeenCalledTimes(1);
  });

  test('an old handoff does not claim a later unrelated staff move was its booking', async () => {
    installLogs(rainHandoff(), {
      original_date: '2026-11-24',
      new_date: '2026-12-02',
      new_window: '10:00:00-12:00:00',
      reason_code: 'admin',
      initiated_by: 'admin',
      created_at: '2026-11-25T16:00:00.000Z',
    });
    await expect(buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-12-02', window_start: '10:00:00', customer_pick_by: null,
    }, 'scheduled')).resolves.toBeNull();
  });

  test('a later audit-only row does not hide a still-waiting customer-pick handoff', async () => {
    installLogs(rainHandoff(), {
      original_date: '2026-11-18', original_window: '09:00:00-11:00:00',
      new_date: null, new_window: null, reason_code: 'customer_noshow',
      initiated_by: 'system', created_at: '2026-11-18T17:00:00.000Z',
    });
    await expect(buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-11-26', window_start: null,
      customer_pick_by: '2026-11-20T00:00:00Z',
    }, 'scheduled')).resolves.toMatchObject({
      kind: 'customer_pick', stage: 'awaiting_customer',
      action: { kind: 'portal_visits', href: '/?tab=schedule' },
    });
  });

  test('a stale handoff marker cannot turn a different parked date into a customer action', async () => {
    installLogs(rainHandoff());
    await expect(buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-12-02', window_start: null,
      customer_pick_by: '2026-11-20T00:00:00Z',
    }, 'scheduled')).resolves.toEqual({ kind: 'pending_rebook', nextActor: 'office' });
  });

  test('a skipped visit returns its next regular plan date and no action', async () => {
    mockNextPlanVisitDate.mockResolvedValue('2026-12-16');
    const service = {
      id: 'visit-1', status: 'skipped', scheduled_date: '2026-11-18', recurring_parent_id: 'root-1',
      service_id: 'pest-1', property_id: 'house-1',
    };
    await expect(buildVisitChange(service, 'cancelled')).resolves.toEqual({
      kind: 'skipped',
      nextActor: 'none',
      nextVisit: { date: '2026-12-16' },
    });
    expect(mockNextPlanVisitDate).toHaveBeenCalledWith(mockDb, service, '2026-11-18', { requireServiceAndProperty: true });
  });

  test.each([
    ['cancelled', 'cancelled'],
    ['no_show', 'missed'],
  ])('%s routes recovery to the office without a picker', async (state, kind) => {
    await expect(buildVisitChange({ id: 'visit-1' }, state)).resolves.toEqual({ kind, nextActor: 'office' });
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('an operational rescheduled row is office-owned and never reads or returns its stale slot', async () => {
    await expect(buildVisitChange({
      id: 'visit-1', status: 'rescheduled', scheduled_date: '2026-11-18', window_start: '09:00:00',
    }, 'scheduled')).resolves.toEqual({ kind: 'pending_rebook', nextActor: 'office' });
    expect(mockDb).not.toHaveBeenCalled();
  });
});

test('the read endpoint clears the old arrival window while the office rebooks', async () => {
  const row = {
    id: 'visit-1', customer_id: 'customer-1', status: 'rescheduled', track_state: 'complete',
    scheduled_date: '2026-11-18', window_start: '09:00:00', window_end: '11:00:00',
  };
  mockDb.raw = jest.fn();
  mockDb.mockImplementation(table => {
    const result = table === 'scheduled_services as s' ? row : null;
    const q = { first: jest.fn(async () => result) };
    for (const method of ['where', 'leftJoin', 'orderBy', 'whereNotNull']) q[method] = jest.fn(() => q);
    return q;
  });
  const endpoint = trackPublicRouter.stack.find(layer => layer.route?.path === '/:token' && layer.route.methods.get);
  const response = { set: jest.fn(), json: jest.fn() };
  await endpoint.route.stack[0].handle({ params: { token: 'a'.repeat(64) } }, response, err => { throw err; });
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
    state: 'scheduled', window: { date: null, start: null, end: null }, vehicle: null, stopsAhead: null,
    visitChange: { kind: 'pending_rebook', nextActor: 'office' }, meta: { pollIntervalSeconds: 0 },
  }));
});

test('an unplaced customer-pick row suppresses stale en-route GPS and polling before geocoding', async () => {
  const row = {
    id: 'visit-1', customer_id: 'customer-1', status: 'confirmed', track_state: 'en_route',
    scheduled_date: '2026-11-26', window_start: null, window_end: null,
    customer_pick_by: '2026-11-20T00:00:00Z', technician_id: null,
  };
  mockDb.raw = jest.fn();
  mockDb.mockImplementation(table => {
    const result = table === 'scheduled_services as s' ? row : null;
    const q = { first: jest.fn(async () => result) };
    for (const method of ['where', 'leftJoin', 'orderBy', 'whereNotNull']) q[method] = jest.fn(() => q);
    return q;
  });
  const endpoint = trackPublicRouter.stack.find(layer => layer.route?.path === '/:token' && layer.route.methods.get);
  const response = { set: jest.fn(), json: jest.fn() };
  await endpoint.route.stack[0].handle({ params: { token: 'a'.repeat(64) } }, response, err => { throw err; });

  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
    state: 'scheduled', vehicle: null, vehicleApprox: null, stopsAhead: null,
    visitChange: { kind: 'pending_rebook', nextActor: 'office' },
    meta: { pollIntervalSeconds: 0 },
  }));
  expect(mockEnsureCustomerGeocoded).not.toHaveBeenCalled();
  expect(publicTrackState({ ...row, status: 'cancelled' })).toBe('cancelled');
});
