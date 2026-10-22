/**
 * route-optimizer with a non-office start (GATE_TECH_START_POINTS part 3).
 * A staff caller passes a technician's start point as startLat/startLng; the
 * unoptimized baseline, the single-stop answer and the leg labels must all
 * follow it, and an office (or absent) start must read exactly as before.
 * No Google key in the test env, so optimizeRoute uses the nearest-neighbour
 * fallback.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const RouteOptimizer = require('../services/route-optimizer');

const HOME = { lat: 27.0998, lng: -82.4543 }; // synthetic point south of the office
const stops = [
  { id: 'a', lat: 27.11, lng: -82.45, customerName: 'Stop A' },
  { id: 'b', lat: 27.12, lng: -82.46, customerName: 'Stop B' },
];

let savedKeys;
beforeAll(() => {
  savedKeys = [process.env.GOOGLE_API_KEY, process.env.GOOGLE_MAPS_API_KEY];
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
});
afterAll(() => {
  if (savedKeys[0] !== undefined) process.env.GOOGLE_API_KEY = savedKeys[0];
  if (savedKeys[1] !== undefined) process.env.GOOGLE_MAPS_API_KEY = savedKeys[1];
});

describe('multi-stop route', () => {
  test('office start (explicit or absent): legs are labelled HQ and the baseline is the office loop', async () => {
    const explicit = await RouteOptimizer.optimizeRoute(stops, { startLat: RouteOptimizer.HQ.lat, startLng: RouteOptimizer.HQ.lng, endAtStart: true });
    const absent = await RouteOptimizer.optimizeRoute(stops, { endAtStart: true });
    expect(explicit.legs[0].from).toBe('HQ');
    expect(explicit.legs.at(-1).to).toBe('HQ');
    expect(explicit.unoptimizedDistanceMeters).toBe(absent.unoptimizedDistanceMeters);
    expect(explicit.unoptimizedDistanceMeters).toBeGreaterThan(40000);
  });

  test('home start: the route, its baseline and its return all use the start point, never the label HQ', async () => {
    const home = await RouteOptimizer.optimizeRoute(stops, { startLat: HOME.lat, startLng: HOME.lng, endAtStart: true });
    expect(home.legs[0].from).toBe('Start');
    expect(home.legs.at(-1).to).toBe('Start');
    expect(JSON.stringify(home.legs)).not.toContain('HQ');
    // Home sits a mile or two from the stops: a loop from there is far shorter.
    expect(home.unoptimizedDistanceMeters).toBeLessThan(6000);
    expect(home.totalDistanceMeters).toBeLessThan(10000);
    expect(JSON.stringify(home)).not.toContain(String(HOME.lat));
  });
});

describe('single stop', () => {
  test('office start: the legacy HQ round trip', async () => {
    const one = await RouteOptimizer.optimizeRoute([stops[0]], {});
    expect(one.legs.map((l) => [l.from, l.to])).toEqual([['HQ', 'Stop A'], ['Stop A', 'HQ']]);
    expect(one.totalDistanceMeters).toBeGreaterThan(40000);
  });

  test('home start: the round trip is measured from home', async () => {
    const one = await RouteOptimizer.optimizeRoute([stops[0]], { startLat: HOME.lat, startLng: HOME.lng, endAtStart: true });
    expect(one.legs.map((l) => [l.from, l.to])).toEqual([['Start', 'Stop A'], ['Stop A', 'Start']]);
    expect(one.totalDistanceMeters).toBeLessThan(5000);
  });
});
