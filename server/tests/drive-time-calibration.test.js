/**
 * Auto-dispatch drive-time estimator — legacy vs calibrated model.
 *
 * The calibrated model (fixed per-leg overhead + per-mile rate) was fitted
 * against real Bouncie GPS trips and rides GATE_DRIVE_TIME_CALIBRATION. Pins:
 *  - gate off → the legacy haversine × 1.4 @ 30 mph arithmetic is byte-for-byte
 *    what it was, so flipping the gate back is a true revert;
 *  - gate on  → the fitted two-term model applies;
 *  - the gate is read at CALL time, so a flip needs no redeploy and no module
 *    reload (the whole point of using gateEnvValue over the baked gates map);
 *  - co-located points cost nothing under either model — the fixed overhead
 *    must not be charged for a leg that isn't a drive;
 *  - missing/garbage coordinates still return 0 rather than NaN.
 */
const { driveMin, milesToDriveMinutes } = require('../services/auto-dispatch/geo');
const routeOptimizer = require('../services/route-optimizer');
const autoDispatchGeo = require('../services/auto-dispatch/geo');

const GATE = 'GATE_DRIVE_TIME_CALIBRATION';
const ORIGINAL = process.env[GATE];

// Two real SW Florida points ~17 straight-line miles apart (Venice → Sarasota).
const VENICE = { lat: 27.0998, lng: -82.4543 };
const SARASOTA = { lat: 27.3364, lng: -82.5307 };

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[GATE];
  else process.env[GATE] = ORIGINAL;
});

describe('drive-time estimator', () => {
  describe('gate OFF (legacy)', () => {
    beforeEach(() => { delete process.env[GATE]; });

    test('applies haversine x1.4 @ 30mph exactly', () => {
      // 10 straight-line miles -> 10 * 1.4 / 30 * 60 = 28 min
      expect(milesToDriveMinutes(10)).toBe(28);
      expect(milesToDriveMinutes(5)).toBe(14);
    });

    test('charges no fixed overhead for a short leg', () => {
      // 0.5 mi -> 1.4 min -> rounds to 1, NOT the calibrated fixed term
      expect(milesToDriveMinutes(0.5)).toBe(1);
    });

    test('scores a real leg with the legacy constants', () => {
      expect(driveMin(VENICE, SARASOTA)).toBe(48);
    });
  });

  describe('gate ON (calibrated)', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });

    test('applies fixed overhead + per-mile rate', () => {
      // 10 mi -> 4.25 + 23.5 = 27.75 -> 28
      expect(milesToDriveMinutes(10)).toBe(28);
      // 5 mi -> 4.25 + 11.75 = 16 ; legacy would say 14
      expect(milesToDriveMinutes(5)).toBe(16);
    });

    test('charges the per-leg overhead on a short but real drive', () => {
      // 0.5 mi -> 4.25 + 1.175 = 5.425 -> 5. A stop is never free.
      expect(milesToDriveMinutes(0.5)).toBe(5);
    });

    test('scores a real leg lower than legacy (legacy over-estimates long legs)', () => {
      const calibrated = driveMin(VENICE, SARASOTA);
      expect(calibrated).toBe(44);
      delete process.env[GATE];
      expect(calibrated).toBeLessThan(driveMin(VENICE, SARASOTA));
    });

    test('makes inserting an en-route stop cost real time, where legacy made it free', () => {
      // detour = d(prev,new) + d(new,next) - d(prev,next) for a stop sitting
      // essentially on the line between its neighbours. Under legacy the terms
      // are purely proportional to distance, so a collinear stop nets ~0 — the
      // scorer treats it as free. Under the calibrated model the fixed overhead
      // survives the subtraction. Asserted as a comparison rather than an exact
      // figure because each leg rounds to whole minutes independently, which
      // can shave a minute off the difference.
      const prev = { lat: 27.1000, lng: -82.4500 };
      const mid = { lat: 27.2000, lng: -82.4900 };
      const next = { lat: 27.3000, lng: -82.5300 };
      const detourOf = () => driveMin(prev, mid) + driveMin(mid, next) - driveMin(prev, next);

      const calibrated = detourOf();
      delete process.env[GATE];
      const legacy = detourOf();

      expect(legacy).toBeLessThanOrEqual(1);
      expect(calibrated).toBeGreaterThanOrEqual(3);
      expect(calibrated).toBeGreaterThan(legacy);
    });
  });

  describe('invariants under both models', () => {
    test.each([['off', undefined], ['on', 'true']])('co-located points cost 0 (gate %s)', (_label, val) => {
      if (val === undefined) delete process.env[GATE]; else process.env[GATE] = val;
      expect(driveMin(VENICE, VENICE)).toBe(0);
      expect(milesToDriveMinutes(0)).toBe(0);
    });

    test.each([['off', undefined], ['on', 'true']])('missing or bad coords return 0 (gate %s)', (_label, val) => {
      if (val === undefined) delete process.env[GATE]; else process.env[GATE] = val;
      expect(driveMin(null, SARASOTA)).toBe(0);
      expect(driveMin(VENICE, null)).toBe(0);
      expect(driveMin({ lat: null, lng: null }, SARASOTA)).toBe(0);
      expect(milesToDriveMinutes(NaN)).toBe(0);
      expect(milesToDriveMinutes(-5)).toBe(0);
    });

    test.each([['off', undefined], ['on', 'true']])('longer legs never score shorter (gate %s)', (_label, val) => {
      if (val === undefined) delete process.env[GATE]; else process.env[GATE] = val;
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
      expect(src).toMatch(/milesToDriveMinutes.*require\('\.\.\/route-optimizer'\)|require\('\.\.\/route-optimizer'\)/);
    });

    test.each([['off', undefined], ['on', 'true']])(
      'both surfaces produce identical minutes for the same leg (gate %s)', (_label, val) => {
        if (val === undefined) delete process.env[GATE]; else process.env[GATE] = val;
        expect(routeOptimizer.driveMin(VENICE, SARASOTA))
          .toBe(autoDispatchGeo.driveMin(VENICE, SARASOTA));
      },
    );
  });

  /**
   * The optimizer's own fallback (used whenever Google Routes is unavailable)
   * and its single-stop shortcut used to derive minutes from a hardcoded
   * 30 mph. They now go through the shared model, so a gate flip moves every
   * scheduling surface together rather than leaving admin route metrics behind.
   */
  describe('route-optimizer fallback paths use the shared model', () => {
    const stopsFor = () => ([
      { lat: 27.0998, lng: -82.4543, customerName: 'A' },
      { lat: 27.3364, lng: -82.5307, customerName: 'B' },
    ]);

    test('nearest-neighbour legs move with the gate', async () => {
      delete process.env[GATE];
      const legacy = routeOptimizer.nearestNeighborOptimize(stopsFor());
      process.env[GATE] = 'true';
      const calibrated = routeOptimizer.nearestNeighborOptimize(stopsFor());

      expect(legacy.totalDurationSeconds).toBeGreaterThan(0);
      expect(calibrated.totalDurationSeconds).not.toBe(legacy.totalDurationSeconds);
      // Distance is deliberately NOT gated — this gate covers time only.
      expect(calibrated.totalDistanceMeters).toBe(legacy.totalDistanceMeters);
    });

    test('single-stop shortcut moves with the gate and stays internally consistent', async () => {
      const one = () => ([{ lat: 27.0998, lng: -82.4543, customerName: 'Solo' }]);
      delete process.env[GATE];
      const legacy = await routeOptimizer.optimizeRoute(one());
      process.env[GATE] = 'true';
      const calibrated = await routeOptimizer.optimizeRoute(one());

      expect(legacy.source).toBe('single_stop');
      expect(calibrated.totalDurationSeconds).not.toBe(legacy.totalDurationSeconds);
      for (const r of [legacy, calibrated]) {
        // Out and back are the same leg, and the legs must sum to the total.
        expect(r.legs[0].durationMinutes).toBe(r.legs[1].durationMinutes);
        expect(r.legs[0].distanceMeters).toBe(r.legs[1].distanceMeters);
        expect(r.totalDistanceMeters).toBe(r.legs[0].distanceMeters * 2);
        expect(r.totalDurationSeconds).toBe(r.legs[0].durationMinutes * 2 * 60);
      }
    });
  });

  test('gate is honoured at call time, with no module reload', () => {
    delete process.env[GATE];
    const legacy = milesToDriveMinutes(5);
    process.env[GATE] = 'true';
    const calibrated = milesToDriveMinutes(5);
    process.env[GATE] = 'false';
    const reverted = milesToDriveMinutes(5);
    expect(calibrated).not.toBe(legacy);
    expect(reverted).toBe(legacy);
  });
});
