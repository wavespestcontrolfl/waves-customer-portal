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
  test('a same-day re-time leaves the default time window out of its gain too (owner 2026-10-09)', () => {
    expect(moveGain({
      service: SERVICE, current: CURRENT, currentScore: score(60, 0), cand: sameDay(), candScore: score(75, 12.5),
    })).toBe(2.5);
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
  test('a day move and a same-day re-time both need the configured drive saving', () => {
    expect(driveSavingMinutes(CURRENT, dayMove({ detour_minutes: 7 }))).toBe(5);
    expect(meetsDriveFloor({ current: CURRENT, cand: dayMove({ detour_minutes: 7 }), config: CONFIG })).toBe(false);
    expect(meetsDriveFloor({ current: CURRENT, cand: dayMove({ detour_minutes: 6 }), config: CONFIG })).toBe(true);
    expect(meetsDriveFloor({ current: CURRENT, cand: sameDay({ detour_minutes: 12 }), config: CONFIG })).toBe(false);
    expect(meetsDriveFloor({ current: CURRENT, cand: sameDay({ detour_minutes: 6 }), config: CONFIG })).toBe(true);
  });

  test('0 turns the floor off', () => {
    expect(meetsDriveFloor({ current: CURRENT, cand: dayMove(), config: { minDayMoveDriveSavingMinutes: 0 } })).toBe(true);
    // Off means off: a day move that adds drive is left to the score bar.
    expect(meetsDriveFloor({ current: CURRENT, cand: dayMove({ detour_minutes: 20 }), config: { minDayMoveDriveSavingMinutes: 0 } })).toBe(true);
  });

  test('a legacy grouped current placement has no detour to test, so the floor does not apply (Codex #6207 r1 P1)', () => {
    const blind = { ...CURRENT, detour_minutes: 0, detour_group_blind: true };
    expect(meetsDriveFloor({ current: blind, cand: dayMove({ detour_minutes: 3 }), config: CONFIG })).toBe(true);
    expect(meetsDriveFloor({ current: blind, cand: sameDay({ detour_minutes: 3 }), config: CONFIG })).toBe(true);
    expect(meetsDriveFloor({ current: { ...blind, detour_group_blind: undefined }, cand: dayMove({ detour_minutes: 3 }), config: CONFIG })).toBe(false);
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

  test('a same-day re-time with no drive saved no longer qualifies on the default window alone', () => {
    // A 2 PM pest visit re-timed to 8 AM: +12.5 default window, +5 elsewhere, no drive saved.
    const retime = sameDay({ detour_minutes: 12 });
    const result = rank([{ cand: retime, sc: score(77.5, 12.5) }]);
    expect(result).toMatchObject({ qualifies: false, gain: 5, floorFailed: false });
    // Even with a gain over the bar, the floor refuses it.
    const big = rank([{ cand: retime, sc: score(90, 0) }]);
    expect(big).toMatchObject({ qualifies: false, floorFailed: true });
  });

  test('a same-day re-time that saves the floor and clears the bar without the default window moves', () => {
    const retime = sameDay({ detour_minutes: 5 });
    const refused = dayMove({ detour_minutes: 10 });
    const result = rank([{ cand: refused, sc: score(95, 12.5) }, { cand: retime, sc: score(80, 0) }]);
    expect(result.best).toBe(retime);
    expect(result.ranked).toEqual([retime]);
  });

  // After its overlapping partner leaves, a visit is evaluated with no
  // conflict: this says whether it would still move then (Codex #6207 r8 P2).
  test('a visit in conflict says whether an ordinary optimization would move it anyway', () => {
    const conflict = { kind: 'overlap', date: CURRENT.date, with: ['o1'] };
    const strong = rank([{ cand: dayMove({ detour_minutes: 2 }), sc: score(90, 12.5) }], { current: { ...CURRENT, conflict } });
    expect(strong).toMatchObject({ qualifies: true, movesWithoutConflict: true });
    const weak = rank([{ cand: dayMove({ detour_minutes: 0 }), sc: score(70) }], { current: { ...CURRENT, conflict } });
    expect(weak).toMatchObject({ qualifies: true, movesWithoutConflict: false });
    expect(rank([{ cand: dayMove({ detour_minutes: 2 }), sc: score(90, 12.5) }]).movesWithoutConflict).toBe(false);
    // A slot kept past the cap only for the conflict repair is not an ordinary candidate (r11 P2).
    const pastCap = rank([{ cand: { ...dayMove({ detour_minutes: 2 }), past_cap: true }, sc: score(90, 12.5) }], { current: { ...CURRENT, conflict } });
    expect(pastCap).toMatchObject({ qualifies: true, movesWithoutConflict: false });
    expect(pastCap.normalBest).toBeUndefined();
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

describe('conflict moves: least added drive, with a ceiling (replay 2026-10-09)', () => {
  const { rankCandidates } = require('../services/auto-dispatch/move-rules');
  const cur = { date: '2026-12-07', detour_minutes: 14, conflict: { kind: 'overlap', date: '2026-12-07', with: ['o1'] } };
  const score = (total) => ({ total_score: total, default_time_score: 0 });
  const cfg = { minDayMoveDriveSavingMinutes: 6, conflictMaxAddedDriveMinutes: 15 };
  const rank = (cands) => rankCandidates({
    service: { id: 's1', window_start: '10:00' }, current: cur, currentScore: score(60), threshold: 15, config: cfg,
    scored: cands.map((c) => ({ cand: c, sc: score(c.total) })),
  });

  test('same day first, then the slot that adds the least drive, whatever the score', () => {
    const r = rank([
      { date: '2026-12-09', start_time: '09:00', detour_minutes: 4, total: 90 },
      { date: '2026-12-07', start_time: '14:00', detour_minutes: 24, total: 30 },
      { date: '2026-12-07', start_time: '12:00', detour_minutes: 16, total: 20 },
    ]);
    expect(r.qualifies).toBe(true);
    expect(r.ranked.map((c) => c.start_time)).toEqual(['12:00', '14:00', '09:00']);
  });

  test('the legacy grouped shape has no detour to compare, so the ceiling does not apply (Codex r6 P1)', () => {
    const { withinConflictCeiling } = require('../services/auto-dispatch/move-rules');
    const cand = { date: '2026-12-09', detour_minutes: 20 };
    expect(withinConflictCeiling({ current: { ...cur, detour_minutes: 0, detour_group_blind: true }, cand, config: cfg })).toBe(true);
    expect(withinConflictCeiling({ current: { ...cur, detour_minutes: 0 }, cand, config: cfg })).toBe(false);
  });

  test('a slot that adds more than the ceiling is never taken; none left means the visit stays', () => {
    const far = { date: '2026-12-09', start_time: '15:00', detour_minutes: 52, total: 30 };
    const near = { date: '2026-12-10', start_time: '09:00', detour_minutes: 29, total: 20 };
    expect(rank([far, near]).ranked).toEqual([near]);
    const none = rank([far]);
    expect(none).toMatchObject({ qualifies: false, ceilingFailed: true, floorFailed: false, best: far });
  });
});

test('a day move compares totals clamped WITHOUT the default-time credit (Codex #6207 r7 P2)', () => {
  const { moveGain } = require('../services/auto-dispatch/move-rules');
  // Components total 105 with 12.5 default-time points: capped total 100, default-free 92.5 (not 87.5).
  const cand = { total_score: 100, default_time_score: 12.5, total_without_default_time: 92.5 };
  const current = { total_score: 60, default_time_score: 0, total_without_default_time: 60 };
  expect(moveGain({ service: { window_start: '10:00' }, current: { date: '2026-12-07' }, currentScore: current, cand: { date: '2026-12-09' }, candScore: cand })).toBe(32.5);
});
