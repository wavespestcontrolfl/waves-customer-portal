/**
 * GATE_NIGHT_TOLD_LOCK on the nightly day re-plan (services/day-replan/index.js, owner 2026-11-05 "D1 a"): with
 * the gate on, four more kinds of stop stay fixed at their hour: customer_confirmed, first_or_one_time,
 * person_placed (a person chose the date or time; an unreadable history keeps the stop fixed) and
 * time_told (a known-slot promise, by the no-show detector's promise reader in auto-dispatch/told-visits.js, mocked
 * here; a reminder_72h_sent flag alone is not told). Gate off: none of them, as before.
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
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));

const { techScopedConfirmActive } = require('../services/scheduling/occupancy');
const { getCustomerSchedulingPreferences } = require('../services/auto-dispatch/preferences');
const { isPersonPlacedVisit } = require('../services/auto-dispatch/eligibility');
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
  delete process.env.GATE_NIGHT_TOLD_LOCK;
  delete process.env.DAY_REPLAN_DAYS_AHEAD;
  delete process.env.GATE_TECH_START_POINTS;
  delete process.env.GATE_AUTO_DISPATCH_DAY_RULES;
  getCustomerSchedulingPreferences.mockResolvedValue({ preferred_time_window: null });
  techScopedConfirmActive.mockReturnValue(false);
  isPersonPlacedVisit.mockImplementation(async () => ({ placed: false }));
  loadToldVisitIds.mockReset();
  loadToldVisitIds.mockResolvedValue(new Set());
});
afterAll(() => { process.env = savedEnv; });

describe('fixedReason with the told-lock context', () => {
  const base = (extra = {}) => ({
    dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set(),
    toldLock: true, told: new Set(), personPlaced: new Set(), ...extra,
  });
  const stop = (extra = {}) => ({
    id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1',
    is_recurring: true, recurring_parent_id: 'p1', customer_confirmed: false, ...extra,
  });

  test('a recurring child nobody told or placed may move', () => {
    expect(_internals.fixedReason(stop(), base())).toBeNull();
  });

  test('customer_confirmed', () => {
    expect(_internals.fixedReason(stop({ customer_confirmed: true }), base())).toBe('customer_confirmed');
  });

  test('first_or_one_time: not recurring, or no parent series', () => {
    expect(_internals.fixedReason(stop({ is_recurring: false }), base())).toBe('first_or_one_time');
    expect(_internals.fixedReason(stop({ is_recurring: null }), base())).toBe('first_or_one_time');
    expect(_internals.fixedReason(stop({ recurring_parent_id: null }), base())).toBe('first_or_one_time');
    expect(_internals.fixedReason(stop({ recurring_parent_id: undefined }), base())).toBe('first_or_one_time');
  });

  test('person_placed', () => {
    expect(_internals.fixedReason(stop(), base({ personPlaced: new Set(['s1']) }))).toBe('person_placed');
    expect(_internals.fixedReason(stop(), base({ personPlaced: new Set(['other']) }))).toBeNull();
  });

  test('time_told', () => {
    expect(_internals.fixedReason(stop(), base({ told: new Set(['s1']) }))).toBe('time_told');
  });

  test('the existing reasons keep their order and values; the new ones come after', () => {
    const all = base({ sent24: new Set(['s1']), told: new Set(['s1']), personPlaced: new Set(['s1']) });
    expect(_internals.fixedReason(stop({ customer_confirmed: true, is_recurring: false }), all)).toBe('reminder_24h_sent');
    expect(_internals.fixedReason(stop({ customer_confirmed: true, is_recurring: false, status: 'dispatched' }), all)).toBe('status');
    expect(_internals.fixedReason(stop({ customer_confirmed: true, is_recurring: false }), { ...all, sent24: new Set() })).toBe('customer_confirmed');
    expect(_internals.fixedReason(stop({ is_recurring: false }), { ...all, sent24: new Set() })).toBe('first_or_one_time');
    expect(_internals.fixedReason(stop(), { ...all, sent24: new Set() })).toBe('person_placed');
    expect(_internals.fixedReason(stop(), { ...all, sent24: new Set(), personPlaced: new Set() })).toBe('time_told');
  });

  test('gate off (no toldLock in the context): none of the new reasons, as before', () => {
    const off = base({ toldLock: undefined, told: new Set(['s1']), personPlaced: new Set(['s1']) });
    expect(_internals.fixedReason(stop({ customer_confirmed: true, is_recurring: false, recurring_parent_id: null }), off)).toBeNull();
    const bare = { dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set() };
    expect(_internals.fixedReason(stop({ customer_confirmed: true, is_recurring: false }), bare)).toBeNull();
  });

  test('a told-lock fact the day load did not provide keeps the stop fixed (fail closed)', () => {
    expect(_internals.fixedReason(stop(), base({ personPlaced: undefined }))).toBe('person_placed');
    expect(_internals.fixedReason(stop(), base({ told: undefined }))).toBe('time_told');
  });
});

describe('loadDayContext', () => {
  const dayRows = () => [
    { ...row('a', 0.30, 8), recurring_parent_id: 'p1' },
    { ...row('b', 0.02, 9), recurring_parent_id: 'p1' },
  ];

  test('gate off: no told-lock facts and no extra reads', async () => {
    const { conn, calls } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() } });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect(ctx.toldLock).toBeUndefined();
    expect(ctx.told).toBeUndefined();
    expect(ctx.personPlaced).toBeUndefined();
    expect(isPersonPlacedVisit).not.toHaveBeenCalled();
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    expect(calls.filter(([table, method]) => table === 'appointment_reminders' && method === 'select')).toHaveLength(1);
  });

  test('gate on: the told set comes from one bulk promise read, a 72-hour flag alone is not told; person-placed ids come from the auto-dispatch rule', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    const reminders = [{ scheduled_service_id: 'a', reminder_24h_sent: false, reminder_72h_sent: true, windows_preclosed: false, cancelled: false }];
    loadToldVisitIds.mockResolvedValue(new Set(['b']));
    isPersonPlacedVisit.mockImplementation(async (r) => ({ placed: r.id === 'b' }));
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() }, reminders });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect(ctx.toldLock).toBe(true);
    expect([...ctx.told]).toEqual(['b']);
    expect([...ctx.personPlaced]).toEqual(['b']);
    expect(loadToldVisitIds).toHaveBeenCalledTimes(1);
    expect(loadToldVisitIds).toHaveBeenCalledWith(conn, ['a', 'b'], NOW);
    expect(isPersonPlacedVisit).toHaveBeenCalledTimes(2);
  });

  test('gate on: a failed person-placed read (degraded verdict) keeps the stop fixed', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    isPersonPlacedVisit.mockImplementation(async () => ({ placed: true, degraded: true, reason_code: 'PERSON_PLACED_UNKNOWN' }));
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() } });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect(_internals.fixedReason({ ...dayRows()[0], customer_confirmed: false }, ctx)).toBe('person_placed');
    // A verdict that is not even an object also fails closed.
    isPersonPlacedVisit.mockImplementation(async () => undefined);
    const again = await _internals.loadDayContext(fakeConn({ stopsByDate: { [TOMORROW]: dayRows() } }).conn, TOMORROW, NOW);
    expect([...again.personPlaced].sort()).toEqual(['a', 'b']);
  });

  test('gate on: a failed promise read keeps every stop fixed (the told set marks every row)', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    loadToldVisitIds.mockRejectedValue(new Error('promise read down'));
    const { conn } = fakeConn({ stopsByDate: { [TOMORROW]: dayRows() } });
    const ctx = await _internals.loadDayContext(conn, TOMORROW, NOW);
    expect([...ctx.told].sort()).toEqual(['a', 'b']);
    for (const r of dayRows()) expect(_internals.fixedReason({ ...r, customer_confirmed: false }, ctx)).toBe('time_told');
  });

  test('gate on: a failed 24-hour reminder read still throws (the day is skipped), as before', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
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

  test('gate off: rows with no parent series and a confirmed customer still move (nothing fixed)', async () => {
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: zigzagRows({ a: { customer_confirmed: true } }) } });
    await runDayReplanIfEnabled({ now: NOW, conn });
    expect(fixedOf(inserts)).toEqual([]);
  });

  test('gate on: each new reason shows up in the fixed list', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    isPersonPlacedVisit.mockImplementation(async (r) => ({ placed: r.id === 'c' }));
    loadToldVisitIds.mockResolvedValue(new Set(['d']));
    const rows = withParent({ a: { customer_confirmed: true }, b: { recurring_parent_id: null } });
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: rows } });
    await runDayReplanIfEnabled({ now: NOW, conn });
    expect(fixedOf(inserts)).toEqual([['a', 'customer_confirmed'], ['b', 'first_or_one_time'], ['c', 'person_placed'], ['d', 'time_told']]);
  });

  test('gate on: a person-placed history that cannot be read keeps every stop fixed', async () => {
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    isPersonPlacedVisit.mockImplementation(async () => ({ placed: true, degraded: true }));
    const { conn, inserts } = fakeConn({ stopsByDate: { [TOMORROW]: withParent() } });
    await runDayReplanIfEnabled({ now: NOW, conn });
    expect(fixedOf(inserts).every(([, why]) => why === 'person_placed')).toBe(true);
  });
});

// The day re-plan keeps a visit whose 24-hour reminder will not go out: apply re-times silently, and that reminder is the
// only notice of the new hour.
describe('reminder_24h_off', () => {
  const ctxWith = (extra = {}) => ({ dateStr: TOMORROW, now: NOW, visitCounts: new Map(), customerCounts: new Map(), sent24: new Set(), ...extra });
  const stop = (extra = {}) => ({ id: 's1', status: 'confirmed', window_start: '09:00:00', visit_id: null, customer_id: 'c1', ...extra });
  const dayRows = () => [row('a', 0.30, 8), row('b', 0.02, 9)];

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
    const told = ctxWith({ reminder24hOff: off, toldLock: true, told: new Set(['s1']), personPlaced: new Set(['s1']) });
    expect(_internals.fixedReason(stop({ customer_confirmed: true }), told)).toBe('reminder_24h_off');
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
