/**
 * Close-gaps measurement (services/day-replan/close-gaps.js, owner 2026-11-18): the open time of a simulated day,
 * the packed-day verdict (P1), the replay of a new booking over its day's hours (S1) and job slots. Pure; synthetic
 * ids only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { openTime, planSims, packVerdict, hourChanges, lockedGaps, SLOT_MIN, _internals } = require('../services/day-replan/close-gaps');
const { _internals: replan } = require('../services/day-replan');

const BOUNDS = { departureMin: 7 * 60 + 30, openMin: 8 * 60, closeMin: 17 * 60 };
const arrival = (id, arrivalMin, departureMin, driveMin) => ({ id, arrivalMin, departureMin, driveMin });
const sim = (arrivals, extra = {}) => ({
  arrivals, travelMin: 30, finishMin: arrivals.at(-1).departureMin, serviceFinishMin: arrivals.at(-1).departureMin, ...extra,
});

describe('openTime', () => {
  test('counts each wait between stops, the open tail to the close, the biggest block, the sellable minutes and lunch room', () => {
    const fig = openTime(sim([arrival('a', 480, 540, 10), arrival('b', 660, 720, 5), arrival('c', 900, 960, 5)]), BOUNDS);
    // b: left a at 9:00, reached 9:05, starts 11:00 (115). c: reached 12:05, starts 3:00 PM (175). Tail 4:00 to 5:00 PM.
    expect(fig.blocks).toEqual([
      { kind: 'wait', start: 545, min: 115, before: 'b' },
      { kind: 'wait', start: 725, min: 175, before: 'c' },
      { kind: 'tail', start: 960, min: 60, before: null },
    ]);
    expect(fig).toMatchObject({ driveMin: 30, endMin: 960, waitMin: 290, biggestMin: 175, sellableMin: 350, lunch: true });
  });

  test('the open start counts from the day\'s first hour, not from the 7:30 departure', () => {
    const early = openTime(sim([arrival('a', 480, 540, 10)]), BOUNDS);
    expect(early.blocks.filter((b) => b.kind === 'start')).toEqual([]);
    const late = openTime(sim([arrival('a', 600, 660, 10)]), BOUNDS);
    expect(late.blocks[0]).toEqual({ kind: 'start', start: 480, min: 120, before: 'a' });
  });

  test('only the working day counts: a stop booked after 5 PM opens no evening time, a stop before 8 AM no early time', () => {
    // a ends 10:00 AM; b is a fixed 7:00 PM stop (reached 10:10 AM). Only 10:10 AM to 5:00 PM is open: 410 minutes.
    const late = openTime(sim([arrival('a', 540, 600, 10), arrival('b', 1140, 1200, 10)]), BOUNDS);
    expect(late.blocks).toEqual([
      { kind: 'start', start: 480, min: 60, before: 'a' },
      { kind: 'wait', start: 610, min: 410, before: 'b' },
    ]);
    expect(late).toMatchObject({ sellableMin: 470, slots: 5 });
    // a 6:00 AM stop that ends at 6:30 AM: the open tail starts at 8:00 AM, not 6:30.
    const early = openTime(sim([arrival('a', 360, 390, 10)], { serviceFinishMin: 390, finishMin: 390 }), BOUNDS);
    expect(early.blocks).toEqual([{ kind: 'tail', start: 480, min: 540, before: null }]);
  });

  test('a co-visit continuation (same arrival, no drive) adds no block and no negative wait', () => {
    const fig = openTime(sim([arrival('a', 480, 540, 10), arrival('a2', 480, 570, 0), arrival('b', 580, 640, 10)]), BOUNDS);
    expect(fig.waitMin).toBe(0);
    expect(fig.blocks).toEqual([{ kind: 'tail', start: 640, min: 380, before: null }]);
  });

  test('a day with no break between 11:00 AM and 2:00 PM has no lunch room; blocks under 15 minutes are not listed', () => {
    const fig = openTime(sim([arrival('a', 480, 600, 10), arrival('b', 610, 730, 10), arrival('c', 740, 860, 10), arrival('d', 870, 1010, 10)]), BOUNDS);
    expect(fig.lunch).toBe(false);
    expect(fig.blocks).toEqual([]);
    expect(fig.sellableMin).toBe(0);
  });

  test('schedule blocks and hours other rows hold are cut out of the open time', () => {
    // As booked: one stop 8 to 9 AM, open 9:05 AM to 5 PM. A schedule block 12 to 1 PM and another row's 3 PM hour.
    const unavailable = [{ startMin: 720, endMin: 780 }, { startMin: 900, endMin: 960 }];
    const fig = openTime(sim([arrival('a', 480, 540, 10)]), { ...BOUNDS, unavailable });
    expect(fig.blocks).toEqual([
      { kind: 'tail', start: 540, min: 180, before: null },
      { kind: 'tail', start: 780, min: 120, before: null },
      { kind: 'tail', start: 960, min: 60, before: null },
    ]);
    expect(fig).toMatchObject({ biggestMin: 180, sellableMin: 360 });
    // A block that covers the whole open time leaves nothing to sell.
    expect(openTime(sim([arrival('a', 480, 540, 10)]), { ...BOUNDS, unavailable: [{ startMin: 540, endMin: 1020 }] }).sellableMin).toBe(0);
  });

  test('a drive a schedule block delays is placed after the block: the time it takes is not sold (Codex #7935 r2)', () => {
    // p ends 9:50 AM; a block holds 10 to 11 AM; the 20-minute drive to q (booked noon) waits for the block, so the
    // van drives 11:00 to 11:20. Open: 9:50 to 10:00 and 11:20 to noon, not 11:00 to noon.
    const block = { startMin: 600, endMin: 660 };
    const day = sim([arrival('p', 530, 590, 10), arrival('q', 720, 780, 20)]);
    const fig = openTime(day, { ...BOUNDS, unavailable: [block], driveBlocks: [block] });
    expect(fig.blocks).toEqual([
      { kind: 'start', start: 480, min: 50, before: 'p' },
      { kind: 'wait', start: 680, min: 40, before: 'q' },
      { kind: 'tail', start: 780, min: 240, before: null },
    ]);
    expect(fig).toMatchObject({ waitMin: 50, sellableMin: 240, biggestMin: 240 });
    // Without the drive rule the 11 AM hour would read as sellable.
    expect(openTime(day, { ...BOUNDS, unavailable: [block] }).sellableMin).toBe(300);
  });

  test('departAfter follows the simulator: past each block the drive would cross, in turn', () => {
    const blocks = [{ startMin: 600, endMin: 660 }, { startMin: 670, endMin: 700 }];
    expect(_internals.departAfter(590, 20, blocks)).toBe(700);
    expect(_internals.departAfter(560, 20, blocks)).toBe(560);
    expect(_internals.departAfter(590, 20, [])).toBe(590);
  });

  test('job slots: each block holds one new job for every 80 open minutes (a 1-hour job and its drive)', () => {
    // Waits of 115 and 175 minutes and a 60-minute tail: 1 + 2 + 0 slots.
    const fig = openTime(sim([arrival('a', 480, 540, 10), arrival('b', 660, 720, 5), arrival('c', 900, 960, 5)]), BOUNDS);
    expect(fig.slots).toBe(3);
    expect(SLOT_MIN).toBe(80);
  });

  test('no simulation, no figures', () => {
    expect(openTime(null, BOUNDS)).toBeNull();
  });
});

describe('packVerdict (P1)', () => {
  const now = { driveMin: 60, endMin: 900, biggestMin: 60 };
  const packed = { driveMin: 60, endMin: 780, biggestMin: 240 };
  test.each([
    ['the live drive rule already takes the plan', { now, packed, kept: true, driveRuleAccepts: true }, false, 'drive_rule_accepts'],
    ['there is no plan', { now, packed: null, kept: false, driveRuleAccepts: false }, false, 'no_plan'],
    ['the plan misses a promise', { now, packed, kept: false, driveRuleAccepts: false }, false, 'promise_missed'],
    ['the plan drives more', { now, packed: { ...packed, driveMin: 61 }, kept: true, driveRuleAccepts: false }, false, 'more_drive'],
    ['the plan ends later', { now, packed: { ...packed, endMin: 901 }, kept: true, driveRuleAccepts: false }, false, 'ends_later'],
    ['the biggest block grows by under 30 minutes', { now, packed: { ...packed, biggestMin: 89 }, kept: true, driveRuleAccepts: false }, false, 'small_gain'],
    ['same drive, earlier end, a block 3 hours bigger', { now, packed, kept: true, driveRuleAccepts: false }, true, 'bigger_block'],
  ])('%s', (_label, input, wouldAccept, reason) => {
    expect(packVerdict(input)).toMatchObject({ wouldAccept, reason });
  });
});

describe('hourChanges and lockedGaps', () => {
  test('hour changes list each co-visit group whose plan hour differs, in HH:MM', () => {
    const groups = [[{ id: 'a', window_start: '08:00:00' }], [{ id: 'b', window_start: '14:00:00' }, { id: 'b2', window_start: '14:00:00' }]];
    expect(hourChanges(groups, { slots: { a: 480, b: 540 } })).toEqual([{ id: 'b', from: '14:00', to: '09:00' }]);
    expect(hourChanges(groups, null)).toEqual([]);
  });

  test('each wait names the lock on the stop after it (null: that stop could move)', () => {
    const now = { blocks: [{ kind: 'wait', start: 545, min: 115, before: 'b' }, { kind: 'wait', start: 725, min: 175, before: 'c' }, { kind: 'tail', start: 960, min: 60, before: null }] };
    expect(lockedGaps(now, new Map([['b', 'customer_confirmed'], ['c', null]]))).toEqual([
      { before: 'b', start: 545, min: 115, why: 'customer_confirmed' },
      { before: 'c', start: 725, min: 175, why: null },
    ]);
  });
});

describe('S1 replay of a new booking', () => {
  const HQ = { lat: 27.4330885, lng: -82.4056801 };
  const stop = (id, hour, extra = {}) => ({
    id, window_start: `${String(hour).padStart(2, '0')}:00:00`, window_end: `${String(hour + 1).padStart(2, '0')}:00:00`,
    estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng + 0.02 + (extra.offset || 0), ...extra,
  });

  const replay = (groups, group, extra = {}) => _internals.replayBooking({
    groups, group, pref: null, origin: HQ, marginMin: 15, bounds: BOUNDS, rowHours: replan.rowHours, ...extra,
  });

  test('a job booked mid-afternoon is replayed: the block-aware hour front-loads it with the morning stops', () => {
    const groups = [[stop('x', 8)], [stop('y', 9, { offset: 0.001 })], [stop('n', 14, { offset: 0.002 })]];
    const out = replay(groups, groups[2]);
    expect(out.booked).toMatchObject({ start: '14:00' });
    expect(out.booked.waitMin).toBeGreaterThan(120);
    // 8 and 9 AM are held by the other stops (the planner's occupancy rule), so 10 AM is the first free hour.
    expect(out.s1.start).toBe('10:00');
    expect(out.s1.waitMin).toBe(0);
    expect(out.s1.biggestMin).toBeGreaterThan(out.booked.biggestMin);
    expect(out.s1.driveMin).toBeLessThanOrEqual(out.leastDrive.driveMin + 5);
    expect(out.differs).toBe(true);
  });

  test('S1 ranks job slots first, then the least waiting: two hours that leave the same room pick the earlier one', () => {
    // One stop at 8 AM. A new job at 9 AM leaves 10 AM to 5 PM open; at 4 PM it leaves 9 AM to 4 PM open. Each is
    // one block of about 7 hours (5 slots), so the rank falls to waiting: 9 AM front-loads the day.
    const groups = [[stop('x', 8)], [stop('n', 14, { offset: 0.002 })]];
    const out = replay(groups, groups[1]);
    expect(out.s1).toMatchObject({ start: '09:00', waitMin: 0 });
    expect(out.s1.slots).toBe(5);
  });

  test('a customer time window limits the hours tried; the booked hour is still measured', () => {
    const groups = [[stop('x', 8)], [stop('n', 14, { offset: 0.002 })]];
    const out = replay(groups, groups[1], { pref: { startMin: 13 * 60, endMin: 16 * 60 } });
    expect(out.s1.start).toBe('13:00');
    expect(out.booked.start).toBe('14:00');
  });

  test('a booking with no end holds its estimated minutes, as the occupancy rule reads it', () => {
    const long = stop('n', 14, { offset: 0.002, window_end: null, estimated_duration_minutes: 120 });
    const groups = [[stop('x', 8)], [long]];
    expect(_internals.lastHour(long, BOUNDS.closeMin)).toBe(15);
    // A row holds the 10 AM hour. 9 AM would run 9 to 11 and cross it (a 60-minute width would fit), and 10 AM is
    // held, so the first hour that fits is 11.
    const out = replay(groups, groups[1], { blockedHours: [10] });
    expect(out.s1.start).toBe('11:00');
  });

  test('a late finish that would run the replayed job into a schedule block refuses that hour (Codex #7935 r1)', () => {
    // Stop x is booked 8 to 9 AM but takes 120 minutes, so it runs to 10 AM; a schedule block holds 10 AM to noon.
    const groups = [[stop('x', 8, { estimated_duration_minutes: 120 })], [stop('n', 14, { offset: 0.002 })]];
    const blocks = [{ startMin: 600, endMin: 720 }];
    // Without the block in the simulation, 9 AM would pass: its booked hour misses the block, and x ends at 10.
    expect(replay(groups, groups[1]).s1.start).toBe('09:00');
    // With it, the van leaves x after the block, so a 9 AM job arrives after noon and its promise breaks.
    const out = replay(groups, groups[1], { blocks });
    // Noon is out too: the van leaves the block at noon and still owes the drive clock's per-leg overhead.
    expect(out.s1.start).toBe('13:00');
  });

  test('P1: a planned day a schedule block pushes past a promise is not kept', () => {
    const groups = [[stop('a', 8, { estimated_duration_minutes: 120 })], [stop('b', 9, { offset: 0.001 })]];
    const best = { order: ['a', 'b'], slots: {} };
    const base = { groups, currentOrder: ['a', 'b'], best, origin: HQ, departureMin: BOUNDS.departureMin, marginMin: 15 };
    expect(planSims(base).plannedKept).toBe(true);
    expect(planSims({ ...base, blocks: [{ startMin: 600, endMin: 720 }] }).plannedKept).toBe(false);
    // A malformed block is dropped, not allowed to void the whole day.
    expect(planSims({ ...base, blocks: [{ startMin: 700, endMin: 650 }] }).plannedKept).toBe(true);
    expect(planSims({ ...base, best: null }).plannedKept).toBeNull();
  });

  test('hours held by other rows and schedule blocks are never offered', () => {
    const groups = [[stop('x', 8)], [stop('n', 14, { offset: 0.002 })]];
    const block = { startMin: 600, endMin: 660 };
    // As the night run builds them: the bounds cut the schedule block and the held hour out of the open time.
    const bounds = { ...BOUNDS, unavailable: [block, { startMin: 540, endMin: 600 }], driveBlocks: [block] };
    const out = replay(groups, groups[1], { blockedHours: [9], blocks: [block], bounds });
    expect(out.s1.start).toBe('11:00');
    expect(_internals.hourFree({ group: groups[1], groups, rowHours: replan.rowHours }, 8)).toBe(false);
    expect(_internals.hourFree({ group: groups[1], groups, rowHours: replan.rowHours, blockedHours: [9] }, 9)).toBe(false);
  });

  test('only stops booked in the last 24 hours are replayed, never a series visit made from a plan', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const g = (extra) => [{ id: 'r', created_at: '2026-11-18T10:00:00Z', ...extra }];
    expect(_internals.recentlyBooked(g({}), now)).toBe(true);
    expect(_internals.recentlyBooked(g({ created_at: '2026-11-17T10:00:00Z' }), now)).toBe(false);
    expect(_internals.recentlyBooked(g({ is_recurring: true, recurring_parent_id: 'root' }), now)).toBe(false);
    expect(_internals.recentlyBooked(g({ created_at: null }), now)).toBe(false);
  });
});
