/**
 * Night told-lock on the nightly day re-plan (services/day-replan/index.js, owner 2026-11-05 "D1 a", rewritten by the
 * owner 2026-11-22): two more kinds of stop stay fixed at their hour: customer_time (the customer's own time, by
 * time-promise.dayOnlyEligibility, mocked here; an unreadable answer keeps the stop fixed) and time_told (a known-slot
 * promise, by the no-show detector's promise reader in auto-dispatch/told-visits.js, mocked here; a reminder_72h_sent
 * flag alone is not told). Staff placement, a confirmation and a first or one-time visit no longer fix a stop.
 * Same fake knex as day-replan-runner.test.js, synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/day-replan/planner', () => {
  const actual = jest.requireActual('../services/day-replan/planner');
  return { planDay: jest.fn(actual.planDay), DEFAULT_OPTIONS: actual.DEFAULT_OPTIONS };
});
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false) }));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60 }));
jest.mock('../services/route-reorder', () => ({ _internals: { LIVE_HOLD_SQL: '(live-hold)' }, CUSTOMER_PREMISE_ALIASES: [{ customer_address_line1: 'customers.address_line1' }] }));
jest.mock('../services/auto-dispatch/told-visits', () => ({ loadToldVisitIds: jest.fn() }));
jest.mock('../services/auto-dispatch/preferences', () => ({ getCustomerSchedulingPreferences: jest.fn() }));
jest.mock('../services/time-promise', () => ({ ...jest.requireActual('../services/time-promise'), dayOnlyEligibility: jest.fn() }));

const logger = require('../services/logger');
const { techScopedConfirmActive } = require('../services/scheduling/occupancy');
const { getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
const { dayOnlyEligibility } = require('../services/time-promise');
const { loadToldVisitIds } = require('../services/auto-dispatch/told-visits');
const { runDayReplanIfEnabled, _internals } = require('../services/day-replan');

const NOW = new Date('2026-11-03T12:00:00Z'); // 07:00 ET; DST has ended, ET = UTC-5
const TOMORROW = '2026-11-04';
const TECH = '00000000-0000-4000-8000-000000000001';
const HQ = { lat: 27.4330885, lng: -82.4056801 };

/** A chainable fake knex: reads resolve from `tables`, only inserts into day_replan_plans are expected. */
function fakeConn({ stopsByDate = {}, reminders = [], failReminders = false, blocks = [], notificationPrefs = [], failPrefs = false } = {}) {
  const calls = [];
  const inserts = [];
  const conn = (table) => {
    const state = { table, date: null };
    const chain = new Proxy(state, {
      get(target, prop) {
        if (prop === 'then') {
          return (resolve, reject) => {
            let out = [];
            if (table === 'scheduled_services') out = stopsByDate[target.date] || [];
            if (table === 'tech_schedule_blocks') out = blocks;
            if (table === 'notification_prefs') {
              if (failPrefs) return Promise.reject(new Error('prefs down')).then(resolve, reject);
              out = notificationPrefs;
            }
            if (table === 'appointment_reminders') {
              if (failReminders) return Promise.reject(new Error('reminders down')).then(resolve, reject);
              out = reminders;
            }
            return Promise.resolve(out).then(resolve, reject);
          };
        }
        if (prop === 'insert') {
          return (row) => { inserts.push({ table, row }); calls.push([table, 'insert']); return Promise.resolve([]); };
        }
        return (...args) => {
          calls.push([table, String(prop)]);
          if (prop === 'where' && args[0] === 'scheduled_services.scheduled_date') target.date = args[1];
          return chain;
        };
      },
    });
    return chain;
  };
  conn.raw = (sql) => ({ sql });
  return { conn, calls, inserts };
}

function row(id, lngOffset, hour, extra = {}) {
  return {
    id,
    technician_id: TECH,
    customer_id: `cust-${id}`,
    visit_id: null,
    status: 'confirmed',
    window_start: `${String(hour).padStart(2, '0')}:00:00`,
    window_end: `${String(hour + 1).padStart(2, '0')}:00:00`,
    time_window: null,
    estimated_duration_minutes: 60,
    service_type: 'Quarterly Pest Control Service',
    is_recurring: true,
    is_callback: false,
    auto_dispatch_locked: false,
    auto_dispatch_excluded: false,
    reservation_expires_at: null,
    route_order: null,
    // Each stop is its own property unless a test says otherwise.
    service_address_line1: `${id} Test Ln`,
    service_address_line2: null,
    service_address_city: 'Parrish',
    service_address_zip: '34219',
    customer_address_line1: `${id} Test Ln`,
    customer_city: 'Parrish',
    customer_zip: '34219',
    lat: HQ.lat,
    lng: HQ.lng + lngOffset,
    ...extra,
  };
}

// East of the office: far, near, far, near on slots 8, 9, 10, 11.
function zigzagRows(extra = {}) {
  return [row('a', 0.30, 8, extra.a), row('b', 0.02, 9, extra.b), row('c', 0.31, 10, extra.c), row('d', 0.03, 11, extra.d)];
}


const savedEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_DAY_REPLAN;
  delete process.env.DAY_REPLAN_DAYS_AHEAD;
  delete process.env.GATE_TECH_START_POINTS;
  delete process.env.GATE_AUTO_DISPATCH_DAY_RULES;
  getCustomerSchedulingPreferences.mockResolvedValue({ preferred_time_window: null });
  techScopedConfirmActive.mockReturnValue(false);
  dayOnlyEligibility.mockReset();
  dayOnlyEligibility.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, { eligible: true, level: 'none' }])));
  loadToldVisitIds.mockReset();
  loadToldVisitIds.mockResolvedValue(new Set());
});
afterAll(() => { process.env = savedEnv; });

describe('fixedReason with the told-lock context', () => {
  const base = (extra = {}) => ({
    dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set(),
    toldLock: true, told: new Set(), customerTime: new Set(), ...extra,
  });
  const stop = (extra = {}) => ({
    id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1',
    is_recurring: true, recurring_parent_id: 'p1', customer_confirmed: false, ...extra,
  });

  test('a recurring child nobody told, and whose time is not the customer\'s, may move', () => {
    expect(_internals.fixedReason(stop(), base())).toBeNull();
  });

  test('a confirmed stop, a first or one-time stop and a staff-placed stop may move: who set the time no longer fixes it', () => {
    expect(_internals.fixedReason(stop({ customer_confirmed: true }), base())).toBeNull();
    expect(_internals.fixedReason(stop({ is_recurring: false }), base())).toBeNull();
    expect(_internals.fixedReason(stop({ is_recurring: null }), base())).toBeNull();
    expect(_internals.fixedReason(stop({ recurring_parent_id: null }), base())).toBeNull();
    // The removed person-placed fact, were a caller to still send it, is not read.
    expect(_internals.fixedReason(stop(), base({ personPlaced: new Set(['s1']) }))).toBeNull();
  });

  test('customer_time: the stop is in the customer-time set', () => {
    expect(_internals.fixedReason(stop(), base({ customerTime: new Set(['s1']) }))).toBe('customer_time');
    expect(_internals.fixedReason(stop(), base({ customerTime: new Set(['other']) }))).toBeNull();
  });

  test('time_told', () => {
    expect(_internals.fixedReason(stop(), base({ told: new Set(['s1']) }))).toBe('time_told');
  });

  test('the existing reasons keep their order and values; customer_time comes before time_told', () => {
    const all = base({ sent24: new Set(['s1']), told: new Set(['s1']), customerTime: new Set(['s1']) });
    expect(_internals.fixedReason(stop(), all)).toBe('reminder_24h_sent');
    expect(_internals.fixedReason(stop({ status: 'dispatched' }), all)).toBe('status');
    expect(_internals.fixedReason(stop({ auto_dispatch_excluded: true }), all)).toBe('staff_lock');
    expect(_internals.fixedReason(stop(), { ...all, sent24: new Set() })).toBe('customer_time');
    expect(_internals.fixedReason(stop(), { ...all, sent24: new Set(), customerTime: new Set() })).toBe('time_told');
  });

  test('a context without the told-lock facts (the quick screen) skips both reasons', () => {
    const off = base({ toldLock: undefined, told: new Set(['s1']), customerTime: new Set(['s1']) });
    expect(_internals.fixedReason(stop(), off)).toBeNull();
    const bare = { dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set() };
    expect(_internals.fixedReason(stop(), bare)).toBeNull();
  });

  test('a told-lock fact the day load did not provide keeps the stop fixed (fail closed)', () => {
    expect(_internals.fixedReason(stop(), base({ customerTime: undefined }))).toBe('customer_time');
    expect(_internals.fixedReason(stop(), base({ told: undefined }))).toBe('time_told');
  });
});

describe('loadCustomerTime', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  test('a visit that is not eligible, and one with no verdict, are the customer\'s time; an eligible one is not; the told level is ignored', async () => {
    dayOnlyEligibility.mockResolvedValue(new Map([['a', { eligible: false, level: 'none' }], ['b', { eligible: true, level: 'none' }]]));
    const set = await _internals.loadCustomerTime({}, rows, NOW);
    expect([...set].sort()).toEqual(['a', 'c']);
    expect(dayOnlyEligibility).toHaveBeenCalledTimes(1);
    expect(dayOnlyEligibility).toHaveBeenCalledWith({}, ['a', 'b', 'c'], NOW, { ignoreLevel: true });
  });

  test('a failed read returns every id and warns (fail closed)', async () => {
    dayOnlyEligibility.mockRejectedValue(new Error('verdict read down'));
    const set = await _internals.loadCustomerTime({}, rows, NOW);
    expect([...set].sort()).toEqual(['a', 'b', 'c']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('customer-time read failed'));
  });
});

describe('loadDayContext', () => {
  const dayRows = () => [
    { ...row('a', 0.30, 8), recurring_parent_id: 'p1' },
    { ...row('b', 0.02, 9), recurring_parent_id: 'p1' },
  ];

  test('the told set comes from one bulk promise read, a 72-hour flag alone is not told; customer-time ids come from one bulk read', async () => {
    const reminders = [{ scheduled_service_id: 'a', reminder_24h_sent: false, reminder_72h_sent: true, windows_preclosed: false, cancelled: false }];
    loadToldVisitIds.mockResolvedValue(new Set(['b']));
    dayOnlyEligibility.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, { eligible: id !== 'b', level: 'none' }])));
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() }, reminders });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect(ctx.toldLock).toBe(true);
    expect([...ctx.told]).toEqual(['b']);
    expect([...ctx.customerTime]).toEqual(['b']);
    expect(ctx).not.toHaveProperty('personPlaced');
    expect(loadToldVisitIds).toHaveBeenCalledTimes(1);
    expect(loadToldVisitIds).toHaveBeenCalledWith(conn, ['a', 'b'], NOW);
    expect(dayOnlyEligibility).toHaveBeenCalledTimes(1);
    expect(dayOnlyEligibility).toHaveBeenCalledWith(conn, ['a', 'b'], NOW, { ignoreLevel: true });
  });

  test('a failed customer-time read keeps every stop fixed as customer_time', async () => {
    dayOnlyEligibility.mockRejectedValue(new Error('verdict read down'));
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() } });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect([...ctx.customerTime].sort()).toEqual(['a', 'b']);
    for (const r of dayRows()) expect(_internals.fixedReason({ ...r, customer_confirmed: false }, ctx)).toBe('customer_time');
  });

  test('a failed promise read keeps every stop fixed (the told set marks every row)', async () => {
    loadToldVisitIds.mockRejectedValue(new Error('promise read down'));
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() } });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect([...ctx.told].sort()).toEqual(['a', 'b']);
    for (const r of dayRows()) expect(_internals.fixedReason({ ...r, customer_confirmed: false }, ctx)).toBe('time_told');
  });

  test('a failed 24-hour reminder read still throws (the day is skipped), as before', async () => {
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() }, failReminders: true });
    await expect(_internals.loadDayContext(conn, TOMORROW, NOW)).rejects.toThrow('reminders down');
  });
});

describe('shadow run: the fixed list records each reason', () => {
  beforeEach(() => { process.env.GATE_DAY_REPLAN = 'shadow'; });
  const withParent = (extra = {}) => zigzagRows({
    a: { recurring_parent_id: 'p1', ...extra.a }, b: { recurring_parent_id: 'p1', ...extra.b },
    c: { recurring_parent_id: 'p1', ...extra.c }, d: { recurring_parent_id: 'p1', ...extra.d },
  });
  const fixedOf = (inserts) => JSON.parse(inserts[0].row.fixed).map((f) => [f.id, f.why]).sort();

  test('each reason shows up in the fixed list; a confirmed, a first or one-time and a staff-placed stop stay movable', async () => {
    dayOnlyEligibility.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, { eligible: id !== 'c', level: 'none' }])));
    loadToldVisitIds.mockResolvedValue(new Set(['d']));
    const rows = withParent({ a: { customer_confirmed: true }, b: { recurring_parent_id: null, is_recurring: false } });
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: rows } });
    await runDayReplanIfEnabled({ now: NOW, conn });
    expect(fixedOf(inserts)).toEqual([['c', 'customer_time'], ['d', 'time_told']]);
  });

  test('a customer-time read that cannot be read keeps every stop fixed', async () => {
    dayOnlyEligibility.mockRejectedValue(new Error('verdict read down'));
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: withParent() } });
    await runDayReplanIfEnabled({ now: NOW, conn });
    expect(fixedOf(inserts).every(([, why]) => why === 'customer_time')).toBe(true);
  });
});

// The day re-plan keeps a visit whose 24-hour reminder will not go out: apply re-times silently, and that reminder is the
// only notice of the new hour.
describe('reminder_24h_off', () => {
  const ctxWith = (extra = {}) => ({ dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set(), ...extra });
  const stop = (extra = {}) => ({ id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1', ...extra });
  const dayRows = () => [{ ...row('a', 0.30, 8), recurring_parent_id: 'p1' }, { ...row('b', 0.02, 9), recurring_parent_id: 'p1' }];

  test('a stop whose reminder is off is fixed; others are not', () => {
    const ctx = ctxWith({ reminder24hOff: new Set(['s1']) });
    expect(_internals.fixedReason(stop(), ctx)).toBe('reminder_24h_off');
    expect(_internals.fixedReason(stop({ id: 's2' }), ctx)).toBeNull();
  });

  test('a context with no reminder fact skips the check (callers that never load it keep their behavior)', () => {
    expect(_internals.fixedReason(stop(), ctxWith())).toBeNull();
  });

  test('order: the sent reminder and the 24-hour reach come first, the told-lock reasons after', () => {
    const off = new Set(['s1']);
    expect(_internals.fixedReason(stop(), ctxWith({ sent24: new Set(['s1']), reminder24hOff: off }))).toBe('reminder_24h_sent');
    expect(_internals.fixedReason(stop({ window_start: '05:00:00' }), ctxWith({ reminder24hOff: off }))).toBe('within_24h');
    const told = ctxWith({ reminder24hOff: off, toldLock: true, told: new Set(['s1']), customerTime: new Set(['s1']) });
    expect(_internals.fixedReason(stop(), told)).toBe('reminder_24h_off');
  });

  test('loadDayContext: a customer who turned the 24-hour reminder off fixes that visit only', async () => {
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() }, notificationPrefs: [{ customer_id: 'cust-a', service_reminder_24h: false }] });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect([...ctx.reminder24hOff]).toEqual(['a']);
    expect(_internals.fixedReason(dayRows()[0], ctx)).toBe('reminder_24h_off');
    expect(_internals.fixedReason(dayRows()[1], ctx)).toBeNull();
  });

  test('loadDayContext: texts off for a text reminder fixes that visit', async () => {
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() }, notificationPrefs: [{ customer_id: 'cust-b', sms_enabled: false }] });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect([...ctx.reminder24hOff]).toEqual(['b']);
  });

  test('loadDayContext: reminders on (no prefs rows) leave the day unchanged', async () => {
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() } });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect(ctx.reminder24hOff.size).toBe(0);
    expect(_internals.fixedReason(dayRows()[0], ctx)).toBeNull();
  });

  test('loadDayContext: an answer that is not a clear "will send" (unknown) fixes the visit', async () => {
    const reminders = require('../services/appointment-reminders');
    const spy = jest.spyOn(reminders, 'loadVisitReminder24hAnswers').mockResolvedValue(new Map([['a', true]]));
    try {
      const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() } });
      const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
      expect([...ctx.reminder24hOff]).toEqual(['b']);
    } finally { spy.mockRestore(); }
  });

  test('loadDayContext: a failed read does not throw and fixes every visit of the day', async () => {
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() }, failPrefs: true });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect([...ctx.reminder24hOff].sort()).toEqual(['a', 'b']);
    for (const r of dayRows()) expect(_internals.fixedReason(r, ctx)).toBe('reminder_24h_off');
  });
});
