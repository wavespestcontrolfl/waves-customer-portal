/**
 * Morning open-blocks notification (services/day-replan/open-blocks-alert.js, owner 2026-11-18): one admin row a
 * morning from the latest re-plan run's close-gaps numbers, the copy passes the notification rule, and an earlier
 * morning's row closes. Fake knex, synthetic ids only.
 */
jest.mock('../routes/estimate-slots-public', () => ({ _internals: { offerableEstimateSlots: jest.fn() } }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(async () => ({ id: 'n1', deduped: false })) };
});
jest.mock('../services/technician-eligibility', () => ({
  applyAssignable: jest.fn((q) => q), absentTechDays: jest.fn(async () => new Set()),
}));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn(async () => new Set()) }));
jest.mock('../services/scheduling/occupancy', () => ({
  DEFAULT_EXCLUDE_STATUSES: ['cancelled', 'skipped', 'no_show', 'rescheduled'],
  techScopedConfirmActive: jest.fn(() => false), listOccupiedWindows: jest.fn(async () => []),
  findInterviewConflicts: jest.fn(async () => []),
  occupiedRows: jest.requireActual('../services/scheduling/occupancy').occupiedRows,
}));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60 }));
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn(async () => []), closeAdminAlertKeys: jest.fn(async (_c, keys) => keys.length),
}));

const { composeAdminAlert, raiseAdminAlert } = require('../services/admin-alert-compose');
const { openAdminAlertKeys, closeAdminAlertKeys } = require('../services/admin-alert-episodes');
const { absentTechDays } = require('../services/technician-eligibility');
const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
const { runOpenBlocksAlert, _internals } = require('../services/day-replan/open-blocks-alert');

const NOW = new Date('2026-11-18T12:05:00Z'); // 07:05 ET
const TECH = '00000000-0000-4000-8000-000000000001';

const rec = (blocks, extra = {}) => ({
  v: 2,
  now: { driveMin: 90, endMin: 900, waitMin: 60, biggestMin: Math.max(0, ...blocks.map((b) => b.min)), sellableMin: blocks.filter((b) => b.min >= 60).reduce((n, b) => n + b.min, 0), lunch: true, blocks },
  packed: null, p1: { plan: 'pack', packed: null, wouldAccept: false, reason: 'small_gain', gainMin: 0, lunchLost: false, changes: [] }, s1: [], gaps: [],
  ...extra,
});
const tail = (start, min) => ({ kind: 'tail', start, min, before: null });
const wait = (start, min) => ({ kind: 'wait', start, min, before: 'v1' });

// `assignable`: the technicians the hour-grid count covers (none unless a test says so); `services` and `blocks`: that
// count's schedule rows and schedule blocks.
function fakeConn({ run = { run_id: 'run-1' }, rows = [], techs = [{ id: TECH, name: 'Pat Tester' }], assignable = [], services = [], blocks = [], estimates = [] } = {}) {
  const calls = [];
  let estimateRows = estimates;
  const conn = (table) => {
    const q = {
      where(...args) { calls.push([table, 'where', args]); return q; },
      whereNotNull() { return q; },
      whereNull() { return q; },
      limit(...args) { calls.push([table, 'limit', args]); return q; },
      whereIn() { return q; },
      whereNotIn(...args) {
        calls.push([table, 'whereNotIn', args]);
        if (table === 'estimates' && args[0] === 'customer_id') estimateRows = estimateRows.filter((r) => !args[1].includes(String(r.customer_id)));
        return q;
      },
      whereNot() { return q; },
      whereBetween(...args) { calls.push([table, 'whereBetween', args]); return q; },
      orderBy(...args) { calls.push([table, 'orderBy', args]); return q; },
      first: async () => run,
      select: async (first) => {
        if (table === 'technicians') return first === 'technicians.id' ? assignable : techs;
        if (table === 'estimates') return estimateRows;
        if (table === 'scheduled_services') return services;
        if (table === 'tech_schedule_blocks') return blocks;
        return rows;
      },
    };
    return q;
  };
  conn.raw = (sql) => sql;
  return { conn, calls };
}

beforeEach(() => jest.clearAllMocks());

// Two timed stops on every working day in the window (Thu Nov 19 to Wed Nov 25, Sunday out): no day is empty, so
// only the planned rows count.
const busyWeek = () => ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-24', '2026-11-25']
  .flatMap((day, i) => ['08', '09'].map((h) => ({ id: `busy-${i}-${h}`, technician_id: TECH, day, window_start: `${h}:00:00`, window_end: null, estimated_duration_minutes: 60 })));

describe('the copy', () => {
  const sum = _internals.summarize([
    { technician_id: TECH, day: '2026-11-21', close_gaps: rec([wait(545, 45), tail(695, 325)]) },
    { technician_id: TECH, day: '2026-11-19', close_gaps: JSON.stringify(rec([tail(815, 205)])) },
  ], new Map([[TECH, 'Pat']]));

  test('counts only blocks of an hour or more, and names the biggest', () => {
    expect(sum.totalMin).toBe(530);
    expect(sum.blocks.map((b) => b.day)).toEqual(['2026-11-19', '2026-11-21']);
    expect(sum.biggest).toMatchObject({ day: '2026-11-21', start: 695, min: 325 });
  });

  test('the spec passes the admin notification rule (headline, one-sentence why, link, structured parts)', () => {
    const spec = _internals.alertSpec(sum);
    const out = composeAdminAlert(spec);
    expect(out.headline).toBe('Schedule — sell 9 open hours in the next 7 days');
    expect(out.why).toBe('Biggest block: Sat Nov 21, 11:35 AM to 5:00 PM.');
    expect(out.link).toBe('/admin/schedule?date=2026-11-21');
    expect(out.metadata).toMatchObject({ severity: 'needs-you', who: 'person', subject: { type: 'check', id: 'open-blocks' } });
  });

  test('the why adds what re-timing would free when P1 frees an hour or more: P1\'s own plan (record v2)', () => {
    const packPlan = { ...rec([tail(600, 420)]).now };
    const driveBest = { ...rec([tail(660, 360)]).now };
    const withGain = _internals.summarize([{
      technician_id: TECH, day: '2026-11-21',
      close_gaps: rec([tail(695, 325)], { packed: driveBest, p1: { plan: 'pack', packed: packPlan, wouldAccept: true, reason: 'bigger_block', gainMin: 95, lunchLost: false, changes: [] } }),
    }], new Map());
    expect(withGain.freedMin).toBe(95);
    expect(composeAdminAlert(_internals.alertSpec(withGain)).why).toBe('Biggest block: Sat Nov 21, 11:35 AM to 5:00 PM; re-timing booked jobs could free 1 h 35 min more.');
  });

  test('a record from before the replay test (v1) measured P1 on the drive-best plan', () => {
    const packed = { ...rec([tail(600, 420)]).now };
    const v1 = _internals.summarize([{
      technician_id: TECH, day: '2026-11-21',
      close_gaps: { ...rec([tail(695, 325)], { packed, p1: { wouldAccept: true, reason: 'bigger_block', gainMin: 95, lunchLost: false, changes: [] } }), v: 1, p2: null },
    }], new Map());
    expect(v1.freedMin).toBe(95);
  });

  test('a day the 04:40 run re-timed is read as re-timed: its planned blocks, and no gain counted twice', () => {
    const packed = { ...rec([tail(600, 420)]).now };
    const applied = _internals.summarize([{
      technician_id: TECH, day: '2026-11-21', apply_status: 'applied',
      close_gaps: rec([tail(695, 325)], { packed, p1: { wouldAccept: false, reason: 'drive_rule_accepts', gainMin: 95, lunchLost: false, changes: [] } }),
    }], new Map());
    expect(applied.blocks.map((b) => [b.start, b.min])).toEqual([[600, 420]]);
    expect(applied.freedMin).toBe(0);
  });

  test('a block of an hour that is short of 80 minutes says so', () => {
    const short = _internals.summarize([{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(960, 60)]) }], new Map([[TECH, 'Pat']]));
    expect(short.slots).toBe(0);
    expect(_internals.detailText(short)).toContain('(1 h, short of a job and its drive)');
    expect(_internals.detailText(short)).toContain('Room for 0 new jobs');
  });

  test('the detail lists each block with its technician and the measuring line', () => {
    const text = _internals.detailText(sum);
    // Job slots: 205 and 325 open minutes hold 2 and 4 new jobs of 80 minutes (a 1-hour job and its drive).
    expect(sum.slots).toBe(6);
    expect(text).toContain('Room for 6 new jobs: each needs 80 free minutes (a 1-hour job and its drive).');
    expect(text).toContain('- Thu Nov 19, Pat: 1:35 PM to 5:00 PM (3 h 25 min, room for 2 jobs)');
    expect(text).toContain('- Sat Nov 21, Pat: 11:35 AM to 5:00 PM (5 h 25 min, room for 4 jobs)');
    expect(text).not.toContain('9:05 AM');
    expect(text).toContain('Measuring only (no visit changes)');
  });
});

test('a matching estimate needs its two-hour arrival promise, stored window and simulated finish inside the opening', () => {
  const block = { day: '2026-11-20', tech: 'Pat', techId: 't1', start: 600, min: 120 };
  const offer = { date: block.day, techId: 't1', start: '10:00', end: '11:00', finishMin: 675, driveMin: 42, addedDriveMin: 5, proposed: 1 };
  const fits = (diff, blocks = [block]) => _internals.matchingHour([{ ...offer, ...diff }], blocks);
  expect(fits({})).toMatchObject({ tech: 'Pat', start: 600 });
  expect(fits({}, [{ ...block, min: 119 }])).toBeNull(); // customer sees 10 AM to noon
  for (const diff of [{ techId: 'other' }, { finishMin: 721 }, { end: '12:01' }, { driveMin: null }]) expect(fits(diff)).toBeNull();
});

test('booking fit removes only the trusted estimate\'s hold; absent and unknown ids remove nothing', () => {
  const { _internals: fit } = require('../services/day-replan/booking-fit');
  const own = { id: 'hold-own', customer_id: null, source_estimate_id: 'estimate-own', reservation_expires_at: '2097-01-01' };
  const rival = { id: 'hold-rival', customer_id: null, source_estimate_id: 'estimate-rival', reservation_expires_at: '2097-01-01' };
  const unscoped = { id: 'hold-unscoped', customer_id: null, source_estimate_id: null, reservation_expires_at: '2097-01-01' };
  const committed = { id: 'visit-own', source_estimate_id: 'estimate-own', reservation_expires_at: null };
  const linkedWithExpiry = { id: 'visit-linked', customer_id: 'customer-1', source_estimate_id: 'estimate-own', reservation_expires_at: '2097-01-01' };
  const rows = [own, rival, unscoped, committed, linkedWithExpiry];
  expect(fit.withoutOwnEstimateHold(rows, 'estimate-own')).toEqual([rival, unscoped, committed, linkedWithExpiry]);
  expect(fit.withoutOwnEstimateHold(rows, 'estimate-unknown')).toEqual(rows);
  expect(fit.withoutOwnEstimateHold(rows, null)).toBe(rows);
});

test('booking fit blocks live make-room destinations from the writer reader with its technician scope', async () => {
  const occupancy = require('../services/scheduling/occupancy');
  const { assessOfferedHours } = require('../services/day-replan/booking-fit');
  const RouteOptimizer = require('../services/route-optimizer');
  const date = '2026-11-20';
  const tech = 'tech-1';
  const slot = { date, techId: tech, windowStart: '10:00', windowEnd: '11:00' };
  const target = { id: 'target-1', lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, planning_exempt: true, estimated_duration_minutes: 60 };
  const destination = (technicianId) => ({
    id: 'make-room-hold', customer_id: null, technician_id: technicianId, date,
    window_start: '10:00:00', window_end: '11:00:00', estimated_duration_minutes: 60,
    reservation_expires_at: '2097-01-01', source_estimate_id: 'estimate-rival',
    conflict_reason: 'make_room_destination',
  });
  const calendar = () => new Map([
    ['homes', new Map()], ['departure', 8 * 60], [date, []], [`${date}|${tech}`, []],
  ]);

  occupancy.listOccupiedWindows.mockResolvedValueOnce([{ ...destination(tech), startMin: 600, endMin: 660 }]);
  await expect(assessOfferedHours(jest.fn(), [slot], target, { now: NOW, calendar: calendar() })).resolves.toEqual([]);
  expect(occupancy.listOccupiedWindows).toHaveBeenLastCalledWith({
    db: expect.any(Function), dateFrom: date, dateTo: date, excludeServiceIds: ['target-1'],
    excludeStatuses: occupancy.DEFAULT_EXCLUDE_STATUSES,
  });

  occupancy.techScopedConfirmActive.mockReturnValueOnce(true);
  occupancy.listOccupiedWindows.mockResolvedValueOnce([{ ...destination('tech-2'), startMin: 600, endMin: 660 }]);
  await expect(assessOfferedHours(jest.fn(), [slot], target, { now: NOW, calendar: calendar() }))
    .resolves.toEqual([expect.objectContaining({ slot })]);
});

test('booking fit filters only this estimate\'s genuine hold after the shared occupancy read', async () => {
  const occupancy = require('../services/scheduling/occupancy');
  const { assessOfferedHours } = require('../services/day-replan/booking-fit');
  const RouteOptimizer = require('../services/route-optimizer');
  const date = '2026-11-20';
  const tech = 'tech-1';
  const own = { id: 'hold-own', customer_id: null, technician_id: tech, source_estimate_id: 'estimate-own',
    reservation_expires_at: '2097-01-01', window_start: '10:00', window_end: '11:00' };
  const linked = { id: 'visit-linked', customer_id: 'customer-1', technician_id: tech, source_estimate_id: 'estimate-own',
    reservation_expires_at: '2097-01-01', status: 'confirmed', window_start: '09:00', window_end: '10:00',
    estimated_duration_minutes: 60, lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng };
  const calendar = new Map([
    ['homes', new Map()], ['departure', 8 * 60], [date, [own, linked]], [`${date}|${tech}`, []],
  ]);
  occupancy.listOccupiedWindows.mockResolvedValueOnce([
    { ...own, scheduled_date: date, startMin: 600, endMin: 660 },
    { ...linked, scheduled_date: date, startMin: 540, endMin: 600 },
  ]);
  const slot = { date, techId: tech, windowStart: '10:00', windowEnd: '11:00' };
  const target = { lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, planning_exempt: true, estimated_duration_minutes: 60 };
  await expect(assessOfferedHours(jest.fn(), [slot], target, {
    now: NOW, calendar, ownEstimateId: 'estimate-own',
  })).resolves.toEqual([expect.objectContaining({ slot })]);
  expect(occupancy.listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({ excludeServiceIds: [] }));
  await expect(assessOfferedHours(jest.fn(), [slot], target, {
    now: NOW, calendar, ownEstimateId: 'estimate-other',
  })).resolves.toEqual([]);
  expect(occupancy.listOccupiedWindows).toHaveBeenCalledTimes(1);
});

test('booking fit checks delayed service against exact rival occupancy with writer scope and boundary handoffs', async () => {
  const occupancy = require('../services/scheduling/occupancy');
  const { assessOfferedHours } = require('../services/day-replan/booking-fit');
  const RouteOptimizer = require('../services/route-optimizer');
  const date = '2026-11-20';
  const tech = 'tech-1';
  const slot = { date, techId: tech, windowStart: '10:00', windowEnd: '11:00' };
  const target = { lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, planning_exempt: true, estimated_duration_minutes: 60 };
  const rival = (technicianId, reason) => ({
    id: `rival-${technicianId || 'unassigned'}-${reason || 'hold'}`, customer_id: null, technician_id: technicianId,
    status: 'pending', scheduled_date: date, window_start: '11:00', window_end: '12:00',
    estimated_duration_minutes: 60, reservation_expires_at: '2097-01-01', source_estimate_id: 'estimate-rival',
    startMin: 660, endMin: 720, ...(reason ? { conflict_reason: reason } : {}),
  });
  const run = async (row, { duration = 90, scoped = false } = {}) => {
    const earlier = {
      id: 'earlier-visit', customer_id: 'customer-1', technician_id: tech, status: 'confirmed', scheduled_date: date,
      window_start: '09:00', window_end: '10:00', estimated_duration_minutes: duration,
      lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, route_order: 1,
    };
    const calendar = new Map([
      ['homes', new Map()], ['departure', 8 * 60], [date, [earlier]], [`${date}|${tech}`, []],
    ]);
    occupancy.techScopedConfirmActive.mockReturnValueOnce(scoped);
    occupancy.listOccupiedWindows.mockResolvedValueOnce([row]);
    return assessOfferedHours(jest.fn(), [slot], target, { now: NOW, calendar });
  };

  await expect(run(rival(tech))).resolves.toEqual([]); // delayed until 11:30, through the rival hold
  await expect(run(rival(tech), { duration: 60 })).resolves.toEqual([expect.objectContaining({ slot })]); // ends at 11:00
  await expect(run(rival('tech-2'))).resolves.toEqual([]); // tech-blind writer scope
  await expect(run(rival('tech-2'), { scoped: true })).resolves.toEqual([expect.objectContaining({ slot })]);
  await expect(run(rival(null, 'make_room_destination'), { scoped: true })).resolves.toEqual([]);
});

test('booking fit holds the full summed span of a version-2 allocation before scoring an offer', async () => {
  const occupancy = require('../services/scheduling/occupancy');
  const { assessOfferedHours } = require('../services/day-replan/booking-fit');
  const RouteOptimizer = require('../services/route-optimizer');
  const date = '2026-11-20';
  const tech = 'tech-1';
  const ids = ['allocation-a', 'allocation-b'];
  const mix = { version: 2, allocatedServiceIds: ids };
  const routeRows = ids.map((id, route_order) => ({
    id, customer_id: 'customer-1', technician_id: tech, status: 'confirmed', scheduled_date: date,
    window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
    lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, route_order,
  }));
  occupancy.listOccupiedWindows.mockResolvedValueOnce(routeRows.map(row => ({
    ...row, reservation_service_mix: mix, startMin: 540, endMin: 600,
  })));
  const calendar = new Map([
    ['homes', new Map()], ['departure', 8 * 60], [date, routeRows], [`${date}|${tech}`, []],
  ]);
  const slot = { date, techId: tech, windowStart: '10:00', windowEnd: '11:00' };
  const target = { lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, planning_exempt: true, estimated_duration_minutes: 60 };

  await expect(assessOfferedHours(jest.fn(), [slot], target, { now: NOW, calendar })).resolves.toEqual([]);
});

test('booking fit caches the writer buffered interviews once per day and blocks every technician', async () => {
  const occupancy = require('../services/scheduling/occupancy');
  const { assessOfferedHours } = require('../services/day-replan/booking-fit');
  const RouteOptimizer = require('../services/route-optimizer');
  const date = '2026-11-20';
  const conn = jest.fn();
  const slots = ['tech-1', 'tech-2'].map(techId => ({ date, techId, windowStart: '10:00', windowEnd: '11:00' }));
  const target = { lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, planning_exempt: true, estimated_duration_minutes: 60 };
  const calendar = new Map([
    ['homes', new Map()], ['departure', 8 * 60], [date, []],
    [`${date}|tech-1`, []], [`${date}|tech-2`, []],
  ]);
  occupancy.techScopedConfirmActive.mockReturnValueOnce(true).mockReturnValueOnce(true);
  occupancy.findInterviewConflicts.mockResolvedValueOnce([{
    id: 'interview:application-1', scheduled_date: date,
    window_start: '09:45', window_end: '10:45', estimated_duration_minutes: 60,
    status: 'interview', conflict_reason: 'interview', technician_id: null,
  }]);

  await expect(assessOfferedHours(conn, slots, target, { now: NOW, calendar })).resolves.toEqual([]);
  await expect(assessOfferedHours(conn, slots, target, { now: NOW, calendar })).resolves.toEqual([]);

  expect(occupancy.findInterviewConflicts).toHaveBeenCalledTimes(1);
  expect(occupancy.findInterviewConflicts).toHaveBeenCalledWith({
    db: conn, date, windowStart: '00:00', windowEnd: '24:00',
  });
  expect(occupancy.listOccupiedWindows).toHaveBeenCalledTimes(1);
});

test('booking fit simulates the exact buffered interview span when earlier work delays an offer', async () => {
  const occupancy = require('../services/scheduling/occupancy');
  const { assessOfferedHours } = require('../services/day-replan/booking-fit');
  const RouteOptimizer = require('../services/route-optimizer');
  const date = '2026-11-20';
  const tech = 'tech-1';
  const earlier = {
    id: 'earlier-visit', customer_id: 'customer-1', technician_id: tech, status: 'confirmed', scheduled_date: date,
    window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 90,
    lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, route_order: 1,
  };
  const calendar = new Map([
    ['homes', new Map()], ['departure', 8 * 60], [date, [earlier]], [`${date}|${tech}`, []],
  ]);
  occupancy.findInterviewConflicts.mockResolvedValueOnce([{
    id: 'interview:application-1', scheduled_date: date,
    window_start: '11:00', window_end: '12:00', estimated_duration_minutes: 60,
    status: 'interview', conflict_reason: 'interview', technician_id: null,
  }]);
  const slot = { date, techId: tech, windowStart: '10:00', windowEnd: '11:00' };
  const target = {
    lat: RouteOptimizer.HQ.lat, lng: RouteOptimizer.HQ.lng, planning_exempt: true, estimated_duration_minutes: 60,
  };

  // The 09:00 visit occupies 90 minutes, so this 10:00 service would actually run until 11:30.
  // The interview is buffered to 11:00-12:00; route simulation must reject that delayed overlap.
  await expect(assessOfferedHours(jest.fn(), [slot], target, { now: NOW, calendar })).resolves.toEqual([]);
});

test('a route-aware alternate preserves the first card, technician, day, rain priority and five-minute driving limit', () => {
  const { rankOfferedHours } = require('../services/day-replan/booking-fit');
  const base = { date: '2026-11-20', techId: 't1' };
  const slots = ['09', '10', '11', '12', '13', '14', '15'].map(h => ({ ...base, windowStart: h + ':00' }));
  slots[3].date = '2026-11-21';
  slots[4].techId = 't2';
  slots[5].wet = true;
  const fits = slots.map((slot, i) => ({ slot, driveMin: [8, 20, 25, 15, 6, 5, 26][i], slots: i, waitMin: 0, startMin: 540 + i * 60 }));
  const ranked = rankOfferedHours(slots, fits, { pinned: 1, rainTierOf: s => Number(!!s.wet) });
  expect(ranked.map(s => s.windowStart)).toEqual(['09:00', '11:00', '10:00', '12:00', '13:00', '14:00', '15:00']);
});

describe('runOpenBlocksAlert', () => {
  test('the same morning notice contains a fresh matching estimate without contacting the customer', async () => {
    const { offerableEstimateSlots } = require('../routes/estimate-slots-public')._internals;
    const { OFFER_RANK } = require('../services/day-replan/booking-fit');
    const day = '2026-11-19';
    const estimate = { id: 'estimate123', customer_id: 'customer', customer_name: 'Test Customer' };
    const { conn } = fakeConn({ rows: [{ day, technician_id: TECH, close_gaps: rec([tail(600, 120)]) }], assignable: [{ id: TECH }], estimates: [estimate] });
    offerableEstimateSlots.mockResolvedValueOnce({ [OFFER_RANK]: async () => [
      { date: day, techId: TECH, start: '10:00', end: '11:00', finishMin: 670, driveMin: 25, addedDriveMin: 3, proposed: 1 },
    ] });
    await runOpenBlocksAlert({ conn, now: NOW });
    const notice = raiseAdminAlert.mock.calls.at(-1)[2];
    expect(notice.detail).toContain('Test Customer (#estimate), Thu Nov 19 at 10:00 AM with Pat');
    expect(notice.metadata.estimateMatches).toEqual([{ id: estimate.id, date: day, start: 600, techId: TECH }]);
  });

  test('internal test customer estimates are excluded before the newest-20 candidate limit', async () => {
    const { offerableEstimateSlots } = require('../routes/estimate-slots-public')._internals;
    const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');
    const day = '2026-11-19';
    const internal = { id: 'estimate-demo', customer_id: INTERNAL_TEST_CUSTOMER_IDS[0], customer_name: 'Demo' };
    const real = { id: 'estimate-real', customer_id: '00000000-0000-4000-8000-000000000099', customer_name: 'Real Customer' };
    const { conn, calls } = fakeConn({
      rows: [{ day, technician_id: TECH, close_gaps: rec([tail(600, 120)]) }],
      assignable: [{ id: TECH }],
      estimates: [internal, real],
    });
    offerableEstimateSlots.mockResolvedValue({});

    await runOpenBlocksAlert({ conn, now: NOW });

    expect(offerableEstimateSlots).toHaveBeenCalledTimes(1);
    expect(offerableEstimateSlots).toHaveBeenCalledWith(real.id, real.customer_id, expect.any(Object));
    const estimateCalls = calls.filter(([table]) => table === 'estimates');
    expect(estimateCalls).toContainEqual(['estimates', 'whereNotIn', ['customer_id', INTERNAL_TEST_CUSTOMER_IDS]]);
    expect(estimateCalls.findIndex(([, method]) => method === 'whereNotIn'))
      .toBeLessThan(estimateCalls.findIndex(([, method]) => method === 'orderBy'));
    expect(estimateCalls.findIndex(([, method]) => method === 'whereNotIn'))
      .toBeLessThan(estimateCalls.findIndex(([, method]) => method === 'limit'));
  });

  test('a morning row that is not written fails the tick and leaves the earlier rows open', async () => {
    openAdminAlertKeys.mockResolvedValueOnce(['open-blocks:2026-11-17']);
    raiseAdminAlert.mockResolvedValueOnce(null);
    closeAdminAlertKeys.mockClear();
    const { conn } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(695, 325)]) }], assignable: [{ id: TECH }], services: busyWeek() });
    await expect(runOpenBlocksAlert({ conn, now: NOW })).rejects.toThrow('open-blocks row not written');
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('raises one row keyed to this morning and closes an earlier morning\'s row', async () => {
    openAdminAlertKeys.mockResolvedValueOnce(['open-blocks:2026-11-17', 'open-blocks:2026-11-18']);
    const { conn, calls } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(695, 325)]) }], assignable: [{ id: TECH }], services: busyWeek() });
    const out = await runOpenBlocksAlert({ conn, now: NOW });
    expect(out).toMatchObject({ status: 'raised', id: 'n1', openMin: 325, closed: 1 });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('schedule');
    expect(spec.link).toBe('/admin/schedule?date=2026-11-21');
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'open-blocks:2026-11-18' });
    expect(closeAdminAlertKeys).toHaveBeenCalledWith(conn, ['open-blocks:2026-11-17'], 'next_morning_replaces', expect.any(Object));
    // Tomorrow through 7 days out, in ET.
    expect(calls).toContainEqual(['day_replan_plans', 'whereBetween', ['service_date', ['2026-11-19', '2026-11-25']]]);
  });

  test('no fresh re-plan run (every day has fewer than two stops): the empty and one-stop days are still raised, with a note', async () => {
    const { conn } = fakeConn({ run: null, assignable: [{ id: TECH }] });
    await expect(runOpenBlocksAlert({ conn, now: NOW })).resolves.toMatchObject({ status: 'raised', noRun: true, openMin: 6 * 9 * 60 });
    const [, , opts] = raiseAdminAlert.mock.calls[0];
    expect(opts.detail).toContain('The night re-plan left no numbers this morning');
  });

  test('no fresh run and nothing open: nothing is raised', async () => {
    const { conn } = fakeConn({ run: null });
    await expect(runOpenBlocksAlert({ conn, now: NOW })).resolves.toMatchObject({ status: 'no_open_hours', noRun: true });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('no open hour left: nothing is raised and every open morning row closes', async () => {
    openAdminAlertKeys.mockResolvedValueOnce(['open-blocks:2026-11-17']);
    const { conn } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([wait(545, 45)]) }], assignable: [{ id: TECH }], services: busyWeek() });
    await expect(runOpenBlocksAlert({ conn, now: NOW })).resolves.toEqual({ status: 'no_open_hours', closed: 1 });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(closeAdminAlertKeys).toHaveBeenCalledWith(conn, ['open-blocks:2026-11-17'], 'next_morning_replaces', expect.any(Object));
  });
});

describe('days the re-plan does not plan (no stop, or one): open hours by the booking hour grid', () => {
  const TECH2 = '00000000-0000-4000-8000-000000000002';
  const svc = (id, tech, day, hour) => ({ id, technician_id: tech, day, window_start: `${hour}:00:00`, window_end: `${hour + 1}:00:00`, estimated_duration_minutes: 60 });

  test('runs of free whole hours become blocks', () => {
    expect(_internals.hourGridBlocks(new Set([10, 12, 13]))).toEqual([
      { kind: 'hours', start: 480, min: 120, before: null },
      { kind: 'hours', start: 660, min: 60, before: null },
      { kind: 'hours', start: 840, min: 180, before: null },
    ]);
  });

  test('an empty day, a one-stop day and a schedule block; planned days, absent days, two-stop days and Sundays are left out', async () => {
    absentTechDays.mockResolvedValueOnce(new Set([`${TECH2}:2026-11-20`]));
    const { conn } = fakeConn({
      assignable: [{ id: TECH }, { id: TECH2 }],
      services: [svc('s1', TECH, '2026-11-19', 10), svc('s2', TECH2, '2026-11-19', 8), svc('s3', TECH2, '2026-11-19', 9)],
      blocks: [{ technician_id: TECH, day: '2026-11-20', start_time: '12:00:00', end_time: '12:30:00' }],
    });
    const out = await _internals.unplannedDays(conn, new Set([`2026-11-21|${TECH}`]), await _internals.eligibility(conn, NOW));
    const pick = (day, tech) => out.find((d) => d.day === day && d.technician_id === tech);
    // Thu: one stop at 10 AM. While the occupancy check is tech-blind, the other technician's 8 and 9 AM stops hold
    // those hours for everyone (the app's own rule), so only 11 AM to 5 PM is open.
    expect(pick('2026-11-19', TECH)).toMatchObject({ stops: 1, blocks: [{ start: 660, min: 360 }] });
    // Thu, the other technician: two stops, left to the re-plan.
    expect(pick('2026-11-19', TECH2)).toBeUndefined();
    // Fri: empty, with a half-hour block at noon (the whole hour is held).
    expect(pick('2026-11-20', TECH)).toMatchObject({ stops: 0, blocks: [{ start: 480, min: 240 }, { start: 780, min: 240 }] });
    expect(pick('2026-11-20', TECH2)).toBeUndefined(); // absent
    expect(pick('2026-11-21', TECH)).toBeUndefined(); // planned by the re-plan
    expect(out.some((d) => d.day === '2026-11-22')).toBe(false); // Sunday
    expect(pick('2026-11-21', TECH2)).toMatchObject({ stops: 0, blocks: [{ start: 480, min: 540 }] });
  });

  test('tech-scoped occupancy: another technician\'s stops no longer hold the hour', async () => {
    require('../services/scheduling/occupancy').techScopedConfirmActive.mockReturnValueOnce(true);
    const { conn } = fakeConn({
      assignable: [{ id: TECH }],
      services: [svc('s1', TECH, '2026-11-19', 10), svc('s2', TECH2, '2026-11-19', 8), svc('s3', TECH2, '2026-11-19', 9)],
    });
    const out = await _internals.unplannedDays(conn, new Set(), await _internals.eligibility(conn, NOW));
    expect(out.find((d) => d.day === '2026-11-19')).toMatchObject({ blocks: [{ start: 480, min: 120 }, { start: 660, min: 360 }] });
  });

  test('a blackout day is left out', async () => {
    getBlackoutDates.mockResolvedValueOnce(new Set(['2026-11-19']));
    const { conn } = fakeConn({ assignable: [{ id: TECH }] });
    const out = await _internals.unplannedDays(conn, new Set(), await _internals.eligibility(conn, NOW));
    expect(out.some((d) => d.day === '2026-11-19')).toBe(false);
    expect(out.some((d) => d.day === '2026-11-20')).toBe(true);
  });

  test('a day with an untimed stop is not empty: it is left out', async () => {
    const { conn } = fakeConn({ assignable: [{ id: TECH }], services: [{ id: 'u1', technician_id: TECH, day: '2026-11-19', window_start: null, window_end: null }] });
    const out = await _internals.unplannedDays(conn, new Set(), await _internals.eligibility(conn, NOW));
    expect(out.some((d) => d.day === '2026-11-19')).toBe(false);
  });

  test('planned days follow the same rules: a blackout day, a day off and a technician who is not assignable are left out; a worked Sunday stays', async () => {
    getBlackoutDates.mockResolvedValueOnce(new Set(['2026-11-20']));
    absentTechDays.mockResolvedValueOnce(new Set([`${TECH}:2026-11-21`]));
    const OTHER = '00000000-0000-4000-8000-000000000009';
    const { conn } = fakeConn({
      assignable: [{ id: TECH }],
      rows: [
        { technician_id: TECH, day: '2026-11-20', close_gaps: rec([tail(600, 420)]) }, // blackout
        { technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(600, 420)]) }, // day off
        { technician_id: OTHER, day: '2026-11-23', close_gaps: rec([tail(600, 420)]) }, // not assignable
        { technician_id: TECH, day: '2026-11-22', close_gaps: rec([tail(780, 240)]) }, // Sunday with stops
      ],
      services: ['2026-11-19', '2026-11-23', '2026-11-24', '2026-11-25'].flatMap((day, i) => [svc(`a${i}`, TECH, day, 8), svc(`b${i}`, TECH, day, 9)]),
    });
    await runOpenBlocksAlert({ conn, now: NOW });
    const [, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(spec.link).toBe('/admin/schedule?date=2026-11-22');
    expect(opts.metadata.openMin).toBe(240);
  });

  test('the morning row lists those days with a note, next to the planned days', async () => {
    const { conn } = fakeConn({
      rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(695, 325)]) }],
      assignable: [{ id: TECH }],
      services: ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25'].flatMap((day, i) => [svc(`a${i}`, TECH, day, 8), svc(`b${i}`, TECH, day, 9)]),
    });
    await runOpenBlocksAlert({ conn, now: NOW });
    // Only Sat Nov 21 is planned; every other working day has two stops, so nothing else is added.
    const [, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(spec.action).toBe('sell 5 open hours in the next 7 days');
    expect(opts.detail).not.toContain('no stops booked');

    raiseAdminAlert.mockClear();
    const empty = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(695, 325)]) }], assignable: [{ id: TECH }] });
    await runOpenBlocksAlert({ conn: empty.conn, now: NOW });
    const [, spec2, opts2] = raiseAdminAlert.mock.calls[0];
    // Five empty working days (Thu, Fri, Mon, Tue, Wed) of 9 hours each, plus Saturday's 5 h 25 min.
    expect(spec2.action).toBe('sell 50 open hours in the next 7 days');
    expect(opts2.detail).toContain('- Thu Nov 19, Pat: 8:00 AM to 5:00 PM (9 h, room for 6 jobs, no stops booked)');
  });

  test('a failed read of those days still raises the planned days', async () => {
    const { conn } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(695, 325)]) }] });
    getBlackoutDates.mockRejectedValueOnce(new Error('settings down'));
    await expect(runOpenBlocksAlert({ conn, now: NOW })).resolves.toMatchObject({ status: 'raised', openMin: 325 });
  });

  test('a failed read with no planned block measured nothing: the tick fails and the earlier rows stay open', async () => {
    openAdminAlertKeys.mockResolvedValueOnce(['open-blocks:2026-11-17']);
    closeAdminAlertKeys.mockClear();
    const { conn } = fakeConn({ rows: [] });
    getBlackoutDates.mockRejectedValueOnce(new Error('settings down'));
    await expect(runOpenBlocksAlert({ conn, now: NOW })).rejects.toThrow('day rules unread');
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});
