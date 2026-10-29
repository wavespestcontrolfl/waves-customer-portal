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
const logger = require('../services/logger');

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
    logger.info.mockClear();
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
  // deadline or a closed picker); `answers: false` = Google got the lookups
  // but answered none (an error or a timeout).
  const fakeSources = ({ sends = true, answers = true } = {}) => {
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
      lookup: (leg) => (answers && got[mode].has(keyOf(leg)) ? answer : model),
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

  // A search looks up every leg of every order it simulates (hundreds of
  // thousands of calls); reading the Eastern clock on each one made production
  // searches take 8-10 s (audit 10-28). One read a minute gives the same keys.
  test('lookup reads the Eastern clock once a minute, not once per leg', () => {
    const et = require('../utils/datetime-et');
    const reads = jest.spyOn(et, 'etParts');
    let t = NOW.getTime();
    const { travel } = make({ now: () => t });
    for (let i = 0; i < 500; i += 1) travel.lookup(leg(i % 2 ? DATE : plus(3), 9 * 60 + (i % 240)));
    expect(reads).toHaveBeenCalledTimes(1);
    t += 60 * 1000;
    // The next minute reads it again: today's floor moves to the next hour.
    travel.lookup(leg(DATE, 9 * 60));
    expect(reads).toHaveBeenCalledTimes(2);
    // So does a clock that steps back: one slot, keyed by the minute.
    t -= 60 * 1000;
    travel.lookup(leg(DATE, 9 * 60));
    expect(reads).toHaveBeenCalledTimes(3);
    reads.mockRestore();
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

  test('lookups the source sent stay counted, and the purchase logs what Google answered', async () => {
    const { travel } = make();
    await travel.preload([leg(plus(1), 9 * 60), leg(plus(3), 9 * 60)]);
    expect(releaseRoadSpend).toHaveBeenCalledWith({ spender: 'staff-1', pro: 0, plain: 0, day: '2027-03-01' });
    expect(logger.info).toHaveBeenCalledWith('[picker-road] 2 lookups sent, 2 answered by Google');
  });

  // A staff save (GATE_SAVE_ROAD_TIMES) reads what the pickers bought and buys
  // nothing: no Google call inside a save's transaction.
  test('a cache-only source buys nothing and reads what a picker bought', async () => {
    await make().travel.preload([leg(plus(1), 9 * 60)]);
    reserveRoadSpend.mockClear();
    const save = make({ cacheOnly: true });
    await save.travel.preload([leg(plus(1), 9 * 60), leg(plus(3), 9 * 60)]);
    expect(reserveRoadSpend).not.toHaveBeenCalled();
    expect(save.asked).toEqual({ traffic: [], plain: [] });
    expect(save.travel.lookup(leg(plus(1), 9 * 60))).toMatchObject({ minutes: 17, source: 'google_traffic' });
    // A drive no picker looked up keeps the model.
    expect(save.travel.lookup(leg(plus(3), 9 * 60))).toMatchObject({ source: 'conservative_model' });
  });

  // An error or a timeout is still paid; the log line is the only place it shows.
  test('lookups Google got but did not answer stay counted and show in the log', async () => {
    const { travel } = make({}, { answers: false });
    await travel.preload([leg(plus(1), 9 * 60), leg(plus(3), 9 * 60)]);
    expect(releaseRoadSpend).toHaveBeenCalledWith({ spender: 'staff-1', pro: 0, plain: 0, day: '2027-03-01' });
    expect(logger.info).toHaveBeenCalledWith('[picker-road] 2 lookups sent, 0 answered by Google');
    expect(travel.lookup(leg(plus(1), 9 * 60))).toMatchObject({ source: 'conservative_model' });
  });

  // Pre-push audit #6881 (P1): a batch of slot checks shares one budget; run
  // at once, they must neither oversubscribe it nor buy a shared leg twice.
  test('concurrent checks on one budget buy a shared leg once, and both get its answer', async () => {
    const budget = createPickerBudget();
    const a = make({ budget });
    const b = make({ budget });
    const shared = [leg(plus(1), 9 * 60), leg(plus(3), 9 * 60)];
    await Promise.all([a.travel.preload(shared), b.travel.preload(shared)]);
    expect(a.asked.traffic.length + b.asked.traffic.length).toBe(1);
    expect(a.asked.plain.length + b.asked.plain.length).toBe(1);
    expect(reserveRoadSpend).toHaveBeenCalledTimes(1);
    for (const t of [a.travel, b.travel]) {
      expect(t.lookup(shared[0])).toMatchObject({ source: 'google_traffic' });
      expect(t.lookup(shared[1])).toMatchObject({ source: 'google_road' });
    }
  });

  // Pre-push audit #6881 (P1): at 10:00 a 10:30 leg is asked for 11:00; the
  // answer must be cached under that key (not shaped again into 12:00), or a
  // check waiting on the claim reads the model.
  test("a waiting check reads the claimed leg's answer when today's floor moved its departure", async () => {
    const budget = createPickerBudget();
    const a = make({ budget });
    const b = make({ budget });
    const today = [leg(DATE, 10 * 60 + 30)];
    await Promise.all([a.travel.preload(today), b.travel.preload(today)]);
    expect(a.asked.traffic.length + b.asked.traffic.length).toBe(1);
    expect(b.travel.lookup(today[0])).toEqual({ minutes: 17, source: 'google_traffic', reason: null });
    expect(a.travel.lookup(today[0])).toEqual({ minutes: 17, source: 'google_traffic', reason: null });
  });

  test('concurrent checks cannot oversubscribe the request budget', async () => {
    const budget = createPickerBudget();
    const many = (n, lat) => Array.from({ length: n }, (_, i) => leg(plus(1), 9 * 60, { lat: lat + i / 1000, lng: -82.3 }));
    const a = make({ budget });
    const b = make({ budget });
    await Promise.all([a.travel.preload(many(120, 27)), b.travel.preload(many(120, 28))]);
    expect(a.asked.traffic.length + b.asked.traffic.length).toBe(_test.REQUEST_MAX.traffic);
    expect(budget.traffic).toBe(_test.REQUEST_MAX.traffic);
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

// GATE_DRIVE_CLOCK (owner 2026-10-28): a Google leg carries the park minutes
// when it is READ, once, on every path; the caches keep Google's own minutes.
describe('GATE_DRIVE_CLOCK park minutes on Google legs', () => {
  const CLOCK = 'GATE_DRIVE_CLOCK';
  const FROM = { lat: '27.5000', lng: '-82.4000' };
  const TO = { lat: 27.52, lng: -82.41 };
  const plus = (n) => {
    const d = new Date(`${DATE}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const leg = (date, departureMin = 9 * 60) => ({ date, from: FROM, to: TO, departureMin });
  // Inner sources like createSchedulingTravel's: lookupRaw = Google's own
  // minutes, lookup = the same with the park minutes added by the gate.
  const realSources = (fetchImpl) => {
    const RouteOptimizer = require('../services/route-optimizer');
    const budget = () => ({ resetAt: 0, requests: 0, elements: 0, maxRequests: 100, maxElements: 100 });
    return {
      traffic: () => RouteOptimizer.createSchedulingTravel({ fetchImpl, sharedBudget: budget(), maxRequests: 100, maxElements: 100 }),
      plain: () => RouteOptimizer.createSchedulingTravel({ fetchImpl, sharedBudget: budget(), maxRequests: 100, maxElements: 100, traffic: false }),
    };
  };
  const matrix = (duration) => jest.fn(async (_url, init) => ({ ok: true, json: async () => (
    JSON.parse(init.body).destinations.map((_d, i) => ({ originIndex: 0, destinationIndex: i, status: {}, condition: 'ROUTE_EXISTS', duration }))
  ) }));
  const fakeAnswering = () => {
    const model = { minutes: 99, source: 'conservative_model', reason: 'request_budget' };
    const source = (answer) => () => {
      let bought = false;
      return {
        preload: async () => { bought = true; },
        lookup: () => (bought ? answer : model),
        diagnostics: () => ({ requests: 0, elements: bought ? 1 : 0 }),
      };
    };
    return {
      traffic: source({ minutes: 17, source: 'google_traffic', reason: null }),
      plain: source({ minutes: 14, source: 'google_road', reason: null }),
    };
  };

  // The drive clock needs the calibrated model on, as it is live.
  const savedCalibration = process.env.GATE_DRIVE_TIME_CALIBRATION;
  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'synthetic-test-key';
    process.env.GATE_DRIVE_TIME_CALIBRATION = 'true';
  });
  afterEach(() => {
    if (savedCalibration === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION;
    else process.env.GATE_DRIVE_TIME_CALIBRATION = savedCalibration;
    _test.roadCache.clear();
    _test.plainCache.clear();
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env[CLOCK];
    delete process.env.DRIVE_CLOCK_PARK_MINUTES;
    delete process.env.PICKER_ROAD_TRAFFIC_DAYS;
    delete process.env.PICKER_ROAD_PLAIN_DAYS;
  });

  test('both modes: raw off, +4 on, exactly once however often it is read, caches stay raw', async () => {
    const travel = createPickerTravel({ spender: 'staff-1', factories: fakeAnswering(), now: () => NOW.getTime() });
    await travel.preload([leg(plus(1)), leg(plus(3))]);
    expect(travel.lookup(leg(plus(1)))).toMatchObject({ minutes: 17, source: 'google_traffic' });
    process.env[CLOCK] = 'true';
    for (let i = 0; i < 3; i += 1) {
      expect(travel.lookup(leg(plus(1)))).toMatchObject({ minutes: 21, source: 'google_traffic' });
      expect(travel.lookup(leg(plus(3)))).toMatchObject({ minutes: 18, source: 'google_road' });
    }
    expect([..._test.roadCache.values()].map((v) => v.minutes)).toEqual([17]);
    expect([..._test.plainCache.values()].map((v) => v.minutes)).toEqual([14]);
    delete process.env[CLOCK];
    expect(travel.lookup(leg(plus(1))).minutes).toBe(17);
    expect(travel.lookup(leg(plus(3))).minutes).toBe(14);
  });

  test('through the real travel source: Google 11 reads 15 once, and the cache holds 11', async () => {
    process.env[CLOCK] = 'true';
    const travel = createPickerTravel({ spender: 'staff-1', factories: realSources(matrix('601s')), now: () => NOW.getTime() });
    await travel.preload([leg(plus(1)), leg(plus(3))]);
    expect(travel.lookup(leg(plus(1)))).toMatchObject({ minutes: 15, source: 'google_traffic' });
    expect(travel.lookup(leg(plus(1))).minutes).toBe(15);
    expect(travel.lookup(leg(plus(3)))).toMatchObject({ minutes: 15, source: 'google_road' });
    expect([..._test.roadCache.values()].map((v) => v.minutes)).toEqual([11]);
    expect([..._test.plainCache.values()].map((v) => v.minutes)).toEqual([11]);
    // A second request reads the process cache: still once.
    const again = createPickerTravel({ spender: 'staff-1', factories: realSources(matrix('601s')), now: () => NOW.getTime() });
    expect(again.lookup(leg(plus(1))).minutes).toBe(15);
    process.env.DRIVE_CLOCK_PARK_MINUTES = '2';
    expect(again.lookup(leg(plus(1))).minutes).toBe(13);
    delete process.env[CLOCK];
    expect(again.lookup(leg(plus(1))).minutes).toBe(11);
  });

  test('a cache-only read adds it once', async () => {
    await createPickerTravel({ spender: 'staff-1', factories: realSources(matrix('601s')), now: () => NOW.getTime() })
      .preload([leg(plus(1))]);
    process.env[CLOCK] = 'true';
    const save = createPickerTravel({ spender: 'staff-1', factories: realSources(matrix('601s')), now: () => NOW.getTime(), cacheOnly: true });
    await save.preload([leg(plus(1))]);
    expect(save.lookup(leg(plus(1)))).toMatchObject({ minutes: 15, source: 'google_traffic' });
  });

  test('a model leg (later day, or unbought) never gets the park minutes', () => {
    process.env[CLOCK] = 'true';
    const travel = createPickerTravel({ spender: 'staff-1', factories: fakeAnswering(), now: () => NOW.getTime() });
    // Later than the road days, and a road day nobody bought.
    expect(travel.lookup(leg(plus(20)))).toMatchObject({ minutes: 99, source: 'conservative_model' });
    expect(travel.lookup(leg(plus(1)))).toMatchObject({ minutes: 99, source: 'conservative_model' });
  });

  test('a same-place Google leg stays 0', async () => {
    process.env[CLOCK] = 'true';
    const here = { date: plus(1), from: TO, to: TO, departureMin: 9 * 60 };
    const travel = createPickerTravel({ spender: 'staff-1', factories: realSources(matrix('0s')), now: () => NOW.getTime() });
    await travel.preload([here]);
    expect(travel.lookup(here)).toMatchObject({ minutes: 0, source: 'google_traffic' });
  });

  describe('best-times chips (priceChipsOnRoads)', () => {
    const { priceChipsOnRoads } = require('../services/scheduling/hint-road-times');
    const { GAP_LEGS } = require('../services/scheduling/find-time');
    const chip = () => ({
      date: DATE, start_time: '10:00', drive_in_minutes: 5, detour_minutes: 3,
      [GAP_LEGS]: { prev: FROM, next: { lat: 27.6, lng: -82.5 }, newStop: TO, prevIsHome: false, prevEndMin: 700, durationMinutes: 60 },
    });
    // The three legs of the chip, answered 20, 10 and 12 minutes by Google.
    const factory = () => ({
      preload: async () => {},
      lookup: (l) => ({ minutes: l.to === TO ? 20 : (l.from === TO ? 10 : 12), source: 'google_traffic', reason: null }),
      diagnostics: () => ({ requests: 3, elements: 3 }),
    });
    const price = () => priceChipsOnRoads([chip()], { paid: true, now: () => NOW.getTime(), travelFactory: factory });
    beforeEach(() => { process.env.GATE_BEST_TIMES_ROAD_TIMES = 'true'; });
    afterEach(() => { delete process.env.GATE_BEST_TIMES_ROAD_TIMES; });

    test('off: Google minutes as they came', async () => {
      const [priced] = await price();
      expect(priced).toMatchObject({ drive_in_minutes: 20, detour_minutes: 18, drive_source: 'google' });
    });

    test('on: +4 on each leg once, on a fresh lookup and again on the cached read', async () => {
      process.env[CLOCK] = 'true';
      const [fresh] = await price();
      expect(fresh).toMatchObject({ drive_in_minutes: 24, detour_minutes: 18 + 4, drive_source: 'google' });
      expect([..._test.roadCache.values()].map((v) => v.minutes).sort()).toEqual([10, 12, 20]);
      // Cached now: no travel source is built at all, and the minutes agree.
      const cached = await priceChipsOnRoads([chip()], { paid: true, now: () => NOW.getTime(), travelFactory: () => { throw new Error('no lookup expected'); } });
      expect(cached[0]).toMatchObject({ drive_in_minutes: 24, detour_minutes: 22 });
    });
  });
});

