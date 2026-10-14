// GATE_LAWN_V13 has no bahia program. Two read-only surfaces stop counting it: the public recurring
// lawn price range (no bahia sweep) and the estimate AI context's protocol-product linkage (no
// staged bahia rows). Gate off, both read exactly as before.
const sp = require('../services/pricing-engine/service-pricing');
const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
const { loadProtocolProductFamilies } = require('../services/estimate-ai-context');
const { LAWN_V13_VERSION } = require('../services/lawn-program');

afterEach(() => { delete process.env.GATE_LAWN_V13; jest.restoreAllMocks(); });

describe('public recurring lawn range', () => {
  const recurringTracks = () => {
    const spy = jest.spyOn(sp, 'priceLawnCare');
    computePublicPricingRanges({ refresh: true });
    return new Set(spy.mock.calls.map(([, options]) => options.track));
  };

  test('gate off: bahia is swept with the other tracks', () => {
    expect([...recurringTracks()].sort()).toEqual(['bahia', 'bermuda', 'st_augustine', 'zoysia']);
  });

  test('gate on: bahia is not swept; the other tracks are', () => {
    process.env.GATE_LAWN_V13 = 'true';
    expect([...recurringTracks()].sort()).toEqual(['bermuda', 'st_augustine', 'zoysia']);
  });

  test('flipping the gate invalidates the cached range', () => {
    const off = computePublicPricingRanges();
    process.env.GATE_LAWN_V13 = 'true';
    const spy = jest.spyOn(sp, 'priceLawnCare');
    computePublicPricingRanges();
    expect(spy).toHaveBeenCalled();
    expect(off).toBeDefined();
  });
});

describe('estimate AI context protocol-product linkage', () => {
  function recordingDb(rows) {
    const calls = [];
    const db = (table) => {
      const query = {
        select(...args) { calls.push([table, 'select', ...args]); return query; },
        join(...args) { calls.push([table, 'join', ...args]); return query; },
        where(arg) { calls.push([table, 'where', arg]); return query; },
        whereNotIn(column, sub) { calls.push([table, 'whereNotIn', column, sub?.__table]); return query; },
        whereRaw(sql) { calls.push([table, 'whereRaw', sql]); return query; },
        limit() { return Promise.resolve(rows); },
      };
      query.__table = table;
      return query;
    };
    return { db, calls };
  }

  test('gate off: the old unfiltered read', async () => {
    const { db, calls } = recordingDb([{ product_name: 'SpeedZone Southern + NIS' }]);
    const out = await loadProtocolProductFamilies(db);
    expect(out['speedzone southern']).toEqual(['lawn_care']);
    expect(calls.some((c) => c[1] === 'whereNotIn')).toBe(false);
  });

  test('gate on: the staged v13 bahia rows are excluded by a subquery on the protocol', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const { db, calls } = recordingDb([{ product_name: 'Celsius WG' }]);
    const out = await loadProtocolProductFamilies(db);
    expect(out['celsius wg']).toEqual(['lawn_care']);
    expect(calls).toContainEqual(['lawn_protocol_products', 'whereNotIn', 'lawn_protocol_window_id', 'lawn_protocol_windows as lpw']);
    expect(calls).toContainEqual(['lawn_protocol_windows as lpw', 'where', { 'lp.grass_track': 'bahia', 'lp.version': LAWN_V13_VERSION }]);
  });
});
