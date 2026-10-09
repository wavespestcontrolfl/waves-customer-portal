// move-rules.js: which candidate may move a visit (owner 2026-10-09).
const {
  moveGain, meetsDriveFloor, rankCandidates, driveSavingMinutes, mustMove,
} = require('../services/auto-dispatch/move-rules');

const CONFIG = { minDayMoveDriveSavingMinutes: 6 };
const SERVICE = { id: 's1', window_start: '13:00', recurring_dispatch_due_date: null };
const CURRENT = { is_current: true, date: '2026-12-03', start_time: '13:00', detour_minutes: 12 };
const score = (total, defaultTime = 0) => ({ total_score: total, default_time_score: defaultTime });
const dayMove = (over = {}) => ({ date: '2026-12-01', start_time: '08:00', detour_minutes: 12, ...over });
const sameDay = (over = {}) => ({ date: '2026-12-03', start_time: '08:00', detour_minutes: 12, ...over });

function rank(scored, { current = CURRENT, service = SERVICE, threshold = 15, currentScore = score(60, 0) } = {}) {
  return rankCandidates({
    service, current, currentScore, scored, threshold, config: CONFIG,
  });
}

describe('moveGain', () => {
  test('a same-day re-time keeps the default time window in its gain', () => {
    expect(moveGain({
      service: SERVICE, current: CURRENT, currentScore: score(60, 0), cand: sameDay(), candScore: score(75, 12.5),
    })).toBe(15);
  });

  test('a day move leaves the default time window out on both sides', () => {
    expect(moveGain({
      service: SERVICE, current: CURRENT, currentScore: score(60, 0), cand: dayMove(), candScore: score(87.5, 12.5),
    })).toBe(15);
    expect(moveGain({
      service: SERVICE, current: CURRENT, currentScore: score(72.5, 12.5), cand: dayMove(), candScore: score(80, 0),
    })).toBe(20);
  });

  test('a time the customer set is not a default: it stays in a day move (default_time_score 0)', () => {
    expect(moveGain({
      service: SERVICE, current: CURRENT, currentScore: score(60), cand: dayMove(), candScore: score(80),
    })).toBe(20);
  });

  test('an unplaced due-date visit is ranked on its raw score', () => {
    const unplaced = { id: 's1', window_start: null, recurring_dispatch_due_date: '2026-12-03' };
    expect(moveGain({
      service: unplaced, current: { ...CURRENT, start_time: null }, currentScore: score(60, 12.5), cand: dayMove(), candScore: score(50, 0),
    })).toBe(-10);
  });
});

describe('drive floor', () => {
  test('a day move needs the configured drive saving; a same-day re-time does not', () => {
    expect(driveSavingMinutes(CURRENT, dayMove({ detour_minutes: 7 }))).toBe(5);
    expect(meetsDriveFloor({ current: CURRENT, cand: dayMove({ detour_minutes: 7 }), config: CONFIG })).toBe(false);
    expect(meetsDriveFloor({ current: CURRENT, cand: dayMove({ detour_minutes: 6 }), config: CONFIG })).toBe(true);
    expect(meetsDriveFloor({ current: CURRENT, cand: sameDay({ detour_minutes: 12 }), config: CONFIG })).toBe(true);
  });

  test('0 turns the floor off', () => {
    expect(meetsDriveFloor({ current: CURRENT, cand: dayMove(), config: { minDayMoveDriveSavingMinutes: 0 } })).toBe(true);
    // Off means off: a day move that adds drive is left to the score bar.
    expect(meetsDriveFloor({ current: CURRENT, cand: dayMove({ detour_minutes: 20 }), config: { minDayMoveDriveSavingMinutes: 0 } })).toBe(true);
  });
});

describe('rankCandidates', () => {
  test('the 2026-10 pattern does not move: no drive saved, gain from the default window and a lighter day', () => {
    // 395d3b82: detour 5 -> 5, +12.5 default time, +10 cluster, +5 workload.
    const current = { ...CURRENT, detour_minutes: 5 };
    const result = rank([{ cand: dayMove({ detour_minutes: 5 }), sc: score(90.31, 12.5) }], { current, currentScore: score(62.81, 0) });
    expect(result.qualifies).toBe(false);
    expect(result.gain).toBe(15);
    expect(result.floorFailed).toBe(true);
    expect(result.ranked).toEqual([]);
  });

  test('a day move that saves drive and clears the bar without the default window moves', () => {
    const cand = dayMove({ detour_minutes: 2 });
    const result = rank([{ cand, sc: score(90, 12.5) }]);
    expect(result).toMatchObject({ qualifies: true, best: cand, gain: 17.5, floorFailed: false });
  });

  test('a qualifying same-day re-time wins over a day move the floor refuses', () => {
    const refused = dayMove({ detour_minutes: 10 });
    const retime = sameDay();
    const result = rank([{ cand: refused, sc: score(95, 12.5) }, { cand: retime, sc: score(76, 12.5) }]);
    expect(result.best).toBe(retime);
    expect(result.ranked).toEqual([retime]);
  });

  test('under the bar: the audit shows the nearest miss and no fallback list', () => {
    const cand = dayMove({ detour_minutes: 0 });
    const result = rank([{ cand, sc: score(70) }]);
    expect(result).toMatchObject({ qualifies: false, best: cand, gain: 10, floorFailed: false });
  });

  test('every fallback candidate passed the same rule, best gain first, ties in encounter order', () => {
    const a = dayMove({ detour_minutes: 0, date: '2026-12-01' });
    const b = dayMove({ detour_minutes: 0, date: '2026-12-02' });
    const c = dayMove({ detour_minutes: 11, date: '2026-12-04' });
    const result = rank([{ cand: a, sc: score(80) }, { cand: c, sc: score(99) }, { cand: b, sc: score(80) }]);
    expect(result.ranked).toEqual([a, b]);
  });

  test('an overlapping visit moves without the bar or the floor, same day first', () => {
    const current = { ...CURRENT, conflict: { kind: 'overlap', date: CURRENT.date, with: ['x1'] } };
    const far = dayMove({ detour_minutes: 0 });
    const retime = sameDay({ detour_minutes: 20 });
    const result = rank([{ cand: far, sc: score(95) }, { cand: retime, sc: score(50) }], { current });
    expect(mustMove(SERVICE, current)).toBe(true);
    expect(result.qualifies).toBe(true);
    expect(result.best).toBe(retime);
    expect(result.ranked).toEqual([retime, far]);
  });

  test('a visit on a closed day takes the best gain (no same-day preference)', () => {
    const current = { ...CURRENT, conflict: { kind: 'closed_day', date: CURRENT.date } };
    const worse = dayMove({ detour_minutes: 30, date: '2026-12-02' });
    const better = dayMove({ detour_minutes: 15, date: '2026-12-04' });
    const result = rank([{ cand: worse, sc: score(40) }, { cand: better, sc: score(55) }], { current });
    expect(result.best).toBe(better);
    expect(result.ranked).toEqual([better, worse]);
  });

  test('an unplaced due-date visit accepts any placement, as before', () => {
    const unplaced = { id: 's1', window_start: null, recurring_dispatch_due_date: '2026-12-03' };
    const cand = dayMove({ detour_minutes: 40 });
    const result = rank([{ cand, sc: score(40) }], { service: unplaced, current: { ...CURRENT, start_time: null } });
    expect(result).toMatchObject({ qualifies: true, best: cand, gain: -20 });
  });
});
