/**
 * Auto-dispatch drive-time estimator — the calibrated model.
 *
 * The model is the GPS-fitted drive clock pair (fixed per-leg overhead +
 * per-mile rate; the old haversine x 1.4 @ 30 mph constants are gone). Pins:
 *  - the fitted two-term model applies;
 *  - co-located points cost nothing — the fixed overhead must not be charged
 *    for a leg that isn't a drive;
 *  - missing/garbage coordinates still return 0 rather than NaN.
 */
const { driveMin, milesToDriveMinutes } = require('../services/auto-dispatch/geo');
const routeOptimizer = require('../services/route-optimizer');
const autoDispatchGeo = require('../services/auto-dispatch/geo');

// Two real SW Florida points ~17 straight-line miles apart (Venice → Sarasota).
const VENICE = { lat: 27.0998, lng: -82.4543 };
const SARASOTA = { lat: 27.3364, lng: -82.5307 };

describe('drive-time estimator', () => {
  describe('calibrated model', () => {
    test('applies fixed overhead + per-mile rate', () => {
      // 10 mi -> 7.9 + 22 = 29.9 -> 30
      expect(milesToDriveMinutes(10)).toBe(30);
      // 5 mi -> 7.9 + 11 = 18.9 -> 19
      expect(milesToDriveMinutes(5)).toBe(19);
    });

    test('charges the per-leg overhead on a short but real drive', () => {
      // 0.5 mi -> 7.9 + 1.1 = 9. A stop is never free.
      expect(milesToDriveMinutes(0.5)).toBe(9);
    });

    test('scores a real leg with the fitted pair', () => {
      expect(driveMin(VENICE, SARASOTA)).toBe(45);
    });

    test('makes inserting an en-route stop cost real time', () => {
      // detour = d(prev,new) + d(new,next) - d(prev,next) for a stop sitting
      // essentially on the line between its neighbours. The fixed per-leg
      // overhead survives the subtraction, so a collinear stop is never free.
      // Asserted as a bound rather than an exact figure because each leg
      // rounds to whole minutes independently.
      const prev = { lat: 27.1000, lng: -82.4500 };
      const mid = { lat: 27.2000, lng: -82.4900 };
      const next = { lat: 27.3000, lng: -82.5300 };
      const detour = driveMin(prev, mid) + driveMin(mid, next) - driveMin(prev, next);
      expect(detour).toBeGreaterThanOrEqual(3);
    });
  });

  describe('invariants', () => {
    test('co-located points cost 0', () => {
      expect(driveMin(VENICE, VENICE)).toBe(0);
      expect(milesToDriveMinutes(0)).toBe(0);
    });

    /**
     * The zero-cost case is for IDENTICAL coordinates only. Neighbouring
     * properties routinely sit a couple of hundred feet apart, and treating
     * that hop as free would let the scorer stack back-to-back slots with no
     * parking time — the overhead is exactly what those legs cost.
     */
    test('a nearby but distinct address still costs the per-leg overhead', () => {
      // ~200 ft north: two houses on the same street, not the same house.
      const neighbour = { lat: VENICE.lat + 0.000549, lng: VENICE.lng };
      const miles = require('../services/route-optimizer').haversine(
        VENICE.lat, VENICE.lng, neighbour.lat, neighbour.lng,
      );
      expect(miles).toBeGreaterThan(0.03);
      expect(miles).toBeLessThan(0.05);
      expect(driveMin(VENICE, neighbour)).toBeGreaterThanOrEqual(4);
    });

    test('missing or bad coords return 0', () => {
      expect(driveMin(null, SARASOTA)).toBe(0);
      expect(driveMin(VENICE, null)).toBe(0);
      expect(driveMin({ lat: null, lng: null }, SARASOTA)).toBe(0);
      expect(milesToDriveMinutes(NaN)).toBe(0);
      expect(milesToDriveMinutes(-5)).toBe(0);
    });

    test('longer legs never score shorter', () => {
      let prior = 0;
      for (const mi of [0.5, 1, 3, 8, 20, 50]) {
        const m = milesToDriveMinutes(mi);
        expect(m).toBeGreaterThanOrEqual(prior);
        prior = m;
      }
    });
  });

  /**
   * Auto-dispatch ranks a visit's CURRENT placement (scored via
   * auto-dispatch/geo) against CANDIDATE placements (scored inside
   * scheduling/find-time). Both must run the SAME estimator or the comparison
   * is between different scales and the driver can "improve" a route that did
   * not improve. These pin the single shared model — they fail if anyone
   * reintroduces a local copy of the constants in either module.
   */
  describe('one shared model across scheduling surfaces', () => {
    test('auto-dispatch geo uses route-optimizer\'s model, not a local copy', () => {
      expect(autoDispatchGeo.milesToDriveMinutes).toBe(routeOptimizer.milesToDriveMinutes);
      expect(autoDispatchGeo.haversine).toBe(routeOptimizer.haversine);
      expect(autoDispatchGeo.HQ).toBe(routeOptimizer.HQ);
    });

    // Each caller keeps a trivial coord→miles wrapper (so a suite can stub
    // haversine), but the miles→minutes MODEL must come from one place. These
    // pin that: the constants and the model function may not be re-declared.
    test.each([
      ['scheduling/find-time', '../services/scheduling/find-time'],
      ['auto-dispatch/geo', '../services/auto-dispatch/geo'],
    ])('%s declares no private drive-time model', (_label, mod) => {
      const src = require('fs').readFileSync(require.resolve(mod), 'utf8');
      expect(src).not.toMatch(/const\s+ROAD_FACTOR\s*=/);
      expect(src).not.toMatch(/const\s+AVG_MPH\s*=/);
      expect(src).not.toMatch(/function\s+milesToDriveMinutes/);
      // find-time imports route-optimizer's model through auto-dispatch/geo's
      // driveMin (the one coordinate-glue over that model) — either path is
      // the shared estimator; a private constant set is what this forbids.
      expect(src).toMatch(/require\('\.\.\/route-optimizer'\)|require\('\.\.\/auto-dispatch\/geo'\)/);
    });

    // Both consumers wrap the SAME model function (asserted by identity above),
    // so the production wrapper must agree with the model applied directly to
    // the same straight-line distance. Exercised through auto-dispatch's real
    // wrapper rather than a test-only one on the optimizer.
    test('the production wrapper applies exactly the shared model', () => {
      const miles = routeOptimizer.haversine(
        VENICE.lat, VENICE.lng, SARASOTA.lat, SARASOTA.lng,
      );
      expect(autoDispatchGeo.driveMin(VENICE, SARASOTA))
        .toBe(routeOptimizer.milesToDriveMinutes(miles));
    });
  });

  /**
   * The optimizer's own fallback (used whenever Google Routes is unavailable)
   * and its single-stop shortcut go through the shared model, so every
   * scheduling surface moves together.
   */
  describe('route-optimizer fallback paths use the shared model', () => {
    const stopsFor = () => ([
      { lat: 27.0998, lng: -82.4543, customerName: 'A' },
      { lat: 27.3364, lng: -82.5307, customerName: 'B' },
    ]);

    test('zero-length fallback legs cost nothing', () => {
      expect(routeOptimizer.fallbackLegMetrics(0)).toEqual({ meters: 0, minutes: 0 });
      expect(routeOptimizer.fallbackLegMetrics(NaN)).toEqual({ meters: 0, minutes: 0 });
    });

    test('nearest-neighbour legs take their minutes from the shared model', () => {
      const result = routeOptimizer.nearestNeighborOptimize(stopsFor());
      for (const leg of result.legs) {
        expect(leg.durationMinutes).toBe(routeOptimizer.milesToDriveMinutes(leg.distanceMeters / 1609.34 / 1.4));
      }
      expect(result.totalDurationSeconds).toBe(result.legs.reduce((sum, l) => sum + l.durationMinutes * 60, 0));
    });

    test('single-stop shortcut takes its minutes from the shared model', async () => {
      const stop = { lat: 27.0998, lng: -82.4543, customerName: 'Solo' };
      const r = await routeOptimizer.optimizeRoute([{ ...stop }]);
      const miles = routeOptimizer.haversine(routeOptimizer.HQ.lat, routeOptimizer.HQ.lng, stop.lat, stop.lng);
      expect(r.source).toBe('single_stop');
      expect(r.legs[0].durationMinutes).toBe(routeOptimizer.milesToDriveMinutes(miles));
      expect(r.totalDurationSeconds).toBe(r.legs[0].durationMinutes * 2 * 60);
      expect(r.legs[0].durationMinutes).toBe(r.legs[1].durationMinutes);
      expect(r.legs[0].distanceMeters).toBe(r.legs[1].distanceMeters);
      // Distance keeps the 1.4 road factor.
      expect(r.totalDistanceMeters).toBe(Math.round(miles * 1609.34 * 1.4) * 2);
    });
  });
});

// Drive clock (owner 2026-10-28, "add drive clock if its free"): the estimate
// uses the pair fitted on our own GPS.
describe('drive clock estimate legs', () => {
  const SETTINGS = ['DRIVE_CLOCK_FIXED_MINUTES', 'DRIVE_CLOCK_MINUTES_PER_MILE', 'DRIVE_CLOCK_PARK_MINUTES'];
  afterEach(() => {
    for (const name of SETTINGS) delete process.env[name];
  });

  test('7.9 + 2.2 per straight-line mile, same rounding', () => {
    expect(milesToDriveMinutes(10)).toBe(30); // 29.9
    expect(milesToDriveMinutes(5)).toBe(19); // 18.9
    expect(milesToDriveMinutes(0.5)).toBe(9); // 9.0
  });

  test('a same-place or missing leg stays 0', () => {
    expect(milesToDriveMinutes(0)).toBe(0);
    expect(milesToDriveMinutes(1e-7)).toBe(0);
    expect(milesToDriveMinutes(NaN)).toBe(0);
  });

  test('settings are read at call time', () => {
    process.env.DRIVE_CLOCK_FIXED_MINUTES = '10';
    process.env.DRIVE_CLOCK_MINUTES_PER_MILE = '3';
    expect(milesToDriveMinutes(10)).toBe(40);
    delete process.env.DRIVE_CLOCK_FIXED_MINUTES;
    expect(milesToDriveMinutes(10)).toBe(38); // fixed back to 7.9, rate 3
  });

  test.each([
    ['DRIVE_CLOCK_FIXED_MINUTES', ['abc', '', ' ', '-1', '31', 'Infinity', 'NaN']],
    ['DRIVE_CLOCK_MINUTES_PER_MILE', ['abc', '', '0.4', '6.1', '-2', 'Infinity']],
  ])('%s outside its bounds or not a number uses the default', (name, values) => {
    for (const value of values) {
      process.env[name] = value;
      expect(milesToDriveMinutes(10)).toBe(30);
    }
  });

  test('the bounds themselves are allowed', () => {
    process.env.DRIVE_CLOCK_FIXED_MINUTES = '0';
    process.env.DRIVE_CLOCK_MINUTES_PER_MILE = '0.5';
    expect(milesToDriveMinutes(10)).toBe(5);
    process.env.DRIVE_CLOCK_FIXED_MINUTES = '30';
    process.env.DRIVE_CLOCK_MINUTES_PER_MILE = '6';
    expect(milesToDriveMinutes(10)).toBe(90);
  });

  // The label, the estimate and Google's park minutes agree.
  test('label drive_clock, park minutes added, fitted estimate', () => {
    const { driveModelLabel, parkedMinutes } = require('../services/scheduling/drive-clock');
    expect(driveModelLabel()).toBe('drive_clock');
    expect(parkedMinutes(10)).toBe(14);
    expect(parkedMinutes(0)).toBe(0);
    expect(milesToDriveMinutes(10)).toBe(30);
  });
});
