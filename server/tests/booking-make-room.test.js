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
const { travelGapConflicts } = require('../services/scheduling/travel-gap');
const { stopExpectedMinutesSync } = require('../services/scheduling/expected-service-minutes');

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
  travelGap = false, multiTech = false,
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
    // The sooner pass's travel-gap screen: the page's own gate, rule and expected minutes (the real functions).
    travelGapEnabled: () => travelGap,
    travelGapConflicts: jest.fn(travelGapConflicts),
    stopExpectedMinutesSync: jest.fn(stopExpectedMinutesSync),
    ensureCatalogLoaded: jest.fn(async () => {}),
    multiTechConfirmLive: () => multiTech,
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

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(condition) {
  const end = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > end) throw new Error('the condition never held');
    await sleep(5);
  }
}

// One read of `deps` answers only when the test lets it go.
function holdRead(deps, name) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = deps[name];
  deps[name] = jest.fn(async (...args) => { await gate; return base(...args); });
  return () => release();
}

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

  test.each(['loadTechStartPoints', 'ownHoldIds'])('a setup read (%s) that never answers ends the check at its budget, and frees its slot after lingerMs', async (name) => {
    const logger = require('../services/logger');
    logger.warn.mockClear();
    const deps = makeDeps();
    deps[name] = jest.fn(() => new Promise(() => {}));
    const started = Date.now();
    const { report, inserted } = await check({ deps, budgetMs: 40, lingerMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(report.timedOut).toBe(true);
    expect(report.passed).toEqual([]);
    expect(inserted).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('a read was still running 50 ms after the check ended'));
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
    // No cap is applied to a candidate; the only call is the sooner pass's log of the base cap, with no arguments.
    expect(deps.customerMaxDetourMinutes.mock.calls.every((args) => args.length === 0)).toBe(true);
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

describe('the 2-hour move (owner 2026-11-07 "B": a moved visit may shift up to 2 hours, not 1)', () => {
  const { buildChain, shiftsFor, MAX_SHIFT_MIN } = _internals;
  // Room after the chain: A (confirmed) 8, B 9, C 10, nothing 11 AM-2 PM, E 2 PM, F 3 PM. Nobody was told an hour.
  const roomyDay = () => [
    stop('a', 8, 10, { customer_confirmed: true }), stop('b', 9, 20), stop('c', 10, 30), stop('e', 14, 50), stop('f', 15, 60),
  ];
  const ROOMY_FREE = [{ date: DAY, windowStart: '12:00', techId: TECH }];
  // The page's travel gap as the 11-06 dry run saw it: a stop moved 1 hour starts when the new visit ends, so there is
  // no time to drive; 2 hours later there is.
  const noTimeToDrive = async (_slot, shifted) => ([...shifted.values()].every((m) => m >= 120) ? true : 'page_collision');
  const shiftsAt = (placement, start) => placement.mock.calls.filter(([s]) => s.windowStart === start).map(([, shifted]) => [...shifted.values()]);

  test('a visit up to 60 minutes tries 1 hour, then 2 hours; a longer visit keeps its own whole hours only', () => {
    expect(MAX_SHIFT_MIN).toBe(120);
    expect(shiftsFor(30)).toEqual([60, 120]);
    expect(shiftsFor(60)).toEqual([60, 120]);
    expect(shiftsFor(90)).toEqual([120]);
    expect(shiftsFor(150)).toEqual([180]);
  });

  test('a 2-hour chain moves each stop 2 hours and must still end by the day close', () => {
    const own = roomyDay();
    const chain = buildChain(own, { startMin: 9 * 60, durationMin: 60, closeMin: 17 * 60, shiftMin: 120 });
    expect(chain.moves.map((m) => [m.row.id, m.toMin / 60])).toEqual([['visit-b', 11], ['visit-c', 12]]);
    expect(buildChain(own, { startMin: 14 * 60, durationMin: 60, closeMin: 17 * 60, shiftMin: 120 })).toEqual({ reason: 'past_day_close' });
  });

  test('when the 1-hour move leaves no time to drive, the same hour is checked with the 2-hour move and found', async () => {
    const placement = jest.fn(noTimeToDrive);
    const { report, inserted, deps } = await check({ deps: makeDeps({ rows: roomyDay(), told: [] }), pool: ROOMY_FREE, placement });
    const nine = report.passed.find((p) => p.start === '09:00');
    expect(nine).toMatchObject({ shiftMin: 120, savingMin: 16 });
    expect(moves(nine)).toEqual(['visit-b 09:00->11:00', 'visit-c 10:00->12:00']);
    // The page judged 9 AM twice: the 1-hour move, then the 2-hour one.
    expect(shiftsAt(placement, '09:00')).toEqual([[60, 60], [120, 120]]);
    // The route check ran on the 2-hour day.
    const routes = deps.evaluated.filter((e) => e.placement.windowStart === '09:00');
    expect(routes).toHaveLength(1);
    expect(routes[0].context.rows.find((r) => r.id === 'visit-b').window_start).toBe('11:00');
    // 8 AM tries 2 hours too (its confirmed stop A is a full-day fact, read after the page's rules) and then fails on A.
    expect(report.twoHourTried).toBe(3);
    expect(report.byReason).toEqual({ fixed_customer_confirmed: 1, saving_below_bar: 2 });
    const logged = JSON.parse(inserted[0].report);
    expect(logged.twoHourTried).toBe(3);
    expect(logged.passed.map((p) => p.shiftMin)).toEqual([120, 120]);
  });

  test('a 1-hour move that passes stays 1 hour: the 2-hour move is never checked', async () => {
    const placement = jest.fn(PAGE_PLACES);
    const { report } = await check({ deps: makeDeps({ rows: roomyDay(), told: [] }), pool: ROOMY_FREE, placement });
    expect(report.passed.find((p) => p.start === '09:00')).toMatchObject({ shiftMin: 60 });
    expect(report.twoHourTried).toBe(0);
    expect(placement.mock.calls.every(([, shifted]) => [...shifted.values()].every((m) => m === 60))).toBe(true);
  });

  test('a moved stop\'s own facts are the same for any shift: no 2-hour check after them', async () => {
    const prefs = { 'cust-b': { smsEnabled: false, serviceReminder72h: true, serviceReminder24h: true } };
    const placement = jest.fn(PAGE_PLACES);
    const { report } = await check({ deps: makeDeps({ rows: roomyDay(), told: [], prefs }), pool: ROOMY_FREE, placement });
    expect(starts(report)).not.toContain('09:00');
    expect(report.byReason.reminders_off).toBe(1);
    expect(report.twoHourTried).toBe(0);
    expect(shiftsAt(placement, '09:00')).toEqual([[60, 60]]);
  });

  test('when the 1-hour move lands on a visit that needs no read, the 2-hour move goes on alone', async () => {
    // An unassigned visit holds 10-11 AM: B moved 1 hour would land on it; B moved 2 hours does not.
    const rows = [stop('a', 8, 10, { customer_confirmed: true }), stop('b', 9, 20), stop('u', 10, 70, { technician_id: null }), stop('e', 14, 50), stop('f', 15, 60)];
    const placement = jest.fn(PAGE_PLACES);
    const { report } = await check({ deps: makeDeps({ rows, told: [] }), pool: [{ date: DAY, windowStart: '16:00', techId: TECH }], placement });
    const nine = report.passed.find((p) => p.start === '09:00');
    expect(nine).toMatchObject({ shiftMin: 120 });
    expect(moves(nine)).toEqual(['visit-b 09:00->11:00']);
    expect(shiftsAt(placement, '09:00')).toEqual([[120]]);
    expect(report.twoHourTried).toBe(0);
  });

  test('a visit longer than 60 minutes has one shift: no 2-hour retry', async () => {
    const placement = jest.fn(async () => 'page_collision');
    const { report } = await check({ deps: makeDeps({ rows: roomyDay(), told: [] }), pool: ROOMY_FREE, placement, durationMinutes: 90 });
    expect(report.passed).toEqual([]);
    expect(report.twoHourTried).toBe(0);
    expect(placement.mock.calls.every(([, shifted]) => [...shifted.values()].every((m) => m === 120))).toBe(true);
  });

  test('when both moves fail, the hour counts once, with the 2-hour move\'s reason', async () => {
    const placement = jest.fn(async (_slot, shifted) => ([...shifted.values()].every((m) => m >= 120) ? 'service_line' : 'page_collision'));
    const { report } = await check({ deps: makeDeps({ rows: roomyDay(), told: [] }), pool: ROOMY_FREE, placement });
    expect(report.passed).toEqual([]);
    expect(report.twoHourTried).toBe(3);
    expect(report.byReason.service_line).toBe(3);
    expect(report.byReason.page_collision).toBeUndefined();
    expect(report.checked).toBe(3);
  });
});

describe('the time budget (Codex round 5: a lost race never cancels a read already sent)', () => {
  test.each([
    ['an open-day read (assignableTechIds)', 'assignableTechIds', ['getBlackoutDates', 'absentTechDays', 'loadBlocks']],
    ['a full-check read (loadBlocks)', 'loadBlocks', ['placement', 'loadArrivalRouteContext', 'loadDayContext', 'getReminderPrefs', 'loadPref']],
    ['a moved stop\'s reminder settings (getReminderPrefs)', 'getReminderPrefs', ['resolve72hChannel', 'appDeviceStatus', 'loadPref']],
  ])('%s outlasts the budget: the check sends no later read, and returns only once that read answers', async (_label, slow, later) => {
    const deps = makeDeps();
    const release = holdRead(deps, slow);
    const placement = jest.fn(PAGE_PLACES);
    const reads = { ...deps, placement };
    const { conn, inserted } = fakeConn();
    let returned = false;
    const run = check({ deps, placement, conn, budgetMs: 150, lingerMs: 5000 }).then((result) => { returned = true; return result; });
    await until(() => inserted.length === 1);
    expect(deps[slow]).toHaveBeenCalledTimes(1);
    expect(JSON.parse(inserted[0].report).timedOut).toBe(true);
    // The check is over and its row is written; it still waits for the read it sent.
    await sleep(30);
    expect(returned).toBe(false);
    release();
    const { report } = await run;
    expect(report.timedOut).toBe(true);
    expect(deps[slow]).toHaveBeenCalledTimes(1);
    for (const name of later) expect(reads[name]).not.toHaveBeenCalled();
  });

  test('a spent budget starts no step and has nothing to wait for', async () => {
    const budget = _internals.makeBudget(Date.now() - 1);
    const start = jest.fn(async () => 'read');
    await expect(budget.race(start)).resolves.toBe(_internals.TIMED_OUT);
    expect(start).not.toHaveBeenCalled();
    await expect(budget.settledWithin(10)).resolves.toBe(true);
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

  test('a check that ran out of time keeps its slot until the read it already sent answers', async () => {
    const slow = makeDeps();
    const release = holdRead(slow, 'loadBlocks');
    const { conn, inserted } = fakeConn();
    const run = startBackgroundCheck({ ...args('est-slow', slow), conn, budgetMs: 100, lingerMs: 60000 });
    await until(() => inserted.length === 1);
    // Its row is written, but its read is still out: its slot stays taken, so the other slots fill and the next
    // request is dropped.
    const held = Array.from({ length: MAX_IN_FLIGHT - 1 }, () => heldDeps());
    const runs = held.map((h, i) => startBackgroundCheck(args(`est-${i}`, h.deps)));
    const extra = makeDeps();
    await expect(startBackgroundCheck(args('est-extra', extra))).resolves.toBeNull();
    expect(extra.loadTechStartPoints).not.toHaveBeenCalled();
    release();
    await expect(run).resolves.toMatchObject({ timedOut: true });
    held.forEach((h) => h.release());
    await Promise.all(runs);
    await expect(startBackgroundCheck(args('est-extra', extra))).resolves.toMatchObject({ mode: 'shadow' });
  });

  test('one estimate gets at most one check per DEDUPE_MS', async () => {
    const t0 = Date.now();
    await expect(startBackgroundCheck(args('est-1', makeDeps()), { nowMs: t0 })).resolves.toMatchObject({ mode: 'shadow' });
    await expect(startBackgroundCheck(args('est-1', makeDeps()), { nowMs: t0 + 1000 })).resolves.toBeNull();
    await expect(startBackgroundCheck(args('est-1', makeDeps()), { nowMs: t0 + DEDUPE_MS })).resolves.toMatchObject({ mode: 'shadow' });
  });
});

/**
 * The sooner-day pass (report.sooner, log only): the same hours on days BEFORE the first day of the customer's list,
 * with the saving bar swapped for the self-serve drive cap. The example day (DAY) is the sooner day; the list's only
 * free time is the day after.
 */
describe('the sooner-day pass (log only)', () => {
  const LATER = '2097-06-11';
  const LATER_POOL = [{ date: LATER, windowStart: '12:00', techId: TECH }];
  const sooner = (opts = {}) => check({ pool: LATER_POOL, dateTo: LATER, ...opts });
  const soonerStarts = (report) => report.sooner.passed.map((p) => `${p.date} ${p.start}`);
  // The hours the page's placement rules were asked about, first asked first.
  // A second sooner day: two stops, at 9 AM and 12 PM.
  const daySoon = (date, tag) => [stop(`p${tag}`, 9, 20, { scheduled_date: date }), stop(`q${tag}`, 12, 30, { scheduled_date: date })];

  test('firstFreeDay is the earliest date in the list; only days loaded before it are scanned', async () => {
    const deps = makeDeps();
    const { report } = await sooner({ deps });
    expect(report.sooner).toMatchObject({ firstFreeDay: LATER, daysBefore: 1, capMin: 30, timedOut: false });
    expect(soonerStarts(report)).toContain(`${DAY} 09:00`);
    // Only the request's dates and the list's dates were read: no extra day.
    expect(deps.loadDayStops.mock.calls.map(([, date]) => date).sort()).toEqual([DAY, LATER]);
    expect(report.sooner.candidates).toBeGreaterThan(0);
  });

  test('a free time on the first loaded day leaves no day before it: the pass finds nothing', async () => {
    const { report } = await check({ pool: [...FREE, ...LATER_POOL], dateTo: LATER });
    expect(report.sooner).toMatchObject({ firstFreeDay: DAY, daysBefore: 0, tried: 0, candidates: 0, checked: 0, passed: [] });
  });

  test('an empty list scans every loaded day, and daysGained is null', async () => {
    const { report } = await check({ pool: [], dateTo: LATER });
    expect(report.sooner).toMatchObject({ firstFreeDay: null, daysBefore: 2 });
    expect(report.sooner.passed.length).toBeGreaterThan(0);
    expect(report.sooner.passed.every((p) => p.daysGained === null)).toBe(true);
  });

  test('daysGained is the whole days from the hour to the first free day', async () => {
    const { report } = await check({ pool: [{ date: '2097-06-13', windowStart: '12:00', techId: TECH }], dateTo: '2097-06-13' });
    expect(report.sooner.firstFreeDay).toBe('2097-06-13');
    expect(report.sooner.daysBefore).toBe(3);
    expect(report.sooner.passed.find((p) => p.date === DAY && p.start === '09:00')).toMatchObject({ daysGained: 3, shiftMin: 60 });
    const { report: next } = await sooner();
    expect(next.sooner.passed.find((p) => p.start === '09:00').daysGained).toBe(1);
  });

  test('an hour that adds more drive than the self-serve cap is over_drive_cap; the saving bar does not apply', async () => {
    const capped = await sooner({ deps: Object.assign(makeDeps(), { customerMaxDetourMinutes: jest.fn(() => 4) }) });
    expect(capped.report.sooner.passed).toEqual([]);
    expect(capped.report.sooner.byReason.over_drive_cap).toBeGreaterThanOrEqual(1);
    // 9 AM adds 5 drive minutes: over a cap of 4, under a cap of 5. Its saving over the best free time is only logged.
    const open = await sooner({ deps: Object.assign(makeDeps(), { customerMaxDetourMinutes: jest.fn(() => 5) }) });
    expect(open.report.sooner.passed.find((p) => p.start === '09:00')).toMatchObject({ detourMin: 5 });
    expect(open.report.sooner.passed.every((p) => p.savingMin != null)).toBe(true);
    expect(open.report.sooner.byReason.saving_below_bar).toBeUndefined();
  });

  test('the cap is loaded with capacity mode off, while the offer rule\'s own cap stays off', async () => {
    const deps = makeDeps();
    deps.zoneRouteDaysLive = () => true;
    const { report } = await sooner({ deps, zoneSlug: 'venice' });
    // The sooner pass used the cap, with the zone lift, and read the zone route days once.
    expect(deps.customerMaxDetourMinutes).toHaveBeenCalledWith({ date: DAY, technicianId: TECH, zoneSlug: 'venice', zoneRouteDays: { synthetic: true } });
    expect(deps.readZoneRouteDays).toHaveBeenCalledTimes(1);
    // The route check still has no cap (its detour of 20 is over the cap of 15 below) because capacity mode is off.
    const off = makeDeps();
    off.customerMaxDetourMinutes = jest.fn(() => 15);
    const free = await sooner({ deps: off });
    expect(soonerStarts(free.report)).toContain(`${DAY} 09:00`);
    expect(free.report.sooner.byReason.detour_cap).toBeUndefined();
    // Capacity mode on: the same cap also refuses the route's 20 drive minutes, and the zone days are still read once.
    const on = makeDeps();
    on.capacityOn = () => true;
    on.customerMaxDetourMinutes = jest.fn(() => 15);
    const capped = await sooner({ deps: on });
    expect(soonerStarts(capped.report)).not.toContain(`${DAY} 09:00`);
    expect(capped.report.sooner.byReason.detour_cap).toBeGreaterThanOrEqual(1);
    expect(report.sooner.passed.length).toBeGreaterThan(0);
  });

  test('capacity mode on with the zone lift reads the zone route days once for both passes', async () => {
    const deps = makeDeps();
    deps.capacityOn = () => true;
    deps.zoneRouteDaysLive = () => true;
    await sooner({ deps, zoneSlug: 'venice' });
    expect(deps.readZoneRouteDays).toHaveBeenCalledTimes(1);
  });

  describe('the travel-gap screen', () => {
    // A scripted travel rule, by the candidate's start hour: the mapping from a conflict to overlap / gap_before /
    // gap_after is what is tested, not the drive model.
    const script = (byStart) => jest.fn((candidate, stops) => {
      const verdict = byStart[candidate.startMin / 60];
      if (!verdict) return [];
      const before = { startMin: candidate.startMin - 120, endMin: candidate.startMin - 60 };
      const after = { startMin: candidate.endMin + 30, endMin: candidate.endMin + 90 };
      if (verdict === 'overlap') return [{ stop: stops[0], reason: 'overlap' }];
      return [{ stop: verdict === 'gap_before' ? before : after, reason: 'travel_gap' }];
    });
    const screened = (byStart, extra = {}) => {
      const deps = makeDeps({ travelGap: true });
      deps.travelGapConflicts = script(byStart);
      return sooner({ deps, ...extra });
    };

    test('each candidate gets a predicted pass, overlap, gap_before or gap_after, counted in the report', async () => {
      const { report } = await screened({ 9: 'overlap', 10: 'gap_before', 11: 'gap_after' });
      expect(report.sooner.screenOn).toBe(true);
      expect(report.sooner.screen).toMatchObject({ overlap: 1, gap_before: 1, gap_after: 1 });
      expect(report.sooner.screen.pass).toBe(report.sooner.candidates - 3);
    });

    test('hours expected to pass are checked first, then the earliest date and hour; the screen never drops a candidate', async () => {
      const rows = [...exampleDay(), ...daySoon(LATER, 'x')];
      const placement = jest.fn(PAGE_PLACES);
      const deps = makeDeps({ rows, travelGap: true });
      // 9 AM is expected to fail on both days; every other hour passes the screen.
      deps.travelGapConflicts = script({ 9: 'overlap' });
      const { report } = await check({ deps, placement, admit: () => true, pool: [{ date: '2097-06-12', windowStart: '12:00', techId: TECH }], dateTo: '2097-06-12' });
      // The sooner pass runs after the saving pass, so its full checks are the last placement calls (every hour places
      // here, so each check asks once). Raw calls, not unique hours: the saving pass asked
      // some of the same hours first.
      const order = placement.mock.calls.map(([slot]) => `${slot.date} ${slot.windowStart}`).slice(-report.sooner.checked);
      // Expected passes first, the earliest date and hour first (DAY's 8 AM, 10 AM, ..., then LATER's 12 PM), then the
      // expected failures in the same order.
      expect(order[0]).toBe(`${DAY} 08:00`);
      expect(order.slice(-3)).toEqual([`${LATER} 12:00`, `${DAY} 09:00`, `${LATER} 09:00`]);
      expect(order.slice(0, -3).every((h) => h.startsWith(DAY))).toBe(true);
      expect(report.sooner.checked).toBe(report.sooner.candidates);
      expect(soonerStarts(report)).toContain(`${DAY} 09:00`);
    });

    test('when every hour is expected to fail, all are still checked and the misses are counted', async () => {
      const everyHour = Object.fromEntries([8, 9, 10, 11, 12, 13, 14, 15].map((h) => [h, 'gap_after']));
      const { report } = await screened(everyHour);
      expect(report.sooner.screen.pass).toBe(0);
      expect(report.sooner.checked).toBe(Math.min(report.sooner.candidates, 24));
      expect(report.sooner.passed.length).toBeGreaterThan(0);
      expect(report.sooner.screenWrong.saidFail_passed).toBe(report.sooner.passed.length);
      expect(report.sooner.screenWrong.saidPass_failed).toBe(0);
    });

    test('an hour expected to pass that fails its full check is counted as saidPass_failed', async () => {
      const deps = makeDeps({ travelGap: true });
      deps.travelGapConflicts = script({});
      const { report } = await sooner({ deps, placement: async (slot) => (slot.date === DAY && slot.windowStart === '09:00' ? 'page_collision' : true) });
      expect(report.sooner.byReason.page_collision).toBe(1);
      // Every checked hour that did not pass was expected to.
      expect(report.sooner.screenWrong).toEqual({ saidPass_failed: report.sooner.checked - report.sooner.passed.length, saidFail_passed: 0 });
      expect(report.sooner.screenWrong.saidPass_failed).toBeGreaterThanOrEqual(1);
    });

    test('capacity mode on: no screen, as the page skips its travel rule there', async () => {
      const deps = makeDeps({ travelGap: true });
      deps.capacityOn = () => true;
      const { report } = await sooner({ deps });
      expect(report.sooner.screenOn).toBe(false);
      expect(deps.travelGapConflicts).not.toHaveBeenCalled();
      expect(report.sooner.screen).toEqual({ pass: 0, overlap: 0, gap_before: 0, gap_after: 0 });
    });

    test('an hour passes the screen when either its 1-hour or its 2-hour shift does', async () => {
      const rows = [stop('a', 8, 10, { customer_confirmed: true }), stop('b', 9, 20), stop('c', 10, 30), stop('e', 14, 50), stop('f', 15, 60)];
      const deps = makeDeps({ rows, told: [], travelGap: true });
      // 9 AM: the 1-hour shift (B to 10, C to 11) is expected to fail; the 2-hour shift (C to 12) is expected to pass.
      deps.travelGapConflicts = jest.fn((candidate, stops) => {
        const twoHour = stops.some((s) => s.startMin === 12 * 60);
        return candidate.startMin === 9 * 60 && !twoHour ? [{ stop: stops[0], reason: 'overlap' }] : [];
      });
      const { report } = await sooner({ deps });
      const calls = deps.travelGapConflicts.mock.calls.filter(([candidate]) => candidate.startMin === 9 * 60);
      expect(calls).toHaveLength(2);
      expect(report.sooner.screen.overlap).toBe(0);
    });

    test('the page\'s stop entities: moved stops at their new times, holds, expected minutes, the new visit\'s own credit', async () => {
      const rows = [...exampleDay(), stop('h', 15, 70, { id: 'live-hold', customer_id: null, reservation_expires_at: new Date('2097-06-09T05:15:00Z') })];
      const deps = makeDeps({ rows, travelGap: true });
      deps.stopExpectedMinutesSync = jest.fn(() => 25);
      const { report } = await sooner({ deps, candidateExpectedMinutes: 40 });
      expect(report.sooner.screenOn).toBe(true);
      const [candidate, stops] = deps.travelGapConflicts.mock.calls.find(([c]) => c.startMin === 9 * 60);
      expect(candidate).toEqual({ startMin: 540, endMin: 600, lat: NEW_PIN.lat, lng: NEW_PIN.lng, windowMinutes: 60, expectedMinutes: 40 });
      const byId = (id) => stops.find((s) => s.lat === 10 && s.technicianId === TECH && rows.find((r) => r.id === id).lng === s.lng);
      // B, C and D moved 1 hour; A, E and F stayed.
      expect([byId('visit-a'), byId('visit-b'), byId('visit-c'), byId('visit-d'), byId('visit-e')].map((s) => [s.startMin / 60, s.endMin / 60]))
        .toEqual([[8, 9], [10, 11], [11, 12], [12, 13], [13, 14]]);
      expect(byId('visit-b')).toMatchObject({ windowMinutes: 60, expectedMinutes: 25, hold: false });
      expect(stops.find((s) => s.lng === 70)).toMatchObject({ hold: true });
      // Without an expected minutes figure, the new visit credits nothing.
      await sooner({ deps, candidateExpectedMinutes: null });
      const last = deps.travelGapConflicts.mock.calls.filter(([c]) => c.startMin === 9 * 60).pop()[0];
      expect(last.expectedMinutes).toBe(60);
    });

    test('with multi-tech confirm on, only the candidate technician\'s rows and the unassigned ones count; off, every row', async () => {
      const rows = [...exampleDay(), stop('o', 15, 80, { technician_id: 'tech-2' }), stop('u', 16, 90, { technician_id: null })];
      const lngsSeen = async (multiTech) => {
        const deps = makeDeps({ rows, travelGap: true, multiTech });
        await sooner({ deps });
        return deps.travelGapConflicts.mock.calls[0][1].map((s) => s.lng).sort((a, b) => a - b);
      };
      expect(await lngsSeen(false)).toContain(80);
      const scoped = await lngsSeen(true);
      expect(scoped).not.toContain(80);
      expect(scoped).toContain(90);
    });

    test('the catalog is loaded before the screen reads expected minutes', async () => {
      const deps = makeDeps({ travelGap: true });
      await sooner({ deps });
      expect(deps.ensureCatalogLoaded).toHaveBeenCalledTimes(1);
    });
  });

  test('with the travel-gap gate off there is no screen: nothing is asked, the counts stay zero', async () => {
    const deps = makeDeps({ travelGap: false });
    const { report } = await sooner({ deps });
    expect(deps.travelGapConflicts).not.toHaveBeenCalled();
    expect(deps.ensureCatalogLoaded).not.toHaveBeenCalled();
    expect(report.sooner).toMatchObject({ screenOn: false, screen: { pass: 0, overlap: 0, gap_before: 0, gap_after: 0 }, screenWrong: { saidPass_failed: 0, saidFail_passed: 0 } });
    expect(report.sooner.passed.length).toBeGreaterThan(0);
  });

  test('at most MAX_SOONER_CHECKS sooner hours get a full check', async () => {
    const { MAX_SOONER_CHECKS } = _internals;
    expect(MAX_SOONER_CHECKS).toBe(24);
    // 13 days with two stops each: 26 hours.
    const dates = Array.from({ length: 13 }, (_, i) => `2097-06-${String(10 + i).padStart(2, '0')}`);
    const rows = dates.flatMap((date, i) => daySoon(date, i));
    const { report } = await check({
      deps: makeDeps({ rows, told: [] }), pool: [{ date: '2097-06-23', windowStart: '12:00', techId: TECH }], dateTo: '2097-06-23', admit: () => true,
    });
    expect(report.sooner.candidates).toBe(26);
    expect(report.sooner.checked).toBe(MAX_SOONER_CHECKS);
    expect(report.sooner.passed).toHaveLength(MAX_SOONER_CHECKS);
    // The offer rule's own limit is unchanged.
    expect(report.checked).toBeLessThanOrEqual(_internals.MAX_FULL_CHECKS);
  });

  test('the offer rule\'s report is the same with or without the sooner pass finding hours', async () => {
    const strip = ({ sooner: _sooner, ms: _ms, ...rest }) => rest;
    const withHours = await sooner({ deps: makeDeps() });
    const without = await sooner({ deps: Object.assign(makeDeps(), { customerMaxDetourMinutes: jest.fn(() => -1) }) });
    expect(withHours.report.sooner.passed.length).toBeGreaterThan(0);
    expect(without.report.sooner.passed).toEqual([]);
    expect(without.report.sooner.byReason.over_drive_cap).toBeGreaterThanOrEqual(1);
    expect(strip(withHours.report)).toEqual(strip(without.report));
    expect(withHours.inserted[0]).toMatchObject({ fired: without.inserted[0].fired, best_saving_min: without.inserted[0].best_saving_min, moved_count: without.inserted[0].moved_count });
  });

  test('both passes share the reads: a day or a block read for the sooner pass is not read again', async () => {
    const deps = makeDeps();
    await check({ deps, pool: [], dateTo: DAY });
    // Every candidate of the sooner pass is also one of the offer rule's, on one day and one technician.
    expect(deps.loadBlocks).toHaveBeenCalledTimes(1);
    expect(deps.loadDayContext).toHaveBeenCalledTimes(1);
  });

  test('a sooner pass that runs out of time says so; the check still records its row', async () => {
    const { report, inserted } = await sooner({ placement: () => new Promise(() => {}), budgetMs: 60, lingerMs: 20 });
    expect(report.sooner.timedOut).toBe(true);
    expect(report.sooner.checked).toBe(0);
    expect(report.timedOut).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(JSON.parse(inserted[0].report).sooner.timedOut).toBe(true);
  });

  test('the sooner part of the log line: first free day, checked, passed, best hour, days gained and detour', async () => {
    const logger = require('../services/logger');
    logger.info.mockClear();
    await sooner();
    const line = logger.info.mock.calls.map(([text]) => text).find((text) => text.includes('[booking-make-room]'));
    expect(line).toContain(`sooner_first_free=${LATER}`);
    expect(line).toMatch(/sooner_checked=\d+ sooner_passed=[1-9]\d*/);
    expect(line).toContain(`sooner_best=${DAY} 08:00`.replace('08:00', '09:00') + ' +60');
    expect(line).toContain('sooner_days_gained=1');
    expect(line).toContain('sooner_detour=5');
  });
});

/**
 * Mode on (owner 2026-11-09 "YES"): the sooner rule is the offer rule. findMakeRoomOffers runs the sooner pass now,
 * for the page; verifyMakeRoomHour proves one hour again inside the hold's transaction; a stop moves at most once.
 */
describe('findMakeRoomOffers (the page awaits it, mode on)', () => {
  const { findMakeRoomOffers } = require('../services/scheduling/booking-make-room');
  const { resetBackgroundChecks, MAX_OFFERS_IN_FLIGHT } = _internals;
  const LATER = '2097-06-11';
  const LATER_POOL = [{ date: LATER, windowStart: '12:00', techId: TECH }];
  beforeEach(() => resetBackgroundChecks());

  async function offers({ deps = makeDeps(), pool = LATER_POOL, ...extra } = {}) {
    const { conn, inserted } = fakeConn();
    const found = await findMakeRoomOffers({
      estimateId: 'est-1', pool, coords: NEW_PIN, durationMinutes: 60, dateFrom: DAY, dateTo: LATER,
      admit: (slot) => slot.date === DAY, placement: PAGE_PLACES, now: NOW, conn, deps, ...extra,
    });
    return { ...found, inserted, deps };
  }

  test('returns the earliest passing hour on a day before the list\'s first free day, and stops at the first pass', async () => {
    const { hours, report, deps } = await offers();
    expect(hours.map((h) => `${h.date} ${h.start}`)).toEqual([`${DAY} 09:00`]);
    expect(hours[0]).toMatchObject({ techId: TECH, shiftMin: 60 });
    // 8 AM (stop A, confirmed) fails its full check; 9 AM passes: the walk ends there and never checks 10 AM or later.
    expect(report.sooner.checked).toBe(2);
    expect(report.mode).toBe('on');
  });

  test('the saving pass does not run, and no travel-gap screen is asked', async () => {
    const deps = makeDeps({ travelGap: true });
    const { report } = await offers({ deps });
    expect(report).toMatchObject({ offerOnly: true, candidates: 0, checked: 0, tried: 0 });
    expect(report.sooner.screenOn).toBe(false);
    expect(deps.travelGapConflicts).not.toHaveBeenCalled();
  });

  test('records the one booking_make_room_checks row, showing the offered hour', async () => {
    const { inserted, hours } = await offers();
    await until(() => inserted.length === 1);
    expect(inserted[0]).toMatchObject({ mode: 'on', surface: 'estimate', estimate_id: 'est-1', fired: true, moved_count: hours.length ? 3 : 0 });
    expect(JSON.parse(inserted[0].report).sooner.passed).toHaveLength(1);
  });

  test('does not wait for the log row', async () => {
    const insertGate = new Promise(() => {});
    const conn = jest.fn(() => ({ insert: jest.fn(() => insertGate) }));
    const started = Date.now();
    const found = await findMakeRoomOffers({
      estimateId: 'est-1', pool: LATER_POOL, coords: NEW_PIN, durationMinutes: 60, dateFrom: DAY, dateTo: LATER,
      admit: (slot) => slot.date === DAY, placement: PAGE_PLACES, now: NOW, conn, deps: makeDeps(),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(found.hours).toHaveLength(1);
  });

  test('no hour passes: no hours, and the row is still recorded', async () => {
    const { hours, inserted } = await offers({ deps: makeDeps({ feasible: false }) });
    expect(hours).toEqual([]);
    await until(() => inserted.length === 1);
    expect(inserted[0].fired).toBe(false);
  });

  test('a time-out before a pass serves no hour', async () => {
    const deps = makeDeps();
    deps.ownHoldIds = jest.fn(() => new Promise(() => {}));
    const started = Date.now();
    const { hours, report } = await offers({ deps, budgetMs: 40, lingerMs: 40 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hours).toEqual([]);
    expect(report.timedOut).toBe(true);
  });

  test('an error serves no hour and never throws', async () => {
    const deps = makeDeps();
    deps.loadDayStops = jest.fn(async () => { throw new Error('read failed'); });
    const { hours, report } = await offers({ deps });
    expect(hours).toEqual([]);
    expect(report.error).toBe('read failed');
  });

  test('no pin: no hour', async () => {
    const { hours, report } = await offers({ coords: null });
    expect(hours).toEqual([]);
    expect(report.skipped).toBe('no_pin');
  });

  test('past MAX_OFFERS_IN_FLIGHT passes at once the page serves the free list', async () => {
    const held = Array.from({ length: MAX_OFFERS_IN_FLIGHT }, () => {
      const deps = makeDeps();
      deps.loadTechStartPoints = jest.fn(() => new Promise(() => {}));
      return offers({ deps, budgetMs: 300, lingerMs: 50 });
    });
    await sleep(20);
    const extra = await offers();
    expect(extra.hours).toEqual([]);
    expect(extra.report).toBeNull();
    await Promise.all(held);
  });

  test('the drive cap decides: 9 AM adds 5 drive minutes, over a cap of 4', async () => {
    const deps = Object.assign(makeDeps(), { customerMaxDetourMinutes: jest.fn(() => 4) });
    const { hours, report } = await offers({ deps });
    expect(hours).toEqual([]);
    expect(report.sooner.byReason.over_drive_cap).toBeGreaterThanOrEqual(1);
  });
});

describe('verifyMakeRoomHour (the hold\'s proof, inside the reserve transaction)', () => {
  const { verifyMakeRoomHour } = require('../services/scheduling/booking-make-room');
  const prove = (extra = {}) => verifyMakeRoomHour({
    conn: jest.fn(), date: DAY, startMin: 9 * 60, techId: TECH, durationMinutes: 60, point: NEW_PIN, estimateId: 'est-1',
    admit: (slot) => slot.date === DAY, placement: PAGE_PLACES, now: NOW, deps: makeDeps(), ...extra,
  });

  test('rebuilds the chain for that exact hour: B, C and D move 1 hour, with their widths', async () => {
    const proof = await prove();
    expect(proof.shiftMin).toBe(60);
    expect(proof.moves).toEqual([
      { id: 'visit-b', from: '09:00', to: '10:00', widthMin: 60 },
      { id: 'visit-c', from: '10:00', to: '11:00', widthMin: 60 },
      { id: 'visit-d', from: '11:00', to: '12:00', widthMin: 60 },
    ]);
  });

  test('the sooner rule\'s drive cap applies', async () => {
    const proof = await prove({ deps: Object.assign(makeDeps(), { customerMaxDetourMinutes: jest.fn(() => 4) }) });
    expect(proof).toEqual({ reason: 'over_drive_cap' });
  });

  test('applies no saving bar: an hour that saves nothing over the free list still proves', async () => {
    expect(await prove()).toHaveProperty('moves');
  });

  test('an hour no stop starts on any more is refused', async () => {
    expect(await prove({ startMin: 12 * 60 })).toEqual({ reason: 'hour_free' });
    expect(await prove({ startMin: 9 * 60 + 15 })).toEqual({ reason: 'earlier_stop_overlaps' });
  });

  test('a stop that was locked since the offer refuses it', async () => {
    const told = await prove({ deps: makeDeps({ told: ['visit-e', 'visit-c'] }) });
    expect(told.reason).toBe('fixed_time_told');
    const confirmed = await prove({ startMin: 8 * 60 });
    expect(confirmed.reason).toBe('fixed_customer_confirmed');
  });

  test('a stop whose customer turned reminder texts off since the offer refuses it', async () => {
    expect(await prove({ deps: makeDeps({ prefs: { 'cust-c': { ...TEXTS, smsEnabled: false } } }) })).toEqual({ reason: 'reminders_off' });
  });

  test('the page\'s placement rules run on the moved day, with every moved stop shifted', async () => {
    const placement = jest.fn(async () => true);
    await prove({ placement });
    const [slot, shifted] = placement.mock.calls[0];
    expect(slot).toMatchObject({ date: DAY, windowStart: '09:00', techId: TECH });
    expect([...shifted.entries()]).toEqual([['visit-b', 60], ['visit-c', 60], ['visit-d', 60]]);
    expect(await prove({ placement: async () => 'page_collision' })).toEqual({ reason: 'page_collision' });
  });

  test('a closed technician-day, an unreadable day and no technician refuse', async () => {
    expect(await prove({ deps: makeDeps({ absent: [`${TECH}:${DAY}`] }) })).toEqual({ reason: 'tech_day_closed' });
    expect(await prove({ techId: null })).toEqual({ reason: 'no_hour' });
    const deps = makeDeps();
    deps.loadDayStops = jest.fn(async () => { throw new Error('read failed'); });
    expect(await prove({ deps })).toEqual({ reason: 'error' });
  });

  test('a read that never answers refuses at its budget', async () => {
    const deps = makeDeps();
    deps.loadBlocks = jest.fn(() => new Promise(() => {}));
    expect(await prove({ deps, budgetMs: 40 })).toEqual({ reason: 'timed_out' });
  });

  test('this estimate\'s own hold is not a stop', async () => {
    const rows = [...exampleDay(), stop('hold', 9, 25, { id: 'visit-hold', customer_id: null, reservation_expires_at: '2097-06-10T01:00:00Z' })];
    const proof = await prove({ deps: makeDeps({ rows, holdIds: ['visit-hold'] }) });
    expect(proof.moves.map((m) => m.id)).toEqual(['visit-b', 'visit-c', 'visit-d']);
  });
});

describe('one move per stop (owner 2026-11-09)', () => {
  const { verifyMakeRoomHour } = require('../services/scheduling/booking-make-room');
  const withMoved = (ids) => Object.assign(makeDeps(), { makeRoomMovedIds: jest.fn(async () => new Set(ids)) });

  test('a stop make-room already moved is fixed: the hour whose chain holds it is refused', async () => {
    const deps = withMoved(['visit-c']);
    const proof = await verifyMakeRoomHour({
      conn: jest.fn(), date: DAY, startMin: 9 * 60, techId: TECH, durationMinutes: 60, point: NEW_PIN,
      admit: (slot) => slot.date === DAY, placement: PAGE_PLACES, now: NOW, deps,
    });
    expect(proof).toEqual({ reason: 'fixed_make_room_moved' });
  });

  test('the finder counts it with the same reason, reads once per day and not per stop', async () => {
    const deps = withMoved(['visit-c']);
    const { report } = await check({ deps, pool: [{ date: '2097-06-11', windowStart: '12:00', techId: TECH }], dateTo: '2097-06-11' });
    expect(report.sooner.byReason.fixed_make_room_moved).toBeGreaterThanOrEqual(1);
    const days = deps.makeRoomMovedIds.mock.calls.length;
    expect(days).toBe(1);
    expect(deps.makeRoomMovedIds.mock.calls[0][1]).toEqual(expect.arrayContaining(['visit-a', 'visit-b', 'visit-f']));
  });

  test('a moved stop is not retried with a 2-hour shift (same for any shift)', async () => {
    const deps = withMoved(['visit-b']);
    const { report } = await check({ deps });
    expect(report.twoHourTried).toBe(0);
  });

  test('the default reader asks reschedule_log once for the ids, by initiated_by', async () => {
    const calls = [];
    const builder = {
      whereIn: jest.fn((...args) => { calls.push(['whereIn', ...args]); return builder; }),
      where: jest.fn((...args) => { calls.push(['where', ...args]); return builder; }),
      distinct: jest.fn(async (...args) => { calls.push(['distinct', ...args]); return [{ scheduled_service_id: 'visit-c' }]; }),
    };
    const conn = jest.fn((table) => { calls.push(['table', table]); return builder; });
    const ids = await _internals.defaultDeps().makeRoomMovedIds(conn, ['visit-b', 'visit-c']);
    expect([...ids]).toEqual(['visit-c']);
    expect(calls).toEqual([
      ['table', 'reschedule_log'],
      ['whereIn', 'scheduled_service_id', ['visit-b', 'visit-c']],
      ['where', { initiated_by: 'booking_make_room' }],
      ['distinct', 'scheduled_service_id'],
    ]);
    expect([...(await _internals.defaultDeps().makeRoomMovedIds(conn, []))]).toEqual([]);
  });
});
