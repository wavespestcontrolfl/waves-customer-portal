jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

/**
 * The make-room check (GATE_BOOKING_MAKE_ROOM, owner 2026-11-06): which taken hour a new customer could have when
 * the stop there, and each later stop it would overlap, moves later until a free hour takes the last one. The rules
 * are the 4:40 re-plan's own (the REAL day-replan fixedReason and skipReason run here); the reads, the route check and
 * the drive model are fakes so each rule can be shown alone. The day is the plan page's example: stops A to F at
 * 8, 9, 10, 11, 1 PM and 2 PM, free at 12 PM and 3 PM, the new customer 4 minutes from stop B.
 */
const { recordMakeRoomCheck, bookingMakeRoomMode, _internals } = require('../services/scheduling/booking-make-room');
const { fixedReason, skipReason } = require('../services/day-replan')._internals;

const DAY = '2097-06-10';
const NOW = new Date('2097-06-09T05:00:00Z'); // 01:00 ET: every stop on DAY starts more than 24 hours away
const TECH = 'tech-1';
const HOME = { lat: 10, lng: 90 };
const NEW_PIN = { lat: 14, lng: 20 };
const legMin = (a, b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng));

function stop(name, hour, lng, extra = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    id: `visit-${name}`, customer_id: `cust-${name}`, visit_id: null, technician_id: TECH, scheduled_date: DAY, status: 'pending',
    window_start: `${pad(hour)}:00:00`, window_end: `${pad(hour + 1)}:00:00`, estimated_duration_minutes: 60,
    lat: 10, lng, is_recurring: true, recurring_parent_id: `parent-${name}`, customer_confirmed: false,
    auto_dispatch_locked: false, auto_dispatch_excluded: false, reservation_expires_at: null, source_action: null,
    ...extra,
  };
}

const exampleDay = () => [
  stop('a', 8, 10, { customer_confirmed: true }), stop('b', 9, 20), stop('c', 10, 30), stop('d', 11, 40),
  stop('e', 13, 50), stop('f', 14, 60),
];
// The free hours of the example day as the page lists them.
const FREE = [{ date: DAY, windowStart: '12:00', techId: TECH }, { date: DAY, windowStart: '15:00', techId: TECH }];

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) if (row[key] != null) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  return counts;
}

// The added drive minutes the route check reports for every passing placement.
const ROUTE_DETOUR_MIN = 20;

const TEXTS = { smsEnabled: true, serviceReminder72h: true, serviceReminder24h: true, reminder72hChannel: 'sms', reminder24hChannel: 'sms' };

function makeDeps({
  rows = exampleDay(), told = ['visit-e'], prefs = {}, pref = {}, feasible = true, blocks = [], holdIds = [], techBlind = true,
  channel72 = {}, assignable = [TECH], absent = [], blackout = [], inactive = [], pushRoute = 'push_and_sms', device = null,
} = {}) {
  const evaluated = [];
  return {
    evaluated,
    loadDayStops: jest.fn(async (_conn, dateStr) => rows.filter((r) => r.scheduled_date === dateStr)),
    // The full day facts with GATE_NIGHT_TOLD_LOCK on: E was told its hour; nobody else was told or placed by a person.
    loadDayContext: jest.fn(async (_conn, dateStr, now) => {
      const allRows = rows.filter((r) => r.scheduled_date === dateStr);
      return { dateStr, now, allRows, visitCounts: countBy(allRows, 'visit_id'), customerCounts: countBy(allRows, 'customer_id'), sent24: new Set(), toldLock: true, told: new Set(told), personPlaced: new Set() };
    }),
    fixedReason,
    skipReason,
    loadBlocks: jest.fn(async () => blocks),
    loadPref: jest.fn(async (_conn, row) => pref[row.id] || null),
    legMin,
    loadTechStartPoints: jest.fn(async () => new Map()),
    homeFromMap: () => HOME,
    loadArrivalRouteContext: jest.fn(async ({ date }) => ({ date, rows: rows.filter((r) => r.scheduled_date === date) })),
    evaluateArrivalPlacement: jest.fn((context, placement) => {
      evaluated.push({ context, placement });
      return feasible ? { feasible: true, detourMinutes: ROUTE_DETOUR_MIN } : { feasible: false, reason: 'arrival_window' };
    }),
    arrivalWindowsOn: () => true,
    getReminderPrefs: jest.fn(async (customerId) => prefs[customerId] || TEXTS),
    // The sender's 72-hour channel: the stored one, unless a test promotes a visit (email-first one-time visits).
    resolve72hChannel: jest.fn(async (stored, visitId) => channel72[visitId] || stored),
    assignableTechIds: jest.fn(async () => assignable),
    absentTechDays: jest.fn(async () => new Set(absent)),
    getBlackoutDates: jest.fn(async () => new Set(blackout)),
    inactiveCapabilities: jest.fn(async () => inactive),
    // The picker's self-serve drive cap (capacity mode only) and the zone route-day config it reads. A test turns
    // capacity mode on by setting these on the returned deps.
    capacityOn: () => false,
    customerMaxDetourMinutes: jest.fn(() => 30),
    zoneRouteDaysLive: () => false,
    readZoneRouteDays: jest.fn(async () => ({ synthetic: true })),
    // The sender's app routing for a reminder type, and the customer's app device as its sender reads it.
    pushRouteFor: jest.fn(() => pushRoute),
    appDeviceStatus: jest.fn(async () => device || { enabled: true, registered: false, fresh: false, reachable: false }),
    techBlind: () => techBlind,
    closeMin: 17 * 60,
    ownHoldIds: jest.fn(async () => new Set(holdIds)),
  };
}

function fakeConn() {
  const inserted = [];
  const conn = jest.fn(() => ({ insert: jest.fn(async (row) => { inserted.push(row); }) }));
  return { conn, inserted };
}

// The page's placement rules (estimate-slot-availability makeRoomPlacement) are the page's own; here they pass.
const PAGE_PLACES = async () => true;

async function check({ deps = makeDeps(), pool = FREE, admit = (slot) => slot.date === DAY, placement = PAGE_PLACES, coords = NEW_PIN, durationMinutes = 60, ...extra } = {}) {
  const { conn, inserted } = fakeConn();
  const report = await recordMakeRoomCheck({
    mode: 'shadow', estimateId: 'est-1', pool, coords, durationMinutes, dateFrom: DAY, dateTo: DAY, admit, placement, now: NOW, conn, deps, ...extra,
  });
  return { report, inserted, deps };
}

const moves = (summary) => summary.moves.map((m) => `${m.id} ${m.from}->${m.to}`);
const starts = (report) => report.passed.map((p) => p.start);

describe('the plan page example', () => {
  test('9 AM: stops B, C and D move 1 hour later, the chain ends in the free 12 PM hour, E and F keep theirs', async () => {
    const { report, inserted, deps } = await check();
    const best = report.passed[0];
    expect(best).toMatchObject({ date: DAY, start: '09:00', techId: TECH });
    expect(moves(best)).toEqual(['visit-b 09:00->10:00', 'visit-c 10:00->11:00', 'visit-d 11:00->12:00']);
    // Taking 9 AM adds A->new->B (11 + 4 - 10 = 5); the better free hour (12 PM, D->new->E) adds 20 + 30 - 10 = 40.
    expect(report.free.best).toMatchObject({ detourMin: 40, start: '12:00' });
    expect(best).toMatchObject({ detourMin: 5, savingMin: 35 });
    // The route check saw the moved day: B, C and D at their new hours, E and F unchanged.
    const { context, placement } = deps.evaluated.find((e) => e.placement.windowStart === '09:00');
    const at = (id) => context.rows.find((r) => r.id === id);
    expect([at('visit-b').window_start, at('visit-c').window_start, at('visit-d').window_start]).toEqual(['10:00', '11:00', '12:00']);
    expect([at('visit-d').window_end, at('visit-e').window_start, at('visit-f').window_start]).toEqual(['13:00', '13:00:00', '14:00:00']);
    expect(placement).toEqual({ windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60 });
    // One log row: ids, hours and minutes only.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ mode: 'shadow', surface: 'estimate', estimate_id: 'est-1', fired: true, best_saving_min: 35, moved_count: 3 });
    expect(JSON.parse(inserted[0].report).passed[0].moves).toHaveLength(3);
  });

  test('the confirmed stop A never moves: 8 AM, whose chain starts with A, is not found', async () => {
    const { report } = await check();
    expect(starts(report)).not.toContain('08:00');
    expect(report.byReason.fixed_customer_confirmed).toBeGreaterThanOrEqual(1);
  });

  test('a stop the customer was told the hour of never moves (read with the full day facts)', async () => {
    const { report } = await check({ deps: makeDeps({ told: ['visit-c'] }) });
    expect(starts(report)).not.toContain('09:00');
    expect(starts(report)).toContain('11:00');
    expect(report.byReason.fixed_time_told).toBeGreaterThanOrEqual(1);
  });

  test('a stop inside the 24-hour lock never moves', async () => {
    // The same day seen at 01:00 ET on the day itself: every stop is inside the lock.
    const { conn } = fakeConn();
    const report = await recordMakeRoomCheck({
      mode: 'shadow', estimateId: 'est-1', pool: FREE, coords: NEW_PIN, durationMinutes: 60, dateFrom: DAY, dateTo: DAY,
      admit: () => true, placement: PAGE_PLACES, now: new Date('2097-06-10T05:00:00Z'), conn, deps: makeDeps(),
    });
    expect(report.passed).toEqual([]);
    expect(report.byReason.fixed_within_24h).toBeGreaterThanOrEqual(1);
  });
});

describe('the rules a moved customer adds', () => {
  test('a customer with reminder texts off never moves', async () => {
    const { report, inserted } = await check({ deps: makeDeps({ prefs: { 'cust-c': { smsEnabled: false, serviceReminder72h: true, serviceReminder24h: true } } }) });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.reminders_off).toBeGreaterThanOrEqual(1);
    expect(inserted[0].fired).toBe(report.passed.length > 0);
  });

  test('unreadable reminder settings count as off', async () => {
    const { report } = await check({ deps: makeDeps({ prefs: { 'cust-b': { unavailable: true, smsEnabled: true } } }) });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.reminders_off).toBeGreaterThanOrEqual(1);
  });

  test.each([
    ['a 72-hour reminder the sender sends by email (an email-first one-time visit)', { channel72: { 'visit-c': 'email' } }],
    ['a 24-hour reminder sent only in the app', { prefs: { 'cust-c': { ...TEXTS, reminder24hChannel: 'push' } } }],
  ])('%s never moves', async (_label, opts) => {
    const { report } = await check({ deps: makeDeps(opts) });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.reminders_not_text).toBeGreaterThanOrEqual(1);
  });

  test('with app-first routing, a customer the sender can reach in the app never moves (reminders go in the app instead)', async () => {
    const device = { enabled: true, registered: true, fresh: false, reachable: true };
    const { report, deps } = await check({ deps: makeDeps({ pushRoute: 'push_first', device }) });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.reminders_not_text).toBeGreaterThanOrEqual(1);
    expect(deps.pushRouteFor).toHaveBeenCalledWith('cust-b', 'reminder_72h');
  });

  test('with app-first routing, a customer with no app device still gets texts and may move', async () => {
    const { report } = await check({ deps: makeDeps({ pushRoute: 'push_first' }) });
    expect(starts(report)).toContain('09:00');
  });

  test('reminders by text and email count as text, and the 72-hour channel is resolved the way the sender does', async () => {
    const prefs = { 'cust-c': { ...TEXTS, reminder72hChannel: 'both', reminder24hChannel: 'both', reminder72hChannelExplicit: true, emailEnabled: true } };
    const { report, deps } = await check({ deps: makeDeps({ prefs }) });
    expect(starts(report)).toContain('09:00');
    expect(deps.resolve72hChannel).toHaveBeenCalledWith('both', 'visit-c', { prefsUnavailable: undefined, explicitChoice: true, emailEnabled: true });
    // 'both' always keeps a text leg, so the app device is never read for it.
    expect(deps.appDeviceStatus).not.toHaveBeenCalledWith('cust-c', expect.anything());
  });

  test('a time preference that does not allow the new hour stops the chain', async () => {
    const { report } = await check({ deps: makeDeps({ pref: { 'visit-c': { startMin: 9 * 60, endMin: 11 * 60 } } }) });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.preference).toBeGreaterThanOrEqual(1);
  });
});

describe('the day and the route', () => {
  test.each([
    ['a blackout date', { blackout: [DAY] }],
    ['an absent or off technician-day', { absent: [`${TECH}:${DAY}`] }],
    ['a technician the page cannot assign', { assignable: [] }],
  ])('%s is never a candidate', async (_label, opts) => {
    const { report } = await check({ deps: makeDeps(opts) });
    expect(report.passed).toEqual([]);
    expect(report.candidates).toBe(0);
    expect(report.byReason.tech_day_closed).toBe(1);
  });

  test('a technician whose capability for the requested service is off is never a candidate (the page\'s rule)', async () => {
    const deps = makeDeps({ inactive: [{ technician_id: TECH, service_category: 'lawn', active: false }] });
    const capabilityRows = [{ service_type: 'lawn care' }];
    const { report } = await check({ deps, capabilityRows });
    expect(deps.inactiveCapabilities).toHaveBeenCalledWith(expect.anything(), [TECH], capabilityRows);
    expect(report.candidates).toBe(0);
    expect(report.byReason.tech_day_closed).toBe(1);
  });

  test('without the estimate\'s services, capability is not read', async () => {
    const deps = makeDeps();
    const { report } = await check({ deps });
    expect(deps.inactiveCapabilities).not.toHaveBeenCalled();
    expect(starts(report)).toContain('09:00');
  });

  test.each(['loadTechStartPoints', 'ownHoldIds'])('a setup read (%s) that never answers ends the check at its budget', async (name) => {
    const deps = makeDeps();
    deps[name] = jest.fn(() => new Promise(() => {}));
    const started = Date.now();
    const { report, inserted } = await check({ deps, budgetMs: 40 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(report.timedOut).toBe(true);
    expect(report.passed).toEqual([]);
    expect(inserted).toHaveLength(1);
  });

  test('in capacity mode, a moved route that adds more drive than the picker\'s cap is refused', async () => {
    const deps = makeDeps();
    deps.capacityOn = () => true;
    deps.customerMaxDetourMinutes = jest.fn(() => ROUTE_DETOUR_MIN - 1);
    const { report } = await check({ deps });
    expect(report.passed).toEqual([]);
    expect(report.byReason.detour_cap).toBeGreaterThanOrEqual(1);
    expect(deps.customerMaxDetourMinutes).toHaveBeenCalledWith(undefined);
  });

  test('in capacity mode, a route under the cap passes; the zone route-day lift is read for the request\'s zone', async () => {
    const deps = makeDeps();
    deps.capacityOn = () => true;
    deps.zoneRouteDaysLive = () => true;
    const { report } = await check({ deps, zoneSlug: 'venice' });
    expect(starts(report)).toContain('09:00');
    expect(deps.readZoneRouteDays).toHaveBeenCalledTimes(1);
    expect(deps.customerMaxDetourMinutes).toHaveBeenCalledWith({ date: DAY, technicianId: TECH, zoneSlug: 'venice', zoneRouteDays: { synthetic: true } });
  });

  test('capacity mode off: no cap, as on the page', async () => {
    const deps = makeDeps();
    deps.customerMaxDetourMinutes = jest.fn(() => ROUTE_DETOUR_MIN - 1);
    const { report } = await check({ deps });
    expect(starts(report)).toContain('09:00');
    expect(deps.customerMaxDetourMinutes).not.toHaveBeenCalled();
  });

  test('the blackout list is read strictly: an unreadable one stops the check', async () => {
    const deps = makeDeps();
    deps.getBlackoutDates.mockRejectedValue(new Error('settings down'));
    const { report } = await check({ deps });
    expect(deps.getBlackoutDates).toHaveBeenCalledWith(DAY, DAY, expect.anything(), { strict: true });
    expect(report.passed).toEqual([]);
    expect(report.error).toBe('settings down');
  });

  test('the route must keep every arrival window on the moved day', async () => {
    const { report, inserted } = await check({ deps: makeDeps({ feasible: false }) });
    expect(report.passed).toEqual([]);
    expect(report.byReason.route_arrival_window).toBeGreaterThanOrEqual(1);
    expect(inserted[0]).toMatchObject({ fired: false, best_saving_min: null, moved_count: null });
  });

  test('another technician\'s visit in a new hour blocks it while the occupancy check is technician-blind', async () => {
    const rows = [...exampleDay(), stop('x', 12, 80, { technician_id: 'tech-2' })];
    const blind = await check({ deps: makeDeps({ rows }) });
    expect(starts(blind.report)).not.toContain('09:00');
    expect(blind.report.byReason.taken_by_other).toBeGreaterThanOrEqual(1);
    const scoped = await check({ deps: makeDeps({ rows, techBlind: false }) });
    expect(starts(scoped.report)).toContain('09:00');
  });

  test('a schedule block in a new hour stops it', async () => {
    const { report } = await check({ deps: makeDeps({ blocks: [{ startMin: 12 * 60, endMin: 13 * 60 }] }) });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.schedule_block).toBeGreaterThanOrEqual(1);
  });

  test('only hours the estimate page could offer are tried', async () => {
    const { report, deps } = await check({ admit: (slot) => slot.windowStart !== '09:00' });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.not_offerable).toBeGreaterThanOrEqual(1);
    expect(deps.evaluated.some((e) => e.placement.windowStart === '09:00')).toBe(false);
  });

  test('this estimate\'s own hold is not a stop', async () => {
    const rows = [...exampleDay(), stop('hold', 9, 21, { id: 'own-hold', customer_id: null, reservation_expires_at: new Date('2097-06-09T05:15:00Z') })];
    const held = await check({ deps: makeDeps({ rows }) });
    expect(starts(held.report)).not.toContain('09:00');
    const own = await check({ deps: makeDeps({ rows, holdIds: ['own-hold'] }) });
    expect(starts(own.report)).toContain('09:00');
  });
});

describe('the saving bar', () => {
  test('an hour that saves less than 10 drive minutes over the best free time is not counted', async () => {
    // A free hour on another day right beside the new customer adds almost nothing.
    const rows = [...exampleDay(), stop('n', 9, 20, { scheduled_date: '2097-06-11', lat: 14 })];
    const pool = [...FREE, { date: '2097-06-11', windowStart: '10:00', techId: TECH }];
    const { conn, inserted } = fakeConn();
    const report = await recordMakeRoomCheck({
      mode: 'shadow', estimateId: 'est-1', pool, coords: NEW_PIN, durationMinutes: 60, dateFrom: DAY, dateTo: '2097-06-11',
      admit: () => true, placement: PAGE_PLACES, now: NOW, conn, deps: makeDeps({ rows }),
    });
    expect(report.free.best).toMatchObject({ date: '2097-06-11', start: '10:00' });
    expect(report.passed).toEqual([]);
    expect(report.byReason.saving_below_bar).toBeGreaterThanOrEqual(1);
    expect(inserted[0].fired).toBe(false);
  });

  test('with no free time at all, a freed hour counts with no saving figure', async () => {
    const { report, inserted } = await check({ pool: [] });
    expect(report.free).toEqual({ count: 0, best: null });
    expect(report.passed[0]).toMatchObject({ start: '09:00', savingMin: null });
    expect(inserted[0]).toMatchObject({ fired: true, best_saving_min: null, moved_count: 3 });
  });
});

describe('the chain', () => {
  const { buildChain } = _internals;
  const own = exampleDay();

  test('a visit up to 60 minutes moves each stop 1 hour; a 90-minute visit moves them 2 hours', () => {
    const hour = buildChain(own, { startMin: 9 * 60, durationMin: 60, closeMin: 17 * 60 });
    expect(hour.moves.map((m) => [m.row.id, m.toMin / 60])).toEqual([['visit-b', 10], ['visit-c', 11], ['visit-d', 12]]);
    const long = buildChain(own, { startMin: 9 * 60, durationMin: 90, closeMin: 17 * 60 });
    expect(long.moves.map((m) => [m.row.id, m.toMin / 60])).toEqual([['visit-b', 11], ['visit-c', 12], ['visit-d', 13], ['visit-e', 15], ['visit-f', 16]]);
  });

  test('a chain that would run past the day close, or an earlier stop still running, frees nothing', () => {
    expect(buildChain(own, { startMin: 13 * 60, durationMin: 60, closeMin: 15 * 60 })).toEqual({ reason: 'past_day_close' });
    const overlapping = [stop('a', 8, 10, { window_end: '09:30:00' }), stop('b', 9, 20)];
    expect(buildChain(overlapping, { startMin: 9 * 60, durationMin: 60, closeMin: 17 * 60 })).toEqual({ reason: 'earlier_stop_overlaps' });
  });

  test('stops that already overlap would still overlap after the move: refused, as the writer refuses it', () => {
    // B 9:00-10:30 and C 10:00-11:00 would become 10:00-11:30 and 11:00-12:00 (day-replan apply.js assertNoClash).
    const tight = [stop('b', 9, 20, { window_end: '10:30:00' }), stop('c', 10, 30), stop('d', 12, 40)];
    expect(buildChain(tight, { startMin: 9 * 60, durationMin: 60, closeMin: 17 * 60 })).toEqual({ reason: 'moved_stops_overlap' });
  });
});

describe('never throws', () => {
  test('a failed day read records the error and finds nothing', async () => {
    const deps = makeDeps();
    deps.loadDayStops = jest.fn(async () => { throw new Error('db down'); });
    const { report, inserted } = await check({ deps });
    expect(report.error).toBe('db down');
    expect(inserted[0]).toMatchObject({ fired: false });
  });

  test('no pin: skipped and recorded', async () => {
    const { report, inserted } = await check({ coords: null });
    expect(report.skipped).toBe('no_pin');
    expect(inserted).toHaveLength(1);
  });

  test('a failed log write is swallowed', async () => {
    const conn = jest.fn(() => ({ insert: jest.fn(async () => { throw new Error('no table'); }) }));
    await expect(recordMakeRoomCheck({
      mode: 'shadow', pool: FREE, coords: NEW_PIN, durationMinutes: 60, dateFrom: DAY, dateTo: DAY, admit: () => true, placement: PAGE_PLACES, now: NOW, conn, deps: makeDeps(),
    })).resolves.toMatchObject({ mode: 'shadow', skipped: null });
  });
});

describe('bookingMakeRoomMode (GATE_BOOKING_MAKE_ROOM, read at call time)', () => {
  const saved = process.env.GATE_BOOKING_MAKE_ROOM;
  afterAll(() => {
    if (saved === undefined) delete process.env.GATE_BOOKING_MAKE_ROOM;
    else process.env.GATE_BOOKING_MAKE_ROOM = saved;
  });

  test.each([[undefined, 'off'], ['', 'off'], ['shadow', 'shadow'], ['true', 'on'], [' TRUE ', 'on'], ['1', 'off'], ['on', 'off']])('%p -> %p', (value, mode) => {
    if (value === undefined) delete process.env.GATE_BOOKING_MAKE_ROOM;
    else process.env.GATE_BOOKING_MAKE_ROOM = value;
    expect(bookingMakeRoomMode()).toBe(mode);
  });
});

describe('the default reads', () => {
  // Regression: the reminder reader was reached through a name appointment-reminders.js does not export, so every
  // moved stop failed closed ('prefs_unreadable') on live data while the fake-dep tests above passed.
  test('every default reader is a real function of its module', () => {
    const deps = _internals.defaultDeps();
    const notFunctions = Object.entries(deps).filter(([name, value]) => name !== 'closeMin' && typeof value !== 'function').map(([name]) => name);
    expect(notFunctions).toEqual([]);
    expect(Number.isFinite(deps.closeMin)).toBe(true);
    const reminders = require('../services/appointment-reminders');
    expect(deps.getReminderPrefs).toBe(reminders._test.getReminderPrefs);
    expect(deps.resolve72hChannel).toBe(reminders._test.resolve72hChannel);
    expect(deps.inactiveCapabilities).toBe(require('../services/technician-capabilities').inactiveCapabilitiesForServices);
    const policy = require('../services/scheduling/policy');
    expect(deps.capacityOn).toBe(policy.capacityEnabled);
    expect(deps.customerMaxDetourMinutes).toBe(policy.customerMaxDetourMinutes);
    expect(deps.zoneRouteDaysLive).toBe(require('../config/feature-gates').zoneRouteDaysLive);
    expect(deps.readZoneRouteDays).toBe(require('../services/scheduling/zone-route-days').readZoneRouteDays);
    expect(typeof require('../services/push-notifications').customerStatus).toBe('function');
    expect(typeof deps.pushRouteFor('cust-1', 'reminder_72h')).toBe('string');
    expect(typeof deps.techBlind()).toBe('boolean');
  });
});

describe('the page\'s placement rules on the moved day', () => {
  test('the page judges the new visit\'s slot with each moved stop shifted by its move', async () => {
    const placement = jest.fn(PAGE_PLACES);
    const { report } = await check({ placement });
    expect(starts(report)).toContain('09:00');
    const [slot, shifted] = placement.mock.calls.find(([s]) => s.windowStart === '09:00');
    expect(slot).toEqual({ date: DAY, windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60, techId: TECH, routeMode: 'arrival_windows' });
    expect([...shifted]).toEqual([['visit-b', 60], ['visit-c', 60], ['visit-d', 60]]);
  });

  test('an hour the page refuses on the moved day (for example the travel gap) is not found, and its reason is counted', async () => {
    const { report } = await check({ placement: async (slot) => (slot.windowStart === '09:00' ? 'page_collision' : true) });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.page_collision).toBe(1);
  });

  test('an answer that is not true never passes an hour', async () => {
    const { report } = await check({ placement: async () => false });
    expect(report.passed).toEqual([]);
    expect(report.byReason.page_rules).toBeGreaterThanOrEqual(1);
  });

  test('without the page\'s placement rules the check does not run; it still records its row', async () => {
    const { report, inserted } = await check({ placement: null });
    expect(report.skipped).toBe('no_request');
    expect(inserted).toHaveLength(1);
  });
});

describe('the request\'s dates', () => {
  test('calendar days across the fall-back change come from the shared ET helpers, with the free list\'s dates', () => {
    const { datesFor } = _internals;
    expect(datesFor({ dateFrom: '2026-10-31', dateTo: '2026-11-03', pool: [{ date: '2026-11-10' }] }))
      .toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-10']);
  });
});

describe('startBackgroundCheck (backpressure for the detached check)', () => {
  const { startBackgroundCheck } = require('../services/scheduling/booking-make-room');
  const { resetBackgroundChecks, MAX_IN_FLIGHT, DEDUPE_MS } = _internals;
  beforeEach(() => resetBackgroundChecks());

  // A check whose first read waits until the test lets it go.
  function heldDeps() {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const deps = makeDeps();
    const base = deps.loadTechStartPoints;
    deps.loadTechStartPoints = jest.fn(async (...args) => { await gate; return base(...args); });
    return { deps, release };
  }
  const args = (estimateId, deps) => ({
    mode: 'shadow', estimateId, pool: FREE, coords: NEW_PIN, durationMinutes: 60, dateFrom: DAY, dateTo: DAY,
    admit: (slot) => slot.date === DAY, placement: PAGE_PLACES, now: NOW, conn: fakeConn().conn, deps, budgetMs: 60000,
  });

  test('at most MAX_IN_FLIGHT checks run at once; an extra request is dropped and records nothing', async () => {
    const held = Array.from({ length: MAX_IN_FLIGHT }, () => heldDeps());
    const runs = held.map((h, i) => startBackgroundCheck(args(`est-${i}`, h.deps)));
    const extra = makeDeps();
    await expect(startBackgroundCheck(args('est-extra', extra))).resolves.toBeNull();
    expect(extra.loadTechStartPoints).not.toHaveBeenCalled();
    held.forEach((h) => h.release());
    const reports = await Promise.all(runs);
    expect(reports.every((r) => r && r.mode === 'shadow')).toBe(true);
    // A slot is free again once a check ends.
    await expect(startBackgroundCheck(args('est-extra', extra))).resolves.toMatchObject({ mode: 'shadow' });
  });

  test('one estimate gets at most one check per DEDUPE_MS', async () => {
    const t0 = Date.now();
    await expect(startBackgroundCheck(args('est-1', makeDeps()), { nowMs: t0 })).resolves.toMatchObject({ mode: 'shadow' });
    await expect(startBackgroundCheck(args('est-1', makeDeps()), { nowMs: t0 + 1000 })).resolves.toBeNull();
    await expect(startBackgroundCheck(args('est-1', makeDeps()), { nowMs: t0 + DEDUPE_MS })).resolves.toMatchObject({ mode: 'shadow' });
  });
});
