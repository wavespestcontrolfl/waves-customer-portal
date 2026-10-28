/**
 * Google inside the staff pickers' route check (GATE_PICKER_ROAD_CHECK,
 * owner 2026-10-26: "we need to run Google inside the scheduling check
 * itself" — "Next 7 days", "His current stop").
 *
 * What this locks down:
 *  1. Today's route under way: without the picker's active stop the day is
 *     unverified, as before; with it the day continues from that stop, after
 *     its job, and Google-driven fits say so (travelSource).
 *  2. The picker's travel source buys the cheapest Google answer that fits
 *     each leg's day (owner 2026-10-27: "make sure costs are appropriate"):
 *     today and tomorrow traffic-aware at three departure times a day; the
 *     next days a road time without traffic, once per pair of places; later
 *     days and legs that already left today the model. Every lookup is
 *     reserved first (per-request budget, durable ceilings); a refusal or a
 *     closed picker buys nothing. A second look is served from the cache.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/picker-road-spend', () => ({
  reserveRoadSpend: jest.fn(async () => ({ allowed: true, day: '2027-03-01' })),
  releaseRoadSpend: jest.fn(async () => {}),
}));

const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
const { createPickerTravel, createPickerBudget, _test } = require('../services/scheduling/hint-road-times');
const { reserveRoadSpend, releaseRoadSpend } = require('../services/scheduling/picker-road-spend');

// 10:00 ET on 2027-03-01.
const NOW = new Date('2027-03-01T15:00:00Z');
const DATE = '2027-03-01';
const stop = (id, windowStart, lat, overrides = {}) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: `${String(Number(windowStart.slice(0, 2)) + 2).padStart(2, '0')}:00`,
  estimated_duration_minutes: 60, lat, lng: -82.4, route_order: null,
  created_at: '2020-01-01T12:00:00Z', ...overrides,
});

describe("today's route under way", () => {
  // On site since 9:30 ET at a 9 AM stop with an hour's job: free at 10:30.
  const onSite = () => stop('on-site', '09:00', 27.5, { status: 'on_site' });
  const target = () => stop('target', '13:00', 27.52);
  const context = (overrides = {}) => ({
    date: DATE, now: NOW, target: target(), rows: [onSite()], grouped: false, ...overrides,
  });
  const fitAt = (ctx) => evaluateArrivalPlacement(ctx, { windowStart: '13:00', windowEnd: '15:00', durationMinutes: 60 });

  test('without the active stop the day stays unverified, as before', () => {
    expect(fitAt(context())).toMatchObject({ feasible: false, reason: 'route_unverified' });
  });

  test('with it the day continues from that stop, after its job', () => {
    const activeStop = { id: 'on-site', arrived_at: '2027-03-01T14:30:00Z' };
    const fit = fitAt(context({ activeStop }));
    expect(fit.feasible).toBe(true);
    // The on-site stop is the origin, not a stop to drive to again.
    expect(fit.arrivals.map((a) => a.id)).toEqual(['target']);
    expect(fit.travelSource).toBeUndefined();
  });

  test('two stops under way stay unverified', () => {
    const rows = [onSite(), stop('en-route', '11:00', 27.6, { status: 'en_route' })];
    expect(fitAt(context({ rows, activeStop: { id: 'on-site' } }))).toMatchObject({ reason: 'route_unverified' });
  });

  test('a fit driven on Google says so', () => {
    const travel = { lookup: () => ({ minutes: 12, source: 'google_traffic', reason: null }) };
    const fit = fitAt(context({ activeStop: { id: 'on-site', arrived_at: '2027-03-01T14:30:00Z' }, travel }));
    expect(fit).toMatchObject({ feasible: true, travelSource: 'google_traffic' });
  });
});

describe('createPickerTravel', () => {
  afterEach(() => {
    _test.roadCache.clear();
    _test.plainCache.clear();
    reserveRoadSpend.mockClear();
    releaseRoadSpend.mockClear();
    delete process.env.PICKER_ROAD_TRAFFIC_DAYS;
    delete process.env.PICKER_ROAD_PLAIN_DAYS;
  });
  const FROM = { lat: '27.5000', lng: '-82.4000' };
  const TO = { lat: 27.52, lng: -82.41 };
  const plus = (n) => {
    const d = new Date(`${DATE}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // Inner sources that record what they were asked and answer as Google would.
  // Like createSchedulingTravel: only a leg it sent has Google's answer (any
  // other leg gets the conservative model), and diagnostics() counts what it
  // sent. `sends: false` = a source that sends nothing (its burst allowance,
  // deadline or a closed picker).
  const fakeSources = ({ sends = true } = {}) => {
    const asked = { traffic: [], plain: [] };
    const trafficKey = (leg) => `${leg.date}@${leg.departureMin}|${leg.to.lat}`;
    const pairKey = (leg) => `${leg.from.lat}>${leg.to.lat}`;
    const got = { traffic: new Set(), plain: new Set() };
    const sent = { traffic: 0, plain: 0 };
    const model = { minutes: 99, source: 'conservative_model', reason: 'request_budget' };
    const source = (mode, keyOf, answer, label) => () => ({
      preload: async (legs) => {
        if (!sends) return;
        asked[mode].push(...legs.map(label));
        legs.forEach((leg) => got[mode].add(keyOf(leg)));
        sent[mode] += legs.length;
      },
      lookup: (leg) => (got[mode].has(keyOf(leg)) ? answer : model),
      diagnostics: () => ({ requests: sent[mode], elements: sent[mode] }),
    });
    return {
      asked,
      factories: {
        traffic: source('traffic', trafficKey, { minutes: 17, source: 'google_traffic', reason: null }, (leg) => `${leg.date}@${leg.departureMin}`),
        plain: source('plain', pairKey, { minutes: 14, source: 'google_road', reason: null }, (leg) => leg.date),
      },
    };
  };
  const leg = (date, departureMin, to = TO) => ({ date, from: FROM, to, departureMin });
  const make = (opts = {}, fakeOpts = {}) => {
    const fake = fakeSources(fakeOpts);
    const travel = createPickerTravel({ spender: 'staff-1', factories: fake.factories, now: () => NOW.getTime(), ...opts });
    return { ...fake, travel };
  };

  test('today and tomorrow: traffic-aware at three departure times a day', async () => {
    const { travel, asked } = make();
    await travel.preload([
      // Today (10:00 now): never before the next whole hour, so 11:00.
      leg(DATE, 10 * 60 + 5), leg(DATE, 10 * 60 + 40),
      // Tomorrow: before 11:00 -> 09:00, before 14:00 -> 12:00, after -> 16:00.
      leg(plus(1), 8 * 60 + 30), leg(plus(1), 10 * 60 + 55), leg(plus(1), 12 * 60 + 30), leg(plus(1), 15 * 60), leg(plus(1), 18 * 60 + 30),
    ]);
    expect(asked.traffic).toEqual([`${DATE}@660`, `${plus(1)}@540`, `${plus(1)}@720`, `${plus(1)}@960`]);
    expect(asked.plain).toEqual([]);
    expect(travel.lookup(leg(plus(1), 18 * 60 + 30))).toEqual({ minutes: 17, source: 'google_traffic', reason: null });
    expect(reserveRoadSpend).toHaveBeenCalledWith({ spender: 'staff-1', pro: 4, plain: 0 });
  });

  // Codex #6881: the first drive of a same-day search leaves this minute (or
  // at an on-site job's estimated end, already past); it is still to come.
  test("today's drive leaving now or at a past estimate is asked at the next whole hour", async () => {
    const { travel, asked } = make();
    await travel.preload([leg(DATE, 10 * 60), leg(DATE, 9 * 60 + 30)]);
    expect(asked.traffic).toEqual([`${DATE}@660`]);
    expect(reserveRoadSpend).toHaveBeenCalledWith({ spender: 'staff-1', pro: 1, plain: 0 });
    expect(travel.lookup(leg(DATE, 10 * 60))).toEqual({ minutes: 17, source: 'google_traffic', reason: null });
    expect(travel.lookup(leg(DATE, 9 * 60 + 30))).toEqual({ minutes: 17, source: 'google_traffic', reason: null });
  });

  test('the next days: one road time without traffic per pair of places, whatever the hour', async () => {
    const { travel, asked } = make();
    await travel.preload([leg(plus(3), 9 * 60), leg(plus(3), 15 * 60), leg(plus(4), 11 * 60)]);
    expect(asked.plain).toHaveLength(1);
    expect(asked.traffic).toEqual([]);
    expect(reserveRoadSpend).toHaveBeenCalledWith({ spender: 'staff-1', pro: 0, plain: 1 });
    expect(travel.lookup(leg(plus(4), 17 * 60))).toEqual({ minutes: 14, source: 'google_road', reason: null });
  });

  test('later days are never asked: the model', async () => {
    const { travel, asked } = make();
    await travel.preload([leg(plus(7), 9 * 60), leg(plus(20), 9 * 60)]);
    expect(asked).toEqual({ traffic: [], plain: [] });
    expect(reserveRoadSpend).not.toHaveBeenCalled();
    expect(travel.lookup(leg(plus(7), 9 * 60))).toMatchObject({ source: 'conservative_model' });
  });

  test('the road days follow PICKER_ROAD_TRAFFIC_DAYS and PICKER_ROAD_PLAIN_DAYS', async () => {
    process.env.PICKER_ROAD_TRAFFIC_DAYS = '1';
    process.env.PICKER_ROAD_PLAIN_DAYS = '0';
    const { travel, asked } = make();
    await travel.preload([leg(DATE, 13 * 60), leg(plus(1), 9 * 60), leg(plus(2), 9 * 60)]);
    // Today only: 13:00 leaves in the midday part (12:00).
    expect(asked.traffic).toEqual([`${DATE}@720`]);
    expect(asked.plain).toEqual([]);
  });

  test('a ceiling refusal buys nothing, and the rest of the request stays on the model', async () => {
    reserveRoadSpend.mockResolvedValueOnce({ allowed: false, reason: 'daily_cap' });
    const budget = createPickerBudget();
    const { travel, asked } = make({ budget });
    await travel.preload([leg(plus(1), 9 * 60)]);
    await travel.preload([leg(plus(1), 13 * 60)]);
    expect(asked).toEqual({ traffic: [], plain: [] });
    expect(budget.refused).toBe('daily_cap');
    expect(reserveRoadSpend).toHaveBeenCalledTimes(1);
    expect(travel.lookup(leg(plus(1), 9 * 60))).toMatchObject({ source: 'conservative_model' });
  });

  test('a closed picker buys nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const { travel, asked } = make({ budget: createPickerBudget({ signal: controller.signal }) });
    await travel.preload([leg(plus(1), 9 * 60)]);
    expect(asked).toEqual({ traffic: [], plain: [] });
    expect(reserveRoadSpend).not.toHaveBeenCalled();
  });

  test('one request buys at most its budget, shared by every source it builds', async () => {
    const budget = createPickerBudget();
    const many = (n, date) => Array.from({ length: n }, (_, i) => leg(date, 9 * 60, { lat: 27 + i / 1000, lng: -82.3 }));
    const first = make({ budget });
    await first.travel.preload(many(120, plus(1)));
    const second = make({ budget });
    await second.travel.preload(many(120, plus(1)).map((l, i) => ({ ...l, to: { lat: 28 + i / 1000, lng: -82.3 } })));
    expect(first.asked.traffic).toHaveLength(120);
    expect(second.asked.traffic).toHaveLength(_test.REQUEST_MAX.traffic - 120);
    expect(budget.traffic).toBe(_test.REQUEST_MAX.traffic);
  });

  // Pre-push audit #6881 (P1): a reservation the source never sent (burst
  // allowance, deadline, closed picker) is given back, on its own day.
  test('lookups the source never sent are given back', async () => {
    const budget = createPickerBudget();
    const { travel, asked } = make({ budget }, { sends: false });
    await travel.preload([leg(plus(1), 9 * 60), leg(plus(3), 9 * 60)]);
    expect(asked).toEqual({ traffic: [], plain: [] });
    expect(reserveRoadSpend).toHaveBeenCalledWith({ spender: 'staff-1', pro: 1, plain: 1 });
    expect(releaseRoadSpend).toHaveBeenCalledWith({ spender: 'staff-1', pro: 1, plain: 1, day: '2027-03-01' });
    expect(budget).toMatchObject({ traffic: 0, plain: 0 });
  });

  test('lookups the source sent stay counted', async () => {
    const { travel } = make();
    await travel.preload([leg(plus(1), 9 * 60), leg(plus(3), 9 * 60)]);
    expect(releaseRoadSpend).toHaveBeenCalledWith({ spender: 'staff-1', pro: 0, plain: 0, day: '2027-03-01' });
  });

  test('a second look is served from the cache', async () => {
    const legs = [leg(plus(1), 10 * 60 + 5), leg(plus(1), 10 * 60 + 40), leg(plus(3), 9 * 60)];
    const first = make();
    await first.travel.preload(legs);
    expect(first.asked.traffic).toEqual([`${plus(1)}@540`]);
    const again = make();
    await again.travel.preload(legs);
    expect(again.asked).toEqual({ traffic: [], plain: [] });
    expect(again.travel.lookup(legs[0])).toMatchObject({ minutes: 17, source: 'google_traffic' });
    expect(again.travel.lookup(legs[2])).toMatchObject({ minutes: 14, source: 'google_road' });
  });
});
