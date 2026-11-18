/**
 * Morning open-blocks notification (services/day-replan/open-blocks-alert.js, owner 2026-11-18): one admin row a
 * morning from the latest re-plan run's close-gaps numbers, the copy passes the notification rule, and an earlier
 * morning's row closes. Fake knex, synthetic ids only.
 */
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
jest.mock('../services/scheduling/occupancy', () => ({ techScopedConfirmActive: jest.fn(() => false) }));
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
  v: 1,
  now: { driveMin: 90, endMin: 900, waitMin: 60, biggestMin: Math.max(0, ...blocks.map((b) => b.min)), sellableMin: blocks.filter((b) => b.min >= 60).reduce((n, b) => n + b.min, 0), lunch: true, blocks },
  packed: null, p1: { wouldAccept: false, reason: 'small_gain', gainMin: 0, lunchLost: false, changes: [] }, p2: null, s1: [], gaps: [],
  ...extra,
});
const tail = (start, min) => ({ kind: 'tail', start, min, before: null });
const wait = (start, min) => ({ kind: 'wait', start, min, before: 'v1' });

// `assignable`: the technicians the hour-grid count covers (none unless a test says so); `services` and `blocks`: that
// count's schedule rows and schedule blocks.
function fakeConn({ run = { run_id: 'run-1' }, rows = [], techs = [{ id: TECH, name: 'Pat Tester' }], assignable = [], services = [], blocks = [] } = {}) {
  const calls = [];
  const conn = (table) => {
    const q = {
      where(...args) { calls.push([table, 'where', args]); return q; },
      whereNotNull() { return q; },
      whereIn() { return q; },
      whereNotIn() { return q; },
      whereNot() { return q; },
      whereBetween(...args) { calls.push([table, 'whereBetween', args]); return q; },
      orderBy() { return q; },
      first: async () => run,
      select: async (first) => {
        if (table === 'technicians') return first === 'technicians.id' ? assignable : techs;
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

  test('the why adds what re-timing would free when a measured rule frees an hour or more', () => {
    const packed = { ...rec([tail(600, 420)]).now };
    const withGain = _internals.summarize([{
      technician_id: TECH, day: '2026-11-21',
      close_gaps: rec([tail(695, 325)], { packed, p1: { wouldAccept: true, reason: 'bigger_block', gainMin: 95, lunchLost: false, changes: [] } }),
    }], new Map());
    expect(withGain.freedMin).toBe(95);
    expect(composeAdminAlert(_internals.alertSpec(withGain)).why).toBe('Biggest block: Sat Nov 21, 11:35 AM to 5:00 PM; re-timing booked jobs could free 1 h 35 min more.');
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

  test('the detail lists each block with its technician and the measuring line', () => {
    const text = _internals.detailText(sum);
    expect(text).toContain('- Thu Nov 19, Pat: 1:35 PM to 5:00 PM (3 h 25 min)');
    expect(text).toContain('- Sat Nov 21, Pat: 11:35 AM to 5:00 PM (5 h 25 min)');
    expect(text).not.toContain('9:05 AM');
    expect(text).toContain('Measuring only (no visit changes)');
  });
});

describe('runOpenBlocksAlert', () => {
  test('raises one row keyed to this morning and closes an earlier morning\'s row', async () => {
    openAdminAlertKeys.mockResolvedValueOnce(['open-blocks:2026-11-17', 'open-blocks:2026-11-18']);
    const { conn, calls } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(695, 325)]) }] });
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

  test('no fresh re-plan run: nothing is raised or closed', async () => {
    const { conn } = fakeConn({ run: null });
    await expect(runOpenBlocksAlert({ conn, now: NOW })).resolves.toEqual({ status: 'no_run' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('no open hour left: nothing is raised and every open morning row closes', async () => {
    openAdminAlertKeys.mockResolvedValueOnce(['open-blocks:2026-11-17']);
    const { conn } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([wait(545, 45)]) }] });
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
    const out = await _internals.unplannedDays(conn, NOW, new Set([`2026-11-21|${TECH}`]));
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
    const out = await _internals.unplannedDays(conn, NOW, new Set());
    expect(out.find((d) => d.day === '2026-11-19')).toMatchObject({ blocks: [{ start: 480, min: 120 }, { start: 660, min: 360 }] });
  });

  test('a blackout day is left out', async () => {
    getBlackoutDates.mockResolvedValueOnce(new Set(['2026-11-19']));
    const { conn } = fakeConn({ assignable: [{ id: TECH }] });
    const out = await _internals.unplannedDays(conn, NOW, new Set());
    expect(out.some((d) => d.day === '2026-11-19')).toBe(false);
    expect(out.some((d) => d.day === '2026-11-20')).toBe(true);
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
    expect(opts2.detail).toContain('- Thu Nov 19, Pat: 8:00 AM to 5:00 PM (9 h, no stops booked)');
  });

  test('a failed read of those days still raises the planned days', async () => {
    const { conn } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(695, 325)]) }] });
    getBlackoutDates.mockRejectedValueOnce(new Error('settings down'));
    await expect(runOpenBlocksAlert({ conn, now: NOW })).resolves.toMatchObject({ status: 'raised', openMin: 325 });
  });
});
