const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn() }));
const mockNextPlanVisitDate = jest.fn();
jest.mock('../services/visit-skip', () => ({ nextPlanVisitDate: mockNextPlanVisitDate }));

const trackPublicRouter = require('../routes/track-public');
const { buildVisitChange, handoffReasonCode } = trackPublicRouter._test;

function installLogs(handoff, latest = handoff) {
  mockDb.mockImplementation((table) => {
    if (table !== 'reschedule_log') throw new Error(`unexpected table ${table}`);
    let handoffOnly = false;
    const chain = {
      where: jest.fn((arg) => {
        if (typeof arg === 'function') {
          handoffOnly = true;
          arg.call(chain);
        }
        return chain;
      }),
      orWhere: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      first: jest.fn(async () => (handoffOnly ? handoff : latest)),
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

    await expect(buildVisitChange({
      id: 'visit-1',
      scheduled_date: '2026-11-24',
      window_start: '13:00:00',
      customer_pick_by: null,
    }, 'scheduled')).resolves.toMatchObject({
      kind: 'customer_pick',
      stage: 'booked',
      nextActor: 'none',
      current: { date: '2026-11-24', windowStart: '13:00' },
      action: null,
    });
  });

  test('an Auto-Dispatch placement is booked only when its latest move resolves this handoff', async () => {
    installLogs(rainHandoff(), {
      original_date: '2026-11-26',
      new_date: '2026-11-25',
      new_window: '08:00:00-10:00:00',
      reason_code: 'auto_dispatch',
      initiated_by: 'auto_dispatch',
      created_at: '2026-11-20T05:00:00.000Z',
    });
    await expect(buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-11-25', window_start: '08:00:00',
      customer_pick_by: '2026-11-19T22:00:00.000Z', last_auto_dispatch_at: '2026-11-20T04:10:00.000Z',
    }, 'scheduled')).resolves.toMatchObject({
      kind: 'customer_pick', stage: 'booked', current: { date: '2026-11-25', windowStart: '08:00' }, action: null,
    });
  });

  test('legacy handoff logs decode safely and an unapproved reason exposes no recovery story', async () => {
    expect(handoffReasonCode({ reason_code: 'customer_pick', notes: 'weather_wind' })).toBe('weather_wind');
    installLogs(rainHandoff({ reason_code: 'internal_staff_note' }));
    const result = await buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-11-26', window_start: null, customer_pick_by: '2026-11-20T00:00:00Z',
    }, 'scheduled');
    expect(result).toBeNull();
    expect(JSON.stringify(result)).not.toContain('internal_staff_note');
  });

  test('the pilot does not translate or activate unrelated Quick Move reasons', async () => {
    installLogs(rainHandoff({ reason_code: 'weather_wind' }));
    await expect(buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-11-26', window_start: null,
      customer_pick_by: '2026-11-20T00:00:00Z',
    }, 'scheduled')).resolves.toBeNull();
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

  test('a stale handoff marker cannot turn a different parked date into a customer action', async () => {
    installLogs(rainHandoff());
    await expect(buildVisitChange({
      id: 'visit-1', scheduled_date: '2026-12-02', window_start: null,
      customer_pick_by: '2026-11-20T00:00:00Z',
    }, 'scheduled')).resolves.toBeNull();
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
    id: 'visit-1', customer_id: 'customer-1', status: 'rescheduled', track_state: 'en_route',
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
    state: 'scheduled', window: { start: null, end: null }, vehicle: null, stopsAhead: null,
    visitChange: { kind: 'pending_rebook', nextActor: 'office' }, meta: { pollIntervalSeconds: 0 },
  }));
});
