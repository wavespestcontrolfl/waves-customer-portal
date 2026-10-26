/**
 * Google inside the staff pickers' route check (GATE_PICKER_ROAD_CHECK,
 * owner 2026-10-26: "we need to run Google inside the scheduling check
 * itself" — "Next 7 days", "His current stop").
 *
 * What this locks down:
 *  1. Today's route under way: without the picker's active stop the day is
 *     unverified, as before; with it the day continues from that stop, after
 *     its job, and Google-driven fits say so (travelSource).
 *  2. The picker's travel source rounds departures up to the hour, so one
 *     Google answer serves every simulation leaving in that hour, and a
 *     second look is served from the process cache.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
const { createPickerTravel, _test } = require('../services/scheduling/hint-road-times');

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
  afterEach(() => _test.roadCache.clear());
  const FROM = { lat: '27.5000', lng: '-82.4000' };
  const TO = { lat: 27.52, lng: -82.41 };
  const fakeInner = () => {
    const asked = [];
    return {
      asked,
      factory: () => ({
        preload: async (legs) => { asked.push(...legs.map((leg) => leg.departureMin)); },
        lookup: (leg) => (leg.departureMin % 60 === 0
          ? { minutes: 17, source: 'google_traffic', reason: null }
          : { minutes: 99, source: 'conservative_model', reason: 'request_budget' }),
      }),
    };
  };

  test('departures round up to the hour; a second look is served from the cache', async () => {
    const first = fakeInner();
    const travel = createPickerTravel({ factory: first.factory });
    const legs = [{ date: DATE, from: FROM, to: TO, departureMin: 10 * 60 + 5 }, { date: DATE, from: FROM, to: TO, departureMin: 10 * 60 + 40 }];
    await travel.preload(legs);
    expect(first.asked).toEqual([660, 660]);
    expect(travel.lookup(legs[1])).toEqual({ minutes: 17, source: 'google_traffic', reason: null });

    const second = fakeInner();
    const again = createPickerTravel({ factory: second.factory });
    await again.preload(legs);
    expect(second.asked).toEqual([]);
    expect(again.lookup(legs[0])).toMatchObject({ minutes: 17, source: 'google_traffic' });
  });
});
