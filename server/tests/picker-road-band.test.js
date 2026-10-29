/**
 * The staff pickers' Google band (GATE_PICKER_ROAD_BAND; owner 2026-10-28 cost
 * plan, step 2: "Google only for near-best hours").
 *
 * What this locks down, on a real route check (arrival-route.js) and a travel
 * source shaped like the pickers' (preload buys, lookup reads):
 *  1. The route check evaluates only the hours it is given (`startsOnly`).
 *  2. A road day buys Google road times only for its hours near its best
 *     (within 5 minutes of the least added drive, and always its 3 best), so a
 *     search buys fewer lookups than driving every hour, and the day's best
 *     hour is driven on Google. The other hours keep the model.
 *  3. When Google leaves an hour outside the band ahead of every hour in it,
 *     that hour joins the band and is driven too.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { enumerateArrivalPlacements } = require('../services/scheduling/arrival-route');
const { _internals: { preloadBandLegs } } = require('../services/scheduling/find-time');

const DATE = '2027-03-02';
const NOW = new Date('2027-03-01T15:00:00Z');
const stop = (id, windowStart, lat, lng) => ({
  id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
  window_start: windowStart, window_end: `${String(Number(windowStart.slice(0, 2)) + 2).padStart(2, '0')}:00`,
  estimated_duration_minutes: 30, lat, lng, route_order: null, created_at: '2020-01-01T12:00:00Z',
});
// Three stops through the day; the visit being placed sits near the second.
// On the model it fits at 9 and 10 (adds 5 min), 12 to 14 (9) and 16 and 17 (13).
const route = (travel) => ({
  date: DATE,
  limits: { durationMinutes: 45, earliestStartMin: 8 * 60, latestServiceEndMin: 18 * 60 },
  context: {
    date: DATE, now: NOW, grouped: false, travel,
    target: { ...stop('target', '13:00', 27.48, -82.43), estimated_duration_minutes: 45 },
    rows: [stop('a', '08:00', 27.45, -82.40), stop('b', '11:00', 27.50, -82.45), stop('c', '15:00', 27.40, -82.55)],
  },
});

const miles = (a, b) => {
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const h = Math.sin((rad(b.lat) - rad(a.lat)) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin((rad(b.lng) - rad(a.lng)) / 2) ** 2;
  return 2 * 3959 * Math.asin(Math.sqrt(h));
};
// The pickers' traffic-aware keys: a leg is asked at its part of the day.
const part = (minute) => (minute < 11 * 60 ? 9 : minute < 14 * 60 ? 12 : 16);
const legKey = (leg) => `${part(leg.departureMin)}|${leg.from.lat},${leg.from.lng}>${leg.to.lat},${leg.to.lng}`;
const modelMinutes = (leg) => Math.ceil(4 + 2.3 * miles(leg.from, leg.to));
const touchesTarget = (leg) => [leg.from, leg.to].some((p) => Number(p.lat) === 27.48 && Number(p.lng) === -82.43);

// Buys what it is asked (`google(leg, model)` = Google's answer); a leg it never
// bought gets the model, as the pickers' source does past its budget.
function fakeTravel(google = (leg, model) => model) {
  const bought = new Map();
  return {
    bought,
    async preload(legs) {
      for (const leg of legs) if (!bought.has(legKey(leg))) bought.set(legKey(leg), google(leg, modelMinutes(leg)));
    },
    lookup(leg) {
      const minutes = bought.get(legKey(leg));
      return minutes != null ? { minutes, source: 'google_traffic', reason: null }
        : { minutes: modelMinutes(leg), source: 'conservative_model', reason: 'request_budget' };
    },
  };
}

const ranked = (placements) => [...placements].sort((a, b) => a.fit.detourMinutes - b.fit.detourMinutes
  || a.windowStart.localeCompare(b.windowStart));
const onGoogle = (placements) => placements.filter((p) => p.fit.travelSource === 'google_traffic').map((p) => p.windowStart);

test('the route check evaluates only the hours it is given', () => {
  const { context, limits } = route(null);
  const all = enumerateArrivalPlacements(context, limits);
  const some = enumerateArrivalPlacements(context, { ...limits, startsOnly: new Set(['09:00', '15:00', '16:00']) });
  expect(all.evaluated).toBe(10);
  expect(some.evaluated).toBe(3);
  // 15:00 does not fit; the others are the full enumeration's own answers.
  expect(some.placements).toEqual(all.placements.filter((p) => ['09:00', '16:00'].includes(p.windowStart)));
  expect(some.rejections).toEqual({ arrival_window: 1 });
});

test('a road day buys Google only near its best hour, and its best hour is a Google hour', async () => {
  // Every hour on Google, as the pickers drive a road day today.
  const every = route(fakeTravel());
  for (let pass = 0; pass < 3; pass++) {
    const legs = [];
    enumerateArrivalPlacements(every.context, { ...every.limits, collectLegs: legs });
    await every.context.travel.preload(legs);
  }
  const band = route(fakeTravel());
  await preloadBandLegs(band.context.travel, [band]);
  expect(band.context.travel.bought.size).toBeGreaterThan(0);
  expect(band.context.travel.bought.size).toBeLessThan(every.context.travel.bought.size);

  const { placements } = enumerateArrivalPlacements(band.context, band.limits);
  const google = onGoogle(placements);
  // At least the 3 best hours, never every hour; the rest keep the model.
  expect(google.length).toBeGreaterThanOrEqual(3);
  expect(google.length).toBeLessThan(placements.length);
  const best = ranked(placements)[0];
  expect(google).toContain(best.windowStart);
  // Each hour on Google is within 5 minutes of the day's best, or one of its 3 best.
  const model = enumerateArrivalPlacements(route(null).context, band.limits).placements;
  const modelBest = ranked(model)[0].fit.detourMinutes;
  const top3 = ranked(model).slice(0, 3).map((p) => p.windowStart);
  for (const start of google) {
    const hour = model.find((p) => p.windowStart === start);
    expect(top3.includes(start) || hour.fit.detourMinutes <= modelBest + 5).toBe(true);
  }
});

test('an hour Google leaves ahead of the whole band joins it and is driven too', async () => {
  // Google is far slower than the model into and out of the visit at midday,
  // so every hour in the first band falls behind an hour the band left out.
  const slowMidday = (leg, model) => (touchesTarget(leg) && part(leg.departureMin) === 12 ? model + 30 : model);
  const first = route(null);
  const firstBand = ranked(enumerateArrivalPlacements(first.context, first.limits).placements).slice(0, 3).map((p) => p.windowStart);
  const band = route(fakeTravel(slowMidday));
  await preloadBandLegs(band.context.travel, [band]);
  const { placements } = enumerateArrivalPlacements(band.context, band.limits);
  const best = ranked(placements)[0];
  // The day's best hour is still a Google hour, and one the first band did not hold.
  expect(best.fit.travelSource).toBe('google_traffic');
  expect(onGoogle(placements).some((start) => !firstBand.includes(start))).toBe(true);
});
