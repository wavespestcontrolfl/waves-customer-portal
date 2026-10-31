/**
 * Lawn 9x rounds PR 6: the one-time move of current lawn 9x customers onto the rounds
 * (server/services/lawn-rounds-redate.js and scripts/lawn-9x-rounds-redate.js).
 * The planner is pure; the applier runs against a fake connection, a fake rebooker and a fake reminder
 * service, so no database and no message path is touched.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn(async () => new Set()),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
  withCustomerCommsLock: jest.fn(async (conn, id, fn) => fn(conn)),
}));

const redate = require('../services/lawn-rounds-redate');
const seeder = require('../services/recurring-appointment-seeder');
const { dateExceptionStamp, DATE_EXCEPTION_CLEAR } = require('../services/rebooker');
const { parseCliArgs, summarizePlans } = require('../../scripts/lawn-9x-rounds-redate');

const { planSeriesRedate, stayReason, reviewPlan, planAndReview, applySeries, convertSeries } = redate;

// An area day (a Tuesday in round 1). The planner takes the anchor as given (the area module
// validates real ones). The next visit, then a 42-day cadence.
const AREA = '2027-01-12';
const NOW = Date.parse('2026-10-31T12:00:00Z');
const PARENT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const TECH = '33333333-3333-4333-8333-333333333333';

const visit = (id, date, extra = {}) => ({ id, date, ws: '09:00', we: '10:00', dur: 60, tech: TECH, stay: null, prepaid: false, ...extra });
const legacy = () => [
  visit('v1', '2026-11-17'), visit('v2', '2026-12-29'), visit('v3', '2027-02-09'), visit('v4', '2027-03-23'),
];
const series = (visits, extra = {}) => ({ parentId: PARENT, customerId: CUSTOMER, areaAnchor: AREA, areaKey: 'parrish', anchorOverride: null, visits, ...extra });
const targets = (plan) => plan.visits.map((v) => [v.id, v.to]);

describe('planSeriesRedate', () => {
  test('keeps the next visit and moves the later ones to the area day of the following rounds', () => {
    const plan = planSeriesRedate(series(legacy()));
    expect(plan.anchor).toBe(AREA);
    expect(plan.anchorSource).toBe('area');
    expect(targets(plan)).toEqual([['v1', '2026-11-17'], ['v2', '2027-01-12'], ['v3', '2027-02-23'], ['v4', '2027-03-30']]);
    expect(plan.visits[0].kind).toBe('next');
    expect(plan.moves.map((m) => m.shift)).toEqual([14, 14, 7]);
    expect(plan.held).toBeNull();
    expect(plan.flags).toEqual([]);
    expect(plan.oldWeekday).toBe('Tue');
    expect(plan.newWeekday).toBe('Tue');
  });

  test('the first move after the kept visit has no 28-day floor: the area date stands', () => {
    // The next visit sits at the end of its round; the area date of the next round is 14 days away.
    const plan = planSeriesRedate(series([visit('v1', '2027-03-10'), visit('v2', '2027-03-31')], { areaAnchor: '2027-02-10' }));
    expect(plan.visits[1].to).toBe('2027-03-24');
    expect(plan.flags).toContain('short gap');
    expect(plan.held).toBeNull();
  });

  test('with no area the next visit sets its own day and an aligned series needs no move', () => {
    const plan = planSeriesRedate(series(legacy(), { areaAnchor: null, areaKey: null }));
    expect(plan.anchor).toBe('2026-11-17');
    expect(plan.anchorSource).toBe('own');
    expect(plan.moves).toEqual([]);
    expect(plan.flags).toContain('no area');
    expect(plan.visits.every((v) => v.shift === 0)).toBe(true);
  });

  test('an own-day series moves a drifted visit back to the anchor weekday', () => {
    const plan = planSeriesRedate(series([visit('v1', '2026-11-17'), visit('v2', '2026-12-29'), visit('v3', '2027-02-11')], { areaAnchor: null }));
    expect(targets(plan)).toEqual([['v1', '2026-11-17'], ['v2', '2026-12-29'], ['v3', '2027-02-09']]);
    expect(plan.moves.map((m) => [m.id, m.shift])).toEqual([['v3', -2]]);
  });

  test('an owner anchor beats the area anchor', () => {
    const plan = planSeriesRedate(series(legacy(), { anchorOverride: '2027-01-19' }));
    expect(plan.anchorSource).toBe('override');
    expect(plan.visits[1].to).toBe('2027-01-19');
  });

  test('a visit that must stay keeps its date and claims its own round; later visits follow it', () => {
    const rows = [visit('v1', '2026-11-17'), visit('v2', '2026-12-29'), visit('v3', '2027-02-09', { stay: 'confirmed by the customer' }), visit('v4', '2027-03-23')];
    const plan = planSeriesRedate(series(rows));
    expect(targets(plan)).toEqual([['v1', '2026-11-17'], ['v2', '2027-01-12'], ['v3', '2027-02-09'], ['v4', '2027-03-30']]);
    expect(plan.visits[2]).toMatchObject({ kind: 'keep', reason: 'confirmed by the customer' });
    expect(plan.held).toBeNull();
  });

  test('a kept visit whose round is not after the previous round holds the whole series: round conflict', () => {
    const rows = [visit('v1', '2026-11-17'), visit('v2', '2026-12-29'), visit('v3', '2027-01-05', { stay: 'reminder already sent' })];
    const plan = planSeriesRedate(series(rows));
    expect(plan.heldReasons).toEqual(['round conflict']);
    expect(plan.held).toBe('round conflict');
  });

  test('an area plan over the limit falls back to the own weekday when that fits: area day too far', () => {
    // The area day needs 14-day moves; the customer's own weekday is already on the rounds.
    const plan = planSeriesRedate(series(legacy()), { maxShiftDays: 7 });
    expect(plan).toMatchObject({ held: null, anchorSource: 'own', anchor: '2026-11-17', areaKey: 'parrish', moves: [] });
    expect(plan.flags).toContain('area day too far');
    expect(plan.flags).not.toContain('no area');
  });

  test('a move over the limit holds the series unless that series is allowed (own day too)', () => {
    // v3 sits 11 days off its own-day round date (2027-02-09), and the area day is further still.
    const drifted = [visit('v1', '2026-11-17'), visit('v2', '2026-12-29'), visit('v3', '2027-02-20')];
    const own = planSeriesRedate(series(drifted, { areaAnchor: null, areaKey: null }), { maxShiftDays: 7 });
    expect(own.held).toBe('shift over 7 days');
    expect(own.flags).toEqual(expect.arrayContaining(['long shift', 'no area']));
    const area = planSeriesRedate(series(drifted), { maxShiftDays: 7 });
    expect(area).toMatchObject({ held: 'shift over 7 days', anchorSource: 'area' });
    const allowed = planSeriesRedate(series(drifted), { maxShiftDays: 7, allowLongShift: true });
    expect(allowed).toMatchObject({ held: null, anchorSource: 'area' });
    expect(allowed.flags).toContain('long shift');
  });

  test('a Saturday or Sunday anchor is flagged and does not hold', () => {
    const plan = planSeriesRedate(series([visit('v1', '2026-11-21'), visit('v2', '2027-01-02')], { areaAnchor: null }));
    expect(plan.flags).toContain('weekend day');
    expect(plan.held).toBeNull();
  });

  test('a prepaid visit that would leave its term holds the series: outside prepaid term; inside it only flags', () => {
    // v2 moves from 2026-12-29 to the next round's area day, 2027-01-12.
    const rows = [visit('v1', '2026-11-17'), visit('v2', '2026-12-29', { prepaid: true, termId: 't1' })];
    const termEnding = (end) => series(rows, { terms: { t1: { start: '2026-01-01', end } } });
    expect(planSeriesRedate(termEnding('2027-01-11')).held).toBe('outside prepaid term');
    expect(planSeriesRedate(termEnding('2027-01-12'))).toMatchObject({ held: null, flags: expect.arrayContaining(['prepaid']) });
    // A term that could not be read holds too (fail closed).
    expect(planSeriesRedate(series(rows)).held).toBe('outside prepaid term');
  });

  test('a prepaid visit flags the series', () => {
    const plan = planSeriesRedate(series([visit('v1', '2026-11-17'), visit('v2', '2026-12-29', { prepaid: true })]));
    expect(plan.flags).toContain('prepaid');
  });

  test('an untimed visit moves by date only (auto-dispatch times it): no hold', () => {
    const plan = planSeriesRedate(series([visit('v1', '2026-11-17'), visit('v2', '2026-12-29', { ws: null, we: null })]));
    expect(plan.held).toBeNull();
    expect(plan.moves).toEqual([expect.objectContaining({ id: 'v2', to: '2027-01-12', ws: null })]);
  });

  test('planning again after the moves landed plans nothing', () => {
    const first = planSeriesRedate(series(legacy()));
    const moved = first.visits.map((v) => visit(v.id, v.to));
    const second = planSeriesRedate(series(moved));
    expect(second.moves).toEqual([]);
    expect(second.visits.map((v) => v.kind)).toEqual(['next', 'at-target', 'at-target', 'at-target']);
    expect(second.signature).toBe(planSeriesRedate(series(moved)).signature);
  });
});

describe('stayReason (the 10-08 rule)', () => {
  const base = { d: '2026-12-29', ws: '09:00', r72: false, r24: false };
  test.each([
    ['confirmed by the customer', { customer_confirmed: true }],
    ['locked by staff', { auto_dispatch_locked: true }],
    ['locked by staff', { auto_dispatch_excluded: true }],
    ['reminder already sent', { r72: true }],
    ['reminder already sent', { r24: true }],
    ['time chosen by the customer', { last_mover: 'customer_self_serve' }],
    ['time chosen by the customer', { date_exception_source: 'customer_sms' }],
    ['part of a grouped stop', { group_mates: 1 }],
  ])('%s', (reason, extra) => {
    expect(stayReason({ ...base, ...extra }, NOW)).toBe(reason);
  });

  test('a pre-closed placeholder reminder is not a sent reminder', () => {
    expect(stayReason({ ...base, r72: true, r_preclosed: true }, NOW)).toBeNull();
    expect(stayReason({ ...base, r72: true, r_cancelled: true }, NOW)).toBeNull();
  });

  test('a visit inside 73 hours stays; one just outside does not', () => {
    expect(stayReason({ ...base, d: '2026-11-03', ws: '07:00' }, NOW)).toBe('inside 73 hours');
    expect(stayReason({ ...base, d: '2026-11-04', ws: '09:00' }, NOW)).toBeNull();
  });

  test('an office move is not a customer choice', () => {
    expect(stayReason({ ...base, last_mover: 'admin', date_exception_source: 'admin' }, NOW)).toBeNull();
  });
});

describe('reviewPlan', () => {
  const plan = () => planSeriesRedate(series(legacy()));
  const conn = {};
  // The rebooker's read-only twin of its commit check (previewMoveConflicts): the conflicts it would refuse.
  const scheduleWith = (conflicts) => ({ previewMoveConflicts: jest.fn(async () => conflicts) });

  test('a free schedule leaves the plan alone', async () => {
    const out = await reviewPlan(conn, plan(), { rebooker: scheduleWith([]) });
    expect(out.held).toBeNull();
  });

  test('a move whose own hour the rebooker would refuse takes the next open time; every timed move is checked, unassigned too', async () => {
    // The rebooker's commit check refuses 09:00 on every day; 10:00 is open (starts stay on the hour).
    const rebooker = { previewMoveConflicts: jest.fn(async (id, date, window) => (window.start === '09:00' ? [{ id: 'x' }] : [])) };
    const unassigned = planSeriesRedate(series(legacy().map((v) => ({ ...v, tech: null }))));
    const out = await reviewPlan(conn, unassigned, { rebooker });
    expect(out.held).toBeNull();
    expect(out.moves.map((m) => [m.id, m.toWs, m.toWe])).toEqual([['v2', '10:00', '11:00'], ['v3', '10:00', '11:00'], ['v4', '10:00', '11:00']]);
    // The source time stays beside the reviewed one.
    expect(out.visits.find((v) => v.id === 'v2')).toMatchObject({ ws: '09:00', we: '10:00', toWs: '10:00', toWe: '11:00' });
    expect(rebooker.previewMoveConflicts.mock.calls.slice(0, 2).map(([id, date, window, opts]) => [id, date, window, opts.conn]))
      .toEqual([['v2', '2027-01-12', { start: '09:00', end: '10:00' }, conn], ['v2', '2027-01-12', { start: '10:00', end: '11:00' }, conn]]);
  });

  test('a start stays on the hour and the end follows the length (a 90-minute visit)', async () => {
    const long = planSeriesRedate(series([visit('v1', '2026-11-17'), visit('v2', '2026-12-29', { we: '10:30', dur: 90 })]));
    const rebooker = { previewMoveConflicts: jest.fn(async (id, date, window) => (window.start === '09:00' ? [{ id: 'x' }] : [])) };
    expect((await reviewPlan(conn, long, { rebooker })).moves[0]).toMatchObject({ toWs: '10:00', toWe: '11:30' });
  });

  test('a day with no open time in working hours holds the series: hour taken; an untimed move needs none', async () => {
    const full = { previewMoveConflicts: jest.fn(async () => [{ id: 'x' }]) };
    expect((await reviewPlan(conn, plan(), { rebooker: full })).held).toBe('hour taken');
    // On the hour: 09:00 to 16:00 later (the last that ends by 17:00), then 08:00 earlier.
    expect(full.previewMoveConflicts.mock.calls.filter(([id]) => id === 'v2').map(([, , w]) => w.start))
      .toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '08:00']);
    const untimed = planSeriesRedate(series([visit('v1', '2026-11-17'), visit('v2', '2026-12-29', { ws: null, we: null })]));
    const free = await reviewPlan(conn, untimed, { rebooker: full });
    expect(free.held).toBeNull();
    expect(free.moves[0]).toMatchObject({ id: 'v2', ws: null, we: null, toWs: null });
  });

  test('a closed day holds the series', async () => {
    const out = await reviewPlan(conn, plan(), { closedDates: new Set(['2027-01-12']), rebooker: scheduleWith([]) });
    expect(out.held).toBe('closed day');
  });

  test('an earlier planned series in the run claims its hour, whatever the technician; a held series claims none', async () => {
    const reserved = new Map();
    const rebooker = scheduleWith([]);
    expect((await reviewPlan(conn, plan(), { reserved, rebooker })).moves.map((m) => m.toWs)).toEqual(['09:00', '09:00', '09:00']);
    const otherTech = planSeriesRedate(series(legacy().map((v) => ({ ...v, tech: 'another-tech' }))));
    const second = await reviewPlan(conn, otherTech, { reserved, rebooker });
    expect(second.held).toBeNull();
    expect(second.moves.map((m) => m.toWs)).toEqual(['10:00', '10:00', '10:00']);
    expect(reserved.get('2027-01-12')).toEqual([['09:00', '10:00'], ['10:00', '11:00']]);
    const heldFirst = new Map();
    await reviewPlan(conn, plan(), { reserved: heldFirst, rebooker, closedDates: new Set(['2027-01-12']) });
    expect(heldFirst.size).toBe(0);
  });
});

describe('planAndReview', () => {
  const conn = {};
  // The area day 2027-01-12 is full (no open hour); every other day is open.
  const areaDayFull = { previewMoveConflicts: jest.fn(async (id, date) => (date === '2027-01-12' ? [{ id: 'x' }] : [])) };

  test('an area plan held only because an area day is full falls back to the own weekday: area day full', async () => {
    const drifted = [visit('v1', '2026-11-17'), visit('v2', '2026-12-29'), visit('v3', '2027-02-11')];
    const out = await planAndReview(conn, series(drifted), {}, { rebooker: areaDayFull });
    expect(out).toMatchObject({ held: null, anchorSource: 'own', anchor: '2026-11-17' });
    expect(out.flags).toContain('area day full');
    expect(out.moves.map((m) => [m.id, m.to])).toEqual([['v3', '2027-02-09']]);
  });

  test('the area plan and its hold stand when the own weekday does not pass either, or the hold is not only a full day', async () => {
    const everyDayFull = { previewMoveConflicts: jest.fn(async () => [{ id: 'x' }]) };
    const drifted = [visit('v1', '2026-11-17'), visit('v2', '2026-12-29'), visit('v3', '2027-02-11')];
    expect(await planAndReview(conn, series(drifted), {}, { rebooker: everyDayFull })).toMatchObject({ held: 'hour taken', anchorSource: 'area' });
    const closed = await planAndReview(conn, series(drifted), {}, { rebooker: areaDayFull, closedDates: new Set(['2027-01-12']) });
    expect(closed).toMatchObject({ anchorSource: 'area', heldReasons: ['closed day', 'hour taken'] });
  });
});

// ---- the applier ----------------------------------------------------------------------------------------------

// The series root as readCandidateRoots returns it (scheduled_services plus the customer columns it joins).
const lawnRoot = (pattern) => ({
  id: PARENT, customer_id: CUSTOMER, is_recurring: true, recurring_parent_id: null, recurring_pattern: pattern,
  recurring_interval_days: pattern === 'custom' ? 42 : null, service_type: 'Lawn Care', c_active: true, c_deleted_at: null,
  c_service_paused_at: null, c_service_pause_reason: null, c_pipeline_stage: null, c_property_type: 'residential',
});

// readCandidateRoots' query on the fakes: the chain returns the world's root row (a row lock is logged).
function rootQuery(state, log) {
  const chain = {};
  for (const method of ['join', 'leftJoin', 'where', 'whereNull', 'whereIn', 'select', 'orderBy']) chain[method] = () => chain;
  chain.forUpdate = (...tables) => { log.push(`lock-rows:${tables.join(',')}`); return chain; };
  chain.then = (resolve, reject) => Promise.resolve(state.root ? [{ ...state.root }] : []).then(resolve, reject);
  return chain;
}

function world({ visits = legacy(), parentPattern = 'custom', terms = [], rebookerFails = null, smsSent = false } = {}) {
  const log = [];
  const fail = { id: rebookerFails };
  const rows = new Map(visits.map((v) => [v.id, {
    id: v.id, d: v.date, ws: v.ws, we: v.we, dur: v.dur, tech: v.tech, term_id: v.termId || null, is_recurring: true,
    window_start: v.ws ? `${v.ws}:00` : null, window_end: v.we ? `${v.we}:00` : null, technician_id: v.tech, status: 'pending', customer_confirmed: false,
    estimated_duration_minutes: v.dur ?? null, auto_dispatch_locked: false, auto_dispatch_excluded: false, visit_id: null,
  }]));
  const state = { root: lawnRoot(parentPattern), terms };
  const live = () => [...rows.values()].sort((a, b) => a.d.localeCompare(b.d));
  const conn = Object.assign(() => rootQuery(state, log), {
    raw: jest.fn(async (sql, params) => {
      if (/where ss\.id = \?/.test(sql)) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] };
      if (/where \(ss\.id = \?/.test(sql)) return { rows: live() };
      return { rows: [] };
    }),
    transaction: jest.fn(async (fn) => fn(makeTrx(state, live, log))),
  });
  const rebooker = {
    previewMoveConflicts: jest.fn(async () => []),
    reschedule: jest.fn(async (id, date, window, reason, by, options) => {
      log.push(`move:${id}`);
      if (fail.id === id) throw new Error('refused');
      // The real rebooker runs beforeMove inside its transaction, before the row write, and stamps a date move
      // a one-off exception to the cadence (dateExceptionStamp, initiator 'admin').
      await options.beforeMove(conn);
      const row = rows.get(id);
      Object.assign(row, dateExceptionStamp({ ...row, scheduled_date: row.d }, by), { d: date });
      return { ok: true, smsSent };
    }),
  };
  const reminders = { handleReschedule: jest.fn(async (id) => { log.push(`remind:${id}`); }) };
  const deps = {
    rebooker, reminders, nowMs: NOW, todayET: '2026-10-31',
    lockSeries: jest.fn(async () => { log.push('lock-series'); }),
    lockComms: jest.fn(async () => { log.push('lock-comms'); }),
    prepay: { normalizeCoverageCadence: (v) => v || null, inferCoverageCadence: () => 'quarterly' },
  };
  const termWindows = Object.fromEntries(terms.map((term) => [term.id, { start: '2026-01-01', end: '2027-12-31' }]));
  const replan = async () => reviewPlan(conn, planSeriesRedate(series(live().map((r) => visit(r.id, r.d, { ws: r.ws, we: r.we, dur: r.dur, tech: r.tech, termId: r.term_id, prepaid: !!r.term_id })), { terms: termWindows })), { rebooker });
  return { conn, deps, rebooker, reminders, log, rows, state, replan, fail };
}

function makeTrx(state, live, log) {
  const trx = (table) => {
    if (table === 'scheduled_services as ss') return rootQuery(state, log);
    const q = { ids: null, filter: null };
    const chain = {
      where(filter) { q.filter = filter; return chain; },
      whereIn(_col, ids) { q.ids = ids; return chain; },
      forUpdate() { return chain; },
      select: async () => (table === 'annual_prepay_terms' ? state.terms.filter((t) => q.ids.includes(t.id)) : []),
      columnInfo: async () => ({ updated_at: {}, recurring_round_anchor_date: {}, recurring_round_floor_date: {}, coverage_cadence: {} }),
      update: async (obj) => { log.push({ op: 'update', table, filter: q.filter, ids: q.ids, obj }); return 1; },
    };
    return chain;
  };
  trx.raw = async () => ({ rows: live() });
  return trx;
}

const updates = (log) => log.filter((e) => e && e.op === 'update');

describe('applySeries', () => {
  test('moves one visit at a time the way move-visit does, silently, then converts', async () => {
    const w = world();
    const plan = await w.replan();
    const out = await applySeries(w.conn, w.deps, plan, w.replan);
    expect(out.status).toBe('converted');
    expect(w.rebooker.reschedule.mock.calls.map((c) => [c[0], c[1]])).toEqual([['v2', '2027-01-12'], ['v3', '2027-02-23'], ['v4', '2027-03-30']]);
    const [id, date, window, reason, initiatedBy, options] = w.rebooker.reschedule.mock.calls[0];
    expect([id, date, window, reason, initiatedBy]).toEqual(['v2', '2027-01-12', { start: '09:00', end: '10:00' }, 'admin', 'admin']);
    expect(options).toEqual({
      seriesPolicy: 'single', visitPolicy: 'single', suppressTechNotice: true, placeInRoute: true, beforeMove: expect.any(Function),
      // The row write misses when a confirmation, staff lock, grouping or length edit lands after the read.
      expect: {
        scheduled_date: '2026-12-29', window_start: '09:00:00', window_end: '10:00:00', technician_id: TECH, status: 'pending',
        estimated_duration_minutes: 60, customer_confirmed: false, auto_dispatch_locked: false, auto_dispatch_excluded: false, visit_id: null,
      },
    });
    // The reminder is re-timed with no notification; no other message path exists on these fakes.
    // Fenced to the slot the move committed, so a newer reschedule keeps its own reminder.
    const silent = (date, windowStart) => ({ sendNotification: false, keepPendingConfirmation: true, expectSchedule: { date, windowStart } });
    expect(w.reminders.handleReschedule.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['v2', '2027-01-12T09:00', silent('2027-01-12', '09:00')],
      ['v3', '2027-02-23T09:00', silent('2027-02-23', '09:00')],
      ['v4', '2027-03-30T09:00', silent('2027-03-30', '09:00')],
    ]);
    expect(out.moved.map((m) => m.tech)).toEqual([TECH, TECH, TECH]);
  });

  test('a move takes its planned open time; an untimed visit moves by date only', async () => {
    const rows = [visit('v1', '2026-11-17'), visit('v2', '2026-12-29', { ws: null, we: null }), visit('v3', '2027-02-09'), visit('v4', '2027-03-23')];
    const w = world({ visits: rows });
    // The rebooker's commit check refuses 09:00 on v4's new day, so v4 takes 10:00.
    w.rebooker.previewMoveConflicts.mockImplementation(async (id, date, win) => (date === '2027-03-30' && win.start === '09:00' ? [{ id: 'x' }] : []));
    const out = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    expect(out.status).toBe('converted');
    const calls = Object.fromEntries(w.rebooker.reschedule.mock.calls.map(([id, date, window]) => [id, [date, window]]));
    expect(calls).toEqual({ v2: ['2027-01-12', null], v3: ['2027-02-23', { start: '09:00', end: '10:00' }], v4: ['2027-03-30', { start: '10:00', end: '11:00' }] });
    expect(w.reminders.handleReschedule.mock.calls.map((c) => [c[0], c[1], c[2].expectSchedule]))
      .toEqual([['v2', '2027-01-12T08:00', { date: '2027-01-12', windowStart: null }], ['v3', '2027-02-23T09:00', { date: '2027-02-23', windowStart: '09:00' }],
        ['v4', '2027-03-30T10:00', { date: '2027-03-30', windowStart: '10:00' }]]);
  });

  test('the conversion runs only after every move landed, under the series locks', async () => {
    const w = world();
    await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    const names = w.log.map((e) => (typeof e === 'string' ? e : `update:${e.table}`));
    expect(names).toEqual(['move:v2', 'remind:v2', 'move:v3', 'remind:v3', 'move:v4', 'remind:v4', 'lock-series', 'lock-comms',
      'lock-rows:ss,c', 'update:scheduled_services', 'update:scheduled_services', 'update:scheduled_services']);
  });

  test('stores the anchor with the rounds pattern and no interval; no floor column is written', async () => {
    const w = world();
    await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    const [children, , parent] = updates(w.log);
    expect(children.ids).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(children.obj).toMatchObject({ recurring_pattern: 'lawn_rounds_9', recurring_interval_days: null });
    expect(parent.filter).toEqual({ id: PARENT });
    expect(parent.obj).toMatchObject({ recurring_pattern: 'lawn_rounds_9', recurring_interval_days: null, recurring_round_anchor_date: AREA });
    expect(parent.obj).not.toHaveProperty('recurring_round_floor_date');
  });

  test('the engine reads back the stored anchor: the next visit of the series lands on the area day', () => {
    const { lawnRoundDateFrom } = require('../services/lawn-rounds');
    const parent = { recurring_round_anchor_date: AREA };
    expect(lawnRoundDateFrom(seeder.seriesRoundAnchor(parent), '2027-03-30', 1)).toBe('2027-05-11');
  });

  test('a held series writes nothing', async () => {
    const w = world();
    const heldPlan = await w.replan();
    const heldReplan = async () => ({ ...heldPlan, held: 'hour taken', heldReasons: ['hour taken'] });
    const out = await applySeries(w.conn, w.deps, heldPlan, heldReplan);
    expect(out).toMatchObject({ status: 'held', why: 'hour taken' });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
    expect(w.log).toEqual([]);
  });

  test('a series the run held stays held even when a fresh re-plan alone would pass', async () => {
    // The run's review held it for an hour an earlier series reserved; a single re-plan cannot see that reservation.
    const w = world();
    const plan = { ...(await w.replan()), held: 'hour taken', heldReasons: ['hour taken'] };
    const out = await applySeries(w.conn, w.deps, plan, w.replan);
    expect(out).toEqual({ status: 'held', why: 'hour taken' });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
    expect(w.log).toEqual([]);
  });

  test('a time, technician or reviewed-time change since the plan skips the series', async () => {
    for (const change of [{ ws: '13:00', window_start: '13:00:00' }, { tech: 'another-tech', technician_id: 'another-tech' }]) {
      const w = world();
      const plan = await w.replan();
      Object.assign(w.rows.get('v3'), change);
      expect(await applySeries(w.conn, w.deps, plan, w.replan)).toMatchObject({ status: 'skipped', why: 'series changed since the plan' });
      expect(w.rebooker.reschedule).not.toHaveBeenCalled();
    }
    // The open hour the plan printed is taken now: the fresh review picks another hour, so the series is skipped.
    const w = world();
    const plan = await w.replan();
    w.rebooker.previewMoveConflicts.mockImplementation(async (id, date, win) => (date === '2027-02-23' && win.start === '09:00' ? [{ id: 'x' }] : []));
    expect(await applySeries(w.conn, w.deps, plan, w.replan)).toMatchObject({ status: 'skipped', why: 'series changed since the plan' });
  });

  test('a later visit edited while earlier moves run is not written over: the series stops there', async () => {
    for (const edit of [{ ws: '13:00', window_start: '13:00:00' }, { we: '11:00', window_end: '11:00:00' }, { dur: 90, estimated_duration_minutes: 90 }, { tech: 'another-tech', technician_id: 'another-tech' }]) {
      const w = world();
      const move = w.rebooker.reschedule.getMockImplementation();
      // The office edits v3 right after v2 moves.
      w.rebooker.reschedule.mockImplementation(async (id, ...rest) => {
        const result = await move(id, ...rest);
        if (id === 'v2') Object.assign(w.rows.get('v3'), edit);
        return result;
      });
      const out = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
      expect(out).toMatchObject({ status: 'error', why: 'visit v3 changed since the plan' });
      expect(w.rebooker.reschedule.mock.calls.map((c) => c[0])).toEqual(['v2']);
      expect(updates(w.log)).toEqual([]);
    }
  });

  test('a series that changed since the plan is skipped with the reason', async () => {
    const w = world();
    const plan = await w.replan();
    w.rows.get('v3').d = '2027-02-16';
    const out = await applySeries(w.conn, w.deps, plan, w.replan);
    expect(out).toMatchObject({ status: 'skipped', why: 'series changed since the plan' });
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a reminder sent after the read is caught inside the move transaction: nothing moves, nothing converts', async () => {
    const w = world();
    const plan = await w.replan();
    const send = w.rebooker.reschedule.getMockImplementation();
    // The 72-hour reminder for v2 goes out between the applier's read and the rebooker's transaction.
    w.rebooker.reschedule.mockImplementationOnce(async (id, ...rest) => {
      w.rows.get(id).r72 = true;
      return send(id, ...rest);
    });
    const out = await applySeries(w.conn, w.deps, plan, w.replan);
    expect(out).toMatchObject({ status: 'error', why: 'visit v2 changed since the plan' });
    expect(w.rows.get('v2').d).toBe('2026-12-29');
    expect(w.reminders.handleReschedule).not.toHaveBeenCalled();
    expect(updates(w.log)).toEqual([]);
  });

  test('a refused move stops the series before the conversion; a re-run finishes it', async () => {
    const w = world({ rebookerFails: 'v3' });
    const out = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    expect(out).toMatchObject({ status: 'error', why: 'refused' });
    expect(out.moved.map((m) => m.row.id)).toEqual(['v2']);
    expect(updates(w.log)).toEqual([]);
    // The re-run: v2 is already on its round day, so the plan moves v3 and v4 only.
    w.fail.id = null;
    const second = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    expect(second.status).toBe('converted');
    expect(second.moved.map((m) => m.row.id)).toEqual(['v3', 'v4']);
    expect(updates(w.log).length).toBe(3);
  });

  test('the conversion clears the move stamps (the round dates are regular) and keeps a date the customer chose', async () => {
    const w = world();
    // The next visit is kept as booked: a date the customer picked, a genuine exception.
    Object.assign(w.rows.get('v1'), { date_exception: true, date_exception_source: 'customer_self_serve', date_exception_cadence_date: '2026-11-10' });
    const out = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    expect(out.status).toBe('converted');
    // Each move was stamped a one-off from the old 6-week date, as the rebooker does.
    expect(w.rows.get('v2')).toMatchObject({ date_exception: true, date_exception_source: 'admin', date_exception_cadence_date: '2026-12-29' });
    const [, cleared] = updates(w.log);
    expect(cleared.ids).toEqual(['v2', 'v3', 'v4']);
    expect(cleared.obj).toEqual(DATE_EXCEPTION_CLEAR);
  });

  test('a series that no longer passes the identity or customer rules is skipped before any move', async () => {
    const paused = world();
    const plan = await paused.replan();
    Object.assign(paused.state.root, { c_service_paused_at: new Date(), c_service_pause_reason: 'owner hold' });
    expect(await applySeries(paused.conn, paused.deps, plan, paused.replan)).toMatchObject({ status: 'skipped', why: 'customer_service_held' });
    const recadenced = world();
    Object.assign(recadenced.state.root, { recurring_interval_days: 90 });
    expect(await applySeries(recadenced.conn, recadenced.deps, plan, recadenced.replan))
      .toMatchObject({ status: 'skipped', why: 'not a lawn 9x series any more' });
    for (const w of [paused, recadenced]) expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a change that lands during the moves stops the conversion, judged on locked rows', async () => {
    const w = world();
    const move = w.rebooker.reschedule.getMockImplementation();
    w.rebooker.reschedule.mockImplementation(async (id, ...rest) => {
      const result = await move(id, ...rest);
      if (id === 'v4') w.state.root.c_active = false;
      return result;
    });
    const out = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    expect(out).toMatchObject({ status: 'skipped', why: 'customer_inactive' });
    expect(w.log).toContain('lock-rows:ss,c');
    expect(updates(w.log)).toEqual([]);
  });

  test('a converted series is skipped on a re-run', async () => {
    const w = world({ parentPattern: 'lawn_rounds_9', visits: planSeriesRedate(series(legacy())).visits.map((v) => visit(v.id, v.to)) });
    const out = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    expect(out).toMatchObject({ status: 'skipped', why: 'already rounds' });
    expect(updates(w.log)).toEqual([]);
  });

  test('the conversion refuses when a planned visit is not at its target', async () => {
    const w = world();
    const plan = await w.replan();
    const out = await convertSeries(w.conn, w.deps, plan);
    expect(out).toEqual({ converted: false, why: 'a visit is not at its target' });
    expect(updates(w.log)).toEqual([]);
  });

  test('a rebooker that reports a customer text stops the run', async () => {
    const w = world({ smsSent: true });
    const out = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    expect(out.status).toBe('error');
    expect(w.reminders.handleReschedule).not.toHaveBeenCalled();
    expect(updates(w.log)).toEqual([]);
  });

  test('a visit the 10-08 rule now keeps still is not moved', async () => {
    const w = world();
    const plan = await w.replan();
    w.rows.get('v2').customer_confirmed = true;
    const out = await applySeries(w.conn, w.deps, plan, async () => plan);
    expect(out.status).toBe('error');
    expect(out.why).toMatch(/changed since the plan/);
    expect(w.rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a covering prepay term on the every-6-weeks cadence moves to lawn_rounds_9; another cadence is left alone', async () => {
    const rows = legacy().map((v) => ({ ...v, termId: 'term-1' }));
    const w = world({ visits: rows, terms: [{ id: 'term-1', coverage_cadence: 'every_6_weeks' }] });
    const out = await applySeries(w.conn, w.deps, await w.replan(), w.replan);
    expect(out.termsMoved).toBe(1);
    const termUpdate = updates(w.log).find((e) => e.table === 'annual_prepay_terms');
    expect(termUpdate.ids).toEqual(['term-1']);
    expect(termUpdate.obj).toMatchObject({ coverage_cadence: 'lawn_rounds_9' });

    const other = world({ visits: rows, terms: [{ id: 'term-1', coverage_cadence: 'quarterly' }] });
    const out2 = await applySeries(other.conn, other.deps, await other.replan(), other.replan);
    expect(out2.termsMoved).toBe(0);
    expect(updates(other.log).some((e) => e.table === 'annual_prepay_terms')).toBe(false);
  });
});

describe('the identity rule', () => {
  test('is the app rule and does not need the gate', () => {
    delete process.env.GATE_LAWN_9X_ROUNDS;
    expect(seeder.isLawn9xRoundsSeries({ pattern: 'custom', intervalDays: 42, service_type: 'Lawn Care' })).toBe(true);
    expect(seeder.isLawn9xRoundsSeries({ pattern: 'every_6_weeks', service_type: 'Commercial Lawn Care' })).toBe(false);
    expect(seeder.isLawn9xRoundsSeries({ pattern: 'custom', intervalDays: 42, service_type: 'Lawn Care', isCommercial: true })).toBe(false);
    expect(seeder.isLawn9xRoundsSeries({ pattern: 'custom', intervalDays: 42, service_type: 'Tree & Shrub Care' })).toBe(false);
    expect(seeder.lawnRoundsSeriesPattern({ pattern: 'custom', intervalDays: 42, service_type: 'Lawn Care' }))
      .toEqual({ pattern: 'custom', intervalDays: 42 });
  });
});

describe('the command line', () => {
  test.each(['--customer', '--parent', '--max-shift-days', '--allow-long-shift', '--anchor'])('%s with no value fails and never widens', (flag) => {
    expect(parseCliArgs([flag]).error).toBe(`Missing value for ${flag}.`);
    expect(parseCliArgs([flag, '--apply']).error).toBe(`Missing value for ${flag}.`);
    expect(parseCliArgs(['--apply', flag]).error).toBe(`Missing value for ${flag}.`);
  });

  test('an unknown flag fails', () => {
    expect(parseCliArgs(['--aply']).error).toMatch(/Unknown argument/);
  });

  test('defaults to a dry run', () => {
    const opts = parseCliArgs([]);
    expect(opts).toMatchObject({ apply: false, customerId: null, parentId: null, maxShiftDays: 14 });
  });

  test('reads the selectors, the limit and the repeatable flags', () => {
    const other = '44444444-4444-4444-8444-444444444444';
    const opts = parseCliArgs(['--apply', '--parent', PARENT, '--customer', CUSTOMER, '--max-shift-days', '21',
      '--allow-long-shift', PARENT, '--allow-long-shift', other, '--anchor', `${PARENT}=2027-01-28`]);
    expect(opts).toMatchObject({ apply: true, parentId: PARENT, customerId: CUSTOMER, maxShiftDays: 21 });
    expect([...opts.allowLongShift]).toEqual([PARENT, other]);
    expect(opts.anchors.get(PARENT)).toBe('2027-01-28');
  });

  test.each([
    ['--max-shift-days', '0'], ['--max-shift-days', 'x'], ['--parent', 'not-an-id'],
    ['--anchor', `${PARENT}=2027-01-16`], ['--anchor', `${PARENT}=2027-01-02`], ['--anchor', '2027-01-19'],
    ['--anchor', `${PARENT}=2027-01-19`], // a Tuesday 25 days into its round: too early for an area day
  ])('rejects %s %s', (flag, value) => {
    expect(parseCliArgs([flag, value]).error).toMatch(/Invalid/);
  });
});

describe('summarizePlans', () => {
  test('counts planned and held by reason, and lists weekend, long-shift, prepaid and conflict series', () => {
    const ok = planSeriesRedate(series(legacy()));
    const conflict = planSeriesRedate(series([visit('v1', '2026-11-17'), visit('v2', '2026-12-29'), visit('v3', '2027-01-05', { stay: 'locked by staff' })], { parentId: 'p2' }));
    const report = summarizePlans([ok, conflict], { 'already rounds': 2 });
    expect(report.summary).toEqual({ candidates: 4, planned: 1, held: { 'round conflict': 1 }, skipped: { 'already rounds': 2 }, visitsMoved: 3, visitsKept: 1 });
    expect(report.roundConflict).toEqual(['p2']);
    // The kept next visit (2026-11-17) is on its own date, not the area day.
    expect(report.areaDayLoad).toEqual({ 'parrish 2027-01-12': 1, 'parrish 2027-02-23': 1, 'parrish 2027-03-30': 1 });
  });
});
