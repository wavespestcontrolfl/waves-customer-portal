// Auto-dispatch road check (owner 2026-10-09, "drive time yes"): the drive
// floor asked again on real roads before an ordinary move. The road answers
// here come from a fake reader; route-optimizer's own reader has its suites.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { routeCost } = require('../services/auto-dispatch/route-model');
const { HQ } = require('../services/auto-dispatch/geo');
const roadCheck = require('../services/auto-dispatch/road-check');

const { ROAD_LEGS, roadLegsOf, confirmOnRoads, roadResultOf } = roadCheck;

const A = { lat: 27.40, lng: -82.50 };
const B = { lat: 27.45, lng: -82.45 };
const V = { lat: 27.42, lng: -82.48 };
const stop = (id, geo, startMin) => ({ id, geo, startMin, estimated_duration_minutes: 30 });

describe('the legs of a placement (route-model.js neighbours)', () => {
  test('the stops before and after the visit, in the order dispatch runs the day', () => {
    const cost = routeCost([stop('a', A, 480), stop('b', B, 720)], stop('v', V, 600));
    expect(cost.neighbours).toEqual({ prev: A, stop: V, next: B });
  });

  test('home base stands at either end of the day', () => {
    expect(routeCost([stop('a', A, 600)], stop('v', V, 480)).neighbours).toEqual({ prev: HQ, stop: V, next: A });
    expect(routeCost([stop('a', A, 480)], stop('v', V, 600)).neighbours).toEqual({ prev: A, stop: V, next: HQ });
    expect(routeCost([], stop('v', V, 600)).neighbours).toEqual({ prev: HQ, stop: V, next: HQ });
  });

  test('a stop with no pin is not a neighbour; a visit with no pin has no legs', () => {
    const cost = routeCost([stop('a', A, 480), stop('nopin', null, 540), stop('b', B, 720)], stop('v', V, 600));
    expect(cost.neighbours).toEqual({ prev: A, stop: V, next: B });
    expect(routeCost([stop('a', A, 480)], stop('v', null, 600)).neighbours).toBeUndefined();
  });

  test('roadLegsOf carries the date and hour; nothing without neighbours or an hour', () => {
    const cost = routeCost([stop('a', A, 480)], stop('v', V, 600));
    expect(roadLegsOf(cost, '2026-08-11', 600)).toEqual({ prev: A, stop: V, next: HQ, date: '2026-08-11', startMin: 600 });
    expect(roadLegsOf(cost, '2026-08-11', null)).toBeNull();
    expect(roadLegsOf(null, '2026-08-11', 600)).toBeNull();
  });
});

describe('confirmOnRoads', () => {
  const config = { roadCheckEnabled: true, minDayMoveDriveSavingMinutes: 6 };
  const service = { id: 's1', window_start: '09:00' };
  // Each placement has its own "stop" pin; the fake reader prices a leg by
  // the placement it belongs to: [in, out, base].
  const place = (name, extra = {}) => ({
    name, ...extra, [ROAD_LEGS]: { prev: { p: name }, stop: { s: name }, next: { n: name }, date: extra.date, startMin: 540 },
  });
  const travelWith = (table, asked = []) => ({
    preload: jest.fn(async (legs) => { asked.push(...legs); }),
    lookup: (leg) => {
      const name = leg.from.p || leg.from.s;
      const legs = table[name];
      if (!legs) return { minutes: 12, source: 'conservative_model' };
      const index = leg.from.s ? 1 : (leg.to.s ? 0 : 2);
      return { minutes: legs[index], source: 'google_traffic' };
    },
  });
  const current = place('now', { date: '2026-08-04', detour_minutes: 40 });
  const rankedOf = (...names) => {
    const rows = names.map((name, i) => ({ cand: place(name, { date: '2026-08-11', detour_minutes: i }), sc: { total_score: 90 - i }, gain: 30 - i }));
    return {
      best: rows[0].cand, bestScore: rows[0].sc, gain: rows[0].gain, qualifies: true, ranked: rows.map((r) => r.cand), rankedRows: rows,
    };
  };
  const run = (ranked, table, extra = {}) => confirmOnRoads(ranked, {
    service, current, config, travel: travelWith(table), ...extra,
  });

  test('the best slot keeps the floor on real roads: it moves, with the road numbers on it', async () => {
    // now: 20 + 20 - 10 = 30 detour; first: 10 + 10 - 10 = 10. Saving 20.
    const out = await run(rankedOf('first', 'second'), { now: [20, 20, 10], first: [10, 10, 10] });
    expect(out.qualifies).toBe(true);
    expect(out.best.name).toBe('first');
    expect(roadResultOf(out.best)).toEqual({ saving_minutes: 20, current_detour_minutes: 30, candidate_detour_minutes: 10, source: 'google' });
    // The fallback list is the checked slot only; apply.js re-evaluates after a refusal.
    expect(out.ranked.map((c) => c.name)).toEqual(['first']);
  });

  test('the best slot saves too little on real roads: the next one that keeps the floor moves instead', async () => {
    const out = await run(rankedOf('first', 'second'), { now: [20, 20, 10], first: [18, 18, 10], second: [12, 12, 10] });
    expect(out.best.name).toBe('second');
    expect(out).toMatchObject({ qualifies: true, gain: 29, bestScore: { total_score: 89 } });
    expect(roadResultOf(out.best).saving_minutes).toBe(16);
  });

  test('every measured slot fails: nothing moves, and the row names the best slot\'s road numbers', async () => {
    const out = await run(rankedOf('first', 'second', 'third', 'fourth'), { now: [20, 20, 10], first: [18, 18, 10], second: [19, 19, 10], third: [20, 20, 10], fourth: [1, 1, 10] });
    expect(out).toMatchObject({ qualifies: false, roadFailed: true, ranked: [] });
    expect(out.best.name).toBe('first');
    expect(roadResultOf(out.best).saving_minutes).toBe(4);
  });

  test('only the top slots are measured, one at a time: a passing best slot buys six legs', async () => {
    const asked = [];
    await confirmOnRoads(rankedOf('first', 'second', 'third'), {
      service, current, config, travel: travelWith({ now: [20, 20, 10], first: [10, 10, 10] }, asked),
    });
    expect(asked).toHaveLength(6);
    expect(asked.every((leg) => leg.departureMin === 540)).toBe(true);
    // Each side is asked on its own date: the day it has, the day it would take.
    expect(asked.map((leg) => leg.date)).toEqual(['2026-08-04', '2026-08-04', '2026-08-04', '2026-08-11', '2026-08-11', '2026-08-11']);
  });

  test('Google has no answer for the best slot: the model\'s result stands, unchanged', async () => {
    const ranked = rankedOf('first', 'second');
    expect(await run(ranked, { now: [20, 20, 10] })).toBe(ranked);
    expect(await run(ranked, { first: [10, 10, 10] })).toBe(ranked);
  });

  test('a later slot Google cannot answer for passes on the model\'s number', async () => {
    const out = await run(rankedOf('first', 'second'), { now: [20, 20, 10], first: [18, 18, 10] });
    // "now" is answered, "second" is not: the second slot is not measured.
    expect(out.best.name).toBe('second');
    expect(out.qualifies).toBe(true);
    expect(roadResultOf(out.best)).toEqual({ source: 'estimate' });
  });

  test('a road detour is never negative', async () => {
    // first: 2 + 2 - 10 would be -6; it reads 0, so the saving is the current detour.
    const out = await run(rankedOf('first'), { now: [20, 20, 10], first: [2, 2, 10] });
    expect(roadResultOf(out.best)).toMatchObject({ candidate_detour_minutes: 0, saving_minutes: 30 });
  });

  test('the check does not apply: gate off, floor off, no reader, nothing qualifying, a visit that must move', async () => {
    const ranked = rankedOf('first');
    const table = { now: [20, 20, 10], first: [18, 18, 10] };
    expect(await run(ranked, table, { config: { ...config, roadCheckEnabled: false } })).toBe(ranked);
    expect(await run(ranked, table, { config: { ...config, minDayMoveDriveSavingMinutes: 0 } })).toBe(ranked);
    expect(await run(ranked, table, { travel: null })).toBe(ranked);
    const none = { ...ranked, qualifies: false };
    expect(await run(none, table)).toBe(none);
    // In conflict, or no arrival time yet: it has to move; its ceiling stays on the model.
    expect(await run(ranked, table, { current: { ...current, conflict: { kind: 'overlap' } } })).toBe(ranked);
    expect(await run(ranked, table, { service: { id: 's1', window_start: null, recurring_dispatch_due_date: '2026-08-06' } })).toBe(ranked);
    // The legacy grouped shape has no usable current detour.
    expect(await run(ranked, table, { current: { ...current, detour_group_blind: true } })).toBe(ranked);
  });

  test('a reader that throws keeps the model\'s result', async () => {
    const ranked = rankedOf('first');
    const travel = { preload: jest.fn(async () => { throw new Error('network down'); }), lookup: () => null };
    expect(await confirmOnRoads(ranked, { service, current, config, travel })).toBe(ranked);
  });
});
